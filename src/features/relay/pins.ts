import type { ChannelMessage } from "./contracts";
import { newer, type EventData, type ReadFilter } from "./events";
import { foldMessages } from "./fold";
import type { LiveListener } from "./incoming";
import { OLD_EVENT_NOT_FOUND, type OutgoingEvent } from "./outbox";
import type { ReadOptions } from "./reader";
import { READ_STATE_TIMESTAMP_REFUSAL } from "./read-state-host";

/** Member-signed commands; the relay applies them and re-signs the list. */
export const PIN_KIND = 40010;
export const UNPIN_KIND = 40011;
/** The relay's refusal as the outbox stores it: the transport drops the
 * NIP-01 prefix and capitalizes the rest for display. */
const TOO_OLD = READ_STATE_TIMESTAMP_REFUSAL.replace(/^invalid:\s*/, "");
/** NIP-PM: a relay that does not take the commands refuses them as
 * `restricted: unknown event kind`. */
const UNSUPPORTED = "unknown event kind";
export const EXPIRED_PIN_RECOVERY =
  "Refused as too old, so it was not sent again. Pin or unpin from the message menu if the pins still need it.";
export const UNSUPPORTED_PIN_RECOVERY =
  "This community does not take pins, so it was not sent again.";
/** What to show in place of Retry for a pin command that resending cannot
 * help, else undefined. One refused as too old, by the relay or by the desktop
 * host before resending it, has an unknown outcome and is refused again, so
 * NIP-PM has the client read the list and leave any new command to the
 * person, since one signed by itself could undo another member's change. */
export function refusedPinCommand(
  item: Pick<OutgoingEvent, "event" | "error">,
): string | undefined {
  if (item.event.kind !== PIN_KIND && item.event.kind !== UNPIN_KIND)
    return undefined;
  const error = item.error?.toLowerCase() ?? "";
  if (
    error.includes(TOO_OLD) ||
    error.includes(OLD_EVENT_NOT_FOUND.toLowerCase())
  )
    return EXPIRED_PIN_RECOVERY;
  if (error.includes(UNSUPPORTED)) return UNSUPPORTED_PIN_RECOVERY;
  return undefined;
}
/** The relay-signed pin list for one channel (`d`), newest pin first. */
export const PIN_LIST_KIND = 30623;

const HEX_ID = /^[0-9a-f]{64}$/;

/** The message ids a relay-signed list names for `channelId`, in display
 * order; undefined for any other event. */
export function pinnedIds(
  event: Pick<EventData, "kind" | "pubkey" | "tags">,
  relayAuthor: string | undefined,
  channelId: string,
): readonly string[] | undefined {
  if (
    event.kind !== PIN_LIST_KIND ||
    !relayAuthor ||
    event.pubkey !== relayAuthor ||
    event.tags.find(([name]) => name === "d")?.[1] !== channelId
  )
    return undefined;
  return [
    ...new Set(
      event.tags.flatMap(([name, id]) =>
        name === "e" && id && HEX_ID.test(id) ? [id] : [],
      ),
    ),
  ];
}

/** What the pin list needs from a session; `RelaySession` satisfies it. */
export type PinSource = Readonly<{
  relayAuthor?: string | undefined;
  /** The relay's explicit NIP-11 `self`: who signs pin lists and may sign
   * messages for others (an `actor` tag); see `foldMessages`. */
  workflowAuthority?: string | undefined;
  profiles?: Readonly<{
    owner?: ((pubkey: string) => string | undefined) | undefined;
    /** Hears profile changes, an agent's owner among them. */
    subscribe?: ((listener: () => void) => () => void) | undefined;
  }>;
  read(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
  ): Promise<readonly EventData[]>;
  /** `relayCount` counts the relay's page before visibility filtering. */
  readPage(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
  ): Promise<{ events: readonly EventData[]; relayCount: number }>;
  subscribeLive(
    listener: LiveListener,
    options?: { replay?: boolean },
  ): () => void;
  live: Readonly<{
    /** A channel whose route re-establishes reads its head again (pending). */
    snapshot(): Readonly<{
      heads: readonly Readonly<{ channelId?: string; state: string }>[];
    }>;
    subscribe(listener: () => void): () => void;
  }>;
}>;

export type PinSnapshot = Readonly<{
  status: "loading" | "ready" | "error";
  ids: readonly string[];
  set: ReadonlySet<string>;
}>;

export const LOADING_PINS: PinSnapshot = Object.freeze({
  status: "loading",
  ids: Object.freeze([]),
  set: new Set<string>(),
});

type Entry = {
  event?: EventData;
  snapshot: PinSnapshot;
  listeners: Set<() => void>;
  reading?: Promise<void> | undefined;
  /** Asked for during `reading`, which may predate the request: read once
   * more after it. */
  again?: boolean;
};

const READ_CHUNK = 100;
const OVERLAY_LIMIT = 500;
/** Overlay pages read per chunk of pins. Past it, older edits and deletions
 * are not applied: an accepted bound against a flood of overlays. */
const OVERLAY_PAGES = 20;

const stores = new WeakMap<PinSource, ReturnType<typeof createPinLists>>();

/** One list per channel the UI asked about: read once, then kept current by
 * the channel's live subscription and its replay. When channels catch up
 * after their routes re-establish, their watched lists are read again in one
 * read, since a cut replay may not carry a change. A read asked for while one
 * runs follows it, so it reflects state after the request. A failed read stays failed
 * until `retry` or the next catch-up. */
function createPinLists(source: PinSource) {
  const entries = new Map<string, Entry>();
  let listening = false;
  const publish = (entry: Entry, patch: Partial<PinSnapshot>) => {
    entry.snapshot = Object.freeze({ ...entry.snapshot, ...patch });
    for (const listener of [...entry.listeners]) listener();
  };
  function accept(events: readonly EventData[]) {
    for (const event of events) {
      if (event.kind !== PIN_LIST_KIND) continue;
      const channelId = event.tags.find(([name]) => name === "d")?.[1];
      const entry = channelId ? entries.get(channelId) : undefined;
      const ids =
        entry &&
        channelId &&
        pinnedIds(event, source.workflowAuthority, channelId);
      if (!entry || !ids || newer(entry.event, event) !== event) continue;
      entry.event = event;
      publish(entry, { status: "ready", ids, set: new Set(ids) });
    }
  }
  function read(channelIds: readonly string[]) {
    // NIP-PM: lists are signed by the relay's explicit NIP-11 `self`, never
    // the contact key some hosts fall back to for `relayAuthor`.
    const relayAuthor = source.workflowAuthority;
    const wanted = channelIds.flatMap((id) => {
      const entry = entries.get(id);
      if (entry?.reading) entry.again = true;
      return entry && !entry.reading ? [[id, entry] as const] : [];
    });
    if (!wanted.length) return;
    // Without it no list can be verified: show none.
    if (!relayAuthor) {
      for (const [, entry] of wanted) publish(entry, { status: "ready" });
      return;
    }
    const reading = source
      .read(
        [
          {
            kinds: [PIN_LIST_KIND],
            authors: [relayAuthor],
            // NIP-CL names the channel by `h`; `#d` misses unlisted ones.
            "#h": wanted.map(([id]) => id),
            limit: wanted.length,
            // A repair read must not be served state older than the gap.
            consistency: "strong",
          },
        ],
        { priority: "background" },
      )
      .then(
        (events) => {
          accept(events);
          // No list yet is an empty list.
          for (const [, entry] of wanted)
            if (entry.snapshot.status !== "ready")
              publish(entry, { status: "ready" });
        },
        () => {
          // A list already shown, or one heard live meanwhile, still stands.
          for (const [, entry] of wanted)
            if (entry.snapshot.status !== "ready")
              publish(entry, { status: "error" });
        },
      )
      .finally(() => {
        const again: string[] = [];
        for (const [id, entry] of wanted) {
          if (entry.reading !== reading) continue;
          entry.reading = undefined;
          if (entry.again) again.push(id);
          entry.again = false;
        }
        if (again.length) read(again);
      });
    for (const [, entry] of wanted) entry.reading = reading;
    for (const [, entry] of wanted)
      if (entry.snapshot.status === "error")
        publish(entry, { status: "loading" });
  }
  function listen() {
    if (listening) return;
    listening = true;
    // Kept for the session: lists stay current once asked for. Replay
    // listeners hear live batches too.
    source.subscribeLive(({ events }) => accept(events), { replay: true });
    const catchingUp = () =>
      new Set(
        source.live
          .snapshot()
          .heads.flatMap((head) =>
            head.state === "pending" && head.channelId ? [head.channelId] : [],
          ),
      );
    let pending = catchingUp();
    source.live.subscribe(() => {
      const now = catchingUp();
      const stale: string[] = [];
      for (const id of now) {
        const entry = entries.get(id);
        if (pending.has(id) || !entry) continue;
        // An unwatched list is read again when next asked for.
        if (entry.listeners.size) stale.push(id);
        else entries.delete(id);
      }
      pending = now;
      for (let index = 0; index < stale.length; index += READ_CHUNK)
        read(stale.slice(index, index + READ_CHUNK));
    });
  }
  return {
    snapshot: (channelId: string) =>
      entries.get(channelId)?.snapshot ?? LOADING_PINS,
    subscribe(channelId: string, listener: () => void) {
      listen();
      let entry = entries.get(channelId);
      if (!entry) {
        entry = { snapshot: LOADING_PINS, listeners: new Set() };
        entries.set(channelId, entry);
        read([channelId]);
      } else if (entry.snapshot.status === "error" && !entry.listeners.size)
        // A revisit tries a failed list once more.
        read([channelId]);
      entry.listeners.add(listener);
      const owned = entry;
      return () => {
        owned.listeners.delete(listener);
      };
    },
    /** Reads a list again, as after a failed read or a refused command. */
    retry: (channelId: string) => read([channelId]),
  };
}

export function pinLists(source: PinSource) {
  let store = stores.get(source);
  if (!store) {
    store = createPinLists(source);
    stores.set(source, store);
  }
  return store;
}

/** Pinned messages by id, with their edits and deletions applied as the
 * timeline applies them. Reads are strong, since a reload may follow an
 * observed list change, edit or deletion and must not be served older state. An id the relay no longer returns is absent from
 * `rows`: deleted or erased. `edits` maps each edit read to the pins it names,
 * so a later deletion of one reloads only those. A failed read rejects;
 * callers must not treat it as a deletion. */
export async function readPinnedMessages(
  source: PinSource,
  channelId: string,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<{
  rows: ReadonlyMap<string, ChannelMessage>;
  edits: ReadonlyMap<string, readonly string[]>;
}> {
  const settings = { signal, priority: "background" } as const;
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += READ_CHUNK)
    chunks.push(ids.slice(index, index + READ_CHUNK));
  const events = (
    await Promise.all(
      chunks.map(async (chunk) => {
        const read = [
          ...(await source.read(
            [
              {
                kinds: [9, 40002, 40008],
                ids: chunk,
                "#h": [channelId],
                limit: chunk.length,
                consistency: "strong",
              },
            ],
            settings,
          )),
        ];
        // Newest first, every page over every pin: a reference settles
        // nothing until folding checks who may change that message. The
        // relay's keyset cursor (until, then ids after before_id at a tie)
        // advances even through one second holding a full page.
        let cursor: { until: number; before_id: string } | undefined;
        for (let pages = 0; pages < OVERLAY_PAGES; pages++) {
          const page = await source.readPage(
            [
              {
                kinds: [5, 9005, 40003],
                "#e": chunk,
                "#h": [channelId],
                limit: OVERLAY_LIMIT,
                consistency: "strong",
                ...cursor,
              },
            ],
            settings,
          );
          read.push(...page.events);
          // Fullness is the relay's count: visibility may drop some events.
          // A full page with none visible gives no cursor and ends paging.
          const last = [...page.events].sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )[page.events.length - 1];
          if (page.relayCount < OVERLAY_LIMIT || !last) break;
          cursor = { until: last.created_at, before_id: last.id };
        }
        return read;
      }),
    )
  ).flat();
  const wanted = new Set(ids);
  const edits = new Map<string, string[]>();
  for (const event of events)
    if (event.kind === 40003)
      edits.set(
        event.id,
        event.tags.flatMap(([name, id]) =>
          name === "e" && id && wanted.has(id) ? [id] : [],
        ),
      );
  const rows = new Map(
    foldMessages(channelId, source.relayAuthor ?? "", events, {
      includeReplies: true,
      signingAuthority: source.workflowAuthority,
      agentOwner: source.profiles?.owner,
    })
      .filter((row) => wanted.has(row.id))
      .map((row) => [row.id, row]),
  );
  return { rows, edits };
}
