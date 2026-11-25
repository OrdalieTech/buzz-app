import { searchText } from "../../app/shell/useSearchMessages";
import type { ChannelSummary } from "../../features/relay/contracts";
import type {
  EventData,
  ReadFilter,
  RelayEvent,
} from "../../features/relay/events";
import { deletionApplies } from "../../features/relay/fold";
import type { RelaySession } from "../../features/relay/session";
import { threadReference } from "../../features/relay/thread-reference";
import type { FinderCorpus, FinderDoc } from "./corpus.ts";

const KINDS = [9, 40002];
const DAYS = 90;
const PAGE = 500;
/** Least time between history reads, so a first fill or a reconnect never
 * floods the relay. */
const PACE_MS = 300;
const BACKOFF_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
/** After the first fill, the newest page of each channel you visit and
 * search most: at most 16 background reads per session. Many channels one
 * page deep find more than a few channels read deeper, since most searches
 * are for recent messages (scripts/perf/finder/readahead-bench.ts). */
const WARM_CHANNELS = 16;
const WARM_PAGES = 1;
/** How far before the last fill a resumed one reads again, for clock skew
 * between this device and the relay. */
const RESUME_SLACK_S = 300;

export type FinderSyncStatus = Readonly<{
  phase: "waiting" | "filling" | "ready" | "error";
  indexed: number;
  error?: string | undefined;
}>;

export type ChannelSearchStatus = Readonly<{
  oldest?: number | undefined;
  complete: boolean;
  capped: boolean;
  loading: boolean;
  error: boolean;
  available: boolean;
}>;

type ChannelCursor = { until: number; before_id: string };
type ChannelProgress = {
  /** When the read of the channel's newest page started. */
  top?: number;
  cursor?: ChannelCursor;
  complete: boolean;
  opening?: object;
  pages: number;
  budget: number;
  /** The page read under way; the next waits for it, so readers share one
   * cursor without skipping or repeating a page. */
  reading?: Promise<unknown>;
};

type FillProgress = {
  /** When the last read of this filter that reached the present started. */
  top?: number;
  /** The oldest page read so far, until the horizon is reached. */
  cursor?: ChannelCursor;
  complete: boolean;
  /** The channels its filter names, so lost access can reset it. */
  channelIds?: readonly string[];
};

/** What the index knows, kept across reconnects of one account in one
 * community, so a new session resumes from its cursors instead of reading
 * 90 days again. Another account or community starts a new one. */
export function createFinderState() {
  return {
    docs: new Map<string, FinderDoc>(),
    /** The indexed events without their text, to judge later deletions. */
    signed: new Map<string, EventData>(),
    /** Deletions seen, by the ID they name. */
    tombstones: new Map<string, EventData[]>(),
    cursors: new Map<string, ChannelProgress>(),
    fills: new Map<string, FillProgress>(),
    /** Threads the viewer took part in, by root id. */
    roots: new Set<string>(),
    /** Channels whose messages left with lost access; the first fill after
     * rejoining reads their history again. */
    revoked: new Set<string>(),
  };
}
export type FinderState = ReturnType<typeof createFinderState>;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

const chunks = <T>(items: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, n) =>
    items.slice(n * size, n * size + size),
  );

/** Where a message was said, as Finder names it. */
function placeOf(session: RelaySession, channelId: string) {
  const found = session.channels.get?.(channelId);
  if (!found) return "Conversation";
  if (found.channelType === "dm") return found.name || "Direct message";
  return found.channelType === "stream" || found.channelType === "forum"
    ? `#${found.name}`
    : found.name || "Conversation";
}
const nameOf = (session: RelaySession, pubkey: string) =>
  session.profiles.snapshot().get(pubkey)?.name ?? pubkey.slice(0, 10);

/** A message, from the relay or its search, as Finder indexes it: named
 * by who wrote it and where, for `session`'s viewer. */
export const finderDoc = (
  session: RelaySession,
  message: Omit<FinderDoc, "author" | "place">,
): FinderDoc => ({
  ...message,
  author:
    message.authorId === session.viewer
      ? "You"
      : nameOf(session, message.authorId),
  place: placeOf(session, message.channelId),
});

/** Fills `corpus` with the viewer's own conversations from the last 90
 * days, then keeps it current from what the session already receives. */
export function startFinderSync({
  session,
  corpus,
  changed,
  warm = () => [],
  state = createFinderState(),
}: {
  session: RelaySession;
  corpus: FinderCorpus;
  /** Carried over from this account's previous session in this community. */
  state?: FinderState;
  /** The corpus or the status changed. */
  changed: () => void;
  /** Channel ids worth reading ahead, most wanted first. */
  warm?: () => readonly string[];
}) {
  // A session always has its viewer; the type allows none before sign-in.
  const viewer = session.viewer ?? "";
  const controller = new AbortController();
  const { signal } = controller;
  const since = Math.floor(Date.now() / 1000) - DAYS * 86_400;
  const { docs, signed, tombstones, cursors, fills, roots, revoked } = state;
  /** Channels whose newest page an earlier session read: the read-ahead
   * catches them up from there. */
  const resumable = new Set(
    [...cursors].flatMap(([id, progress]) =>
      progress.top === undefined ? [] : [id],
    ),
  );
  const progressOf = (channelId: string) => {
    let progress = cursors.get(channelId);
    if (!progress) {
      progress = { complete: false, pages: 0, budget: 10 };
      cursors.set(channelId, progress);
    }
    return progress;
  };
  let status: FinderSyncStatus = { phase: "waiting", indexed: 0 };
  const publish = (patch: Partial<FinderSyncStatus>) => {
    status = { ...status, ...patch, indexed: corpus.size };
    changed();
  };

  const channel = (id: string): ChannelSummary | undefined =>
    session.channels.get?.(id);
  const docOf = (event: RelayEvent): FinderDoc => {
    const channelId = event.tags.find(([name]) => name === "h")?.[1] ?? "";
    return finderDoc(session, {
      id: event.id,
      channelId,
      threadRootId: threadReference(event)?.rootId,
      authorId: event.pubkey,
      createdAt: event.created_at,
      text: searchText(event).replace(/\s+/g, " ").trim(),
    });
  };

  /** Anything the app receives from a conversation you belong to: live
   * traffic and what you scroll past, at no extra relay cost. Previews of
   * channels you haven't joined and huddle rooms stay out. */
  const relevant = (channelId: string) => {
    const found = channel(channelId);
    return (
      !!found &&
      !found.huddle &&
      !found.cached &&
      (!found.readOnly || found.viewerRole === "guest")
    );
  };
  /** A deletion seen for `event` removes it, now or when it arrives later. */
  const deleted = (event: EventData) =>
    !!tombstones
      .get(event.id)
      ?.some((deletion) =>
        deletionApplies(deletion, event, session.relayAuthor),
      );
  const remember = (
    added: readonly FinderDoc[],
    events: ReadonlyMap<string, EventData> = new Map(),
  ) => {
    if (signal.aborted || !added.length) return;
    // Relay hits carry no event; judge them as their author's message.
    const eventOf = (doc: FinderDoc): EventData => {
      const event = events.get(doc.id);
      return {
        id: doc.id,
        kind: event?.kind ?? 9,
        pubkey: event?.pubkey ?? doc.authorId,
        created_at: doc.createdAt,
        content: "",
        tags: event?.tags ?? [],
      };
    };
    // The search hook has no thread root. Keep fuller observed documents.
    const joined = added.filter(
      (doc) =>
        relevant(doc.channelId) && !docs.has(doc.id) && !deleted(eventOf(doc)),
    );
    if (!joined.length) return;
    for (const doc of joined) {
      docs.set(doc.id, doc);
      signed.set(doc.id, eventOf(doc));
    }
    corpus.add(joined);
    void session.profiles
      .ensure([...new Set(joined.map((doc) => doc.authorId))], "background")
      .catch(() => {});
    publish({});
  };
  const take = (events: readonly RelayEvent[], older = false) => {
    const added: FinderDoc[] = [];
    const byId = new Map<string, EventData>();
    for (const event of events) {
      if (!KINDS.includes(event.kind) || (!older && event.created_at < since))
        continue;
      if (docs.has(event.id) || deleted(event)) continue;
      const doc = docOf(event);
      if (event.pubkey === viewer && doc.threadRootId)
        roots.add(doc.threadRootId);
      added.push(doc);
      byId.set(event.id, event);
    }
    remember(added, byId);
  };

  /** The next older page of one channel, into the index. */
  const readOlder = (
    channelId: string,
    progress: ChannelProgress,
    bound: AbortSignal,
  ) => {
    const read = (progress.reading ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (progress.complete) return;
        const top = progress.cursor ? undefined : Math.floor(Date.now() / 1000);
        const page = await session.readRemote(
          [
            {
              kinds: KINDS,
              "#h": [channelId],
              limit: PAGE,
              ...progress.cursor,
            },
          ],
          { signal: bound, priority: "background" },
        );
        bound.throwIfAborted();
        // Resolve ties in the relay's newest-first ID order.
        const oldest = [...page].sort(
          (a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id),
        )[0];
        if (oldest)
          progress.cursor = { until: oldest.created_at, before_id: oldest.id };
        progress.complete = page.length < PAGE;
        if (top !== undefined) progress.top = top;
        take(page, true);
      });
    progress.reading = read;
    return read;
  };

  /** One opening owns its budget and cancellation; only cursors outlive it.
   * Query edits wake the same reader instead of resetting its cursor or cap. */
  const searchChannel = (
    channelId: string,
    needsMore: () => boolean,
    report: (status: ChannelSearchStatus) => void,
    opening: object = {},
  ) => {
    const progress = progressOf(channelId);
    if (progress.opening !== opening) {
      progress.opening = opening;
      progress.pages = 0;
      progress.budget = 10;
    }
    const lifetime = new AbortController();
    const bound = AbortSignal.any([signal, lifetime.signal]);
    let running = false;
    let error = false;
    let delay = Math.random() * PACE_MS;
    const snapshot = (): ChannelSearchStatus => ({
      oldest: progress.cursor?.until,
      complete: progress.complete,
      capped: progress.pages >= progress.budget,
      loading: running,
      error,
      available: relevant(channelId),
    });
    const notify = () => {
      if (!bound.aborted) report(snapshot());
    };
    const wake = () => {
      if (running || bound.aborted) return;
      const needed = () =>
        relevant(channelId) &&
        !progress.complete &&
        progress.pages < progress.budget &&
        needsMore();
      if (!needed()) return notify();
      running = true;
      notify();
      void (async () => {
        let backoff = BACKOFF_MS;
        while (!bound.aborted && needed()) {
          await sleep(delay, bound);
          if (!needed()) break;
          try {
            await readOlder(channelId, progress, bound);
          } catch (failure) {
            if (bound.aborted) throw failure;
            error = true;
            notify();
            delay = backoff + Math.random() * 1000;
            backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
            continue;
          }
          error = false;
          backoff = BACKOFF_MS;
          delay = PACE_MS;
          progress.pages++;
          notify();
        }
      })()
        .catch(() => {
          // Cancellation retires this opening, including a pending backoff.
        })
        .finally(() => {
          running = false;
          notify();
        });
    };
    wake();
    return {
      wake,
      keepGoing() {
        progress.budget += 10;
        wake();
      },
      dispose() {
        lifetime.abort();
      },
    };
  };

  /** When the last history read finished; every read waits `PACE_MS` after
   * it, across filters as well as pages. */
  let lastRead = -Infinity;
  /** Pages of `filter` newest first, from `cursor` back to `from`. */
  async function readPages(
    filter: Omit<ReadFilter, "limit">,
    from: number,
    cursor?: ChannelCursor,
    reached: (cursor: ChannelCursor) => void = () => {},
  ) {
    let delay = BACKOFF_MS;
    for (;;) {
      let page: readonly RelayEvent[];
      const wait = lastRead + PACE_MS - Date.now();
      if (wait > 0) await sleep(wait, signal);
      try {
        page = await session.readRemote(
          [{ ...filter, since: from, limit: PAGE, ...cursor }],
          { signal, priority: "background" },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        await sleep(delay + Math.random() * 1000, signal);
        delay = Math.min(delay * 2, BACKOFF_CAP_MS);
        continue;
      }
      lastRead = Date.now();
      delay = BACKOFF_MS;
      take(page);
      const oldest = [...page].sort(
        (a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id),
      )[0];
      if (!oldest || page.length < PAGE) return;
      cursor = { until: oldest.created_at, before_id: oldest.id };
      reached(cursor);
    }
  }

  /** Every page of `filter` back to the horizon. After a reconnect, only
   * what is newer than the last read, then any older pages it didn't reach. */
  async function readAll(key: string, filter: Omit<ReadFilter, "limit">) {
    const channelIds = filter["#h"];
    const progress: FillProgress = fills.get(key) ?? {
      complete: false,
      ...(channelIds && { channelIds }),
    };
    fills.set(key, progress);
    const started = Math.floor(Date.now() / 1000);
    // Roots by ID don't change, so one complete read is enough.
    if (progress.top !== undefined && !filter.ids)
      await readPages(filter, Math.max(since, progress.top - RESUME_SLACK_S));
    progress.top = started;
    if (progress.complete) return;
    await readPages(filter, since, progress.cursor, (cursor) => {
      progress.cursor = cursor;
    });
    progress.complete = true;
  }

  /** Your messages, mentions, direct messages and threads, in one channel
   * when `channelId` is given. */
  async function readHistory(channelId?: string) {
    const scope = channelId ? { "#h": [channelId] } : {};
    const at = channelId ? `@${channelId}` : "";
    await readAll(`own${at}`, { kinds: KINDS, authors: [viewer], ...scope });
    await readAll(`mentions${at}`, { kinds: KINDS, "#p": [viewer], ...scope });
    const dms = session.channels
      .list()
      .channels.filter(
        (c) => c.channelType === "dm" && (!channelId || c.id === channelId),
      )
      .map((c) => c.id);
    for (const ids of chunks(dms, 50))
      await readAll(`dms:${ids.join()}`, { kinds: KINDS, "#h": ids });
    // Replies in threads you replied in, and the roots themselves.
    for (const ids of chunks([...roots], 100)) {
      await readAll(`roots-e:${ids.join()}${at}`, {
        kinds: KINDS,
        "#e": ids,
        ...scope,
      });
      await readAll(`roots-ids:${ids.join()}${at}`, {
        kinds: KINDS,
        ids,
        ...scope,
      });
    }
  }

  async function fill() {
    // Start at a random moment, so a fleet reconnecting at once spreads out.
    await sleep(Math.random() * 3000, signal);
    await session.channels.ensureList?.();
    // What the app already loaded before the finder started, deletions first.
    observed();
    publish({ phase: "filling" });
    await readHistory();
    // Rejoined channels get back what lost access removed.
    for (const id of [...revoked].filter(relevant)) {
      await readHistory(id);
      revoked.delete(id);
    }
    publish({ phase: "ready" });
    // ponytail: a failed read ends the read-ahead; it is a head start, and
    // "This channel" reads the rest on demand.
    // Direct messages were read in full above.
    const wanted = warm().filter(
      (id) => relevant(id) && channel(id)?.channelType !== "dm",
    );
    for (const id of wanted.slice(0, WARM_CHANNELS)) {
      const progress = progressOf(id);
      // Messages posted while disconnected, beyond what live replay brings.
      if (resumable.has(id) && progress.top !== undefined) {
        const started = Math.floor(Date.now() / 1000);
        await readPages(
          { kinds: KINDS, "#h": [id] },
          Math.max(since, progress.top - RESUME_SLACK_S),
        );
        progress.top = started;
        continue;
      }
      // Read ahead before this reconnect; This channel reads deeper.
      if (progress.cursor) continue;
      for (let n = 0; n < WARM_PAGES && !progress.complete; n++) {
        await sleep(PACE_MS + Math.random() * PACE_MS, signal);
        try {
          await readOlder(id, progress, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          return;
        }
      }
    }
  }

  // New messages the session receives anyway: live traffic and other reads.
  const live = session.observe([{ kinds: [...KINDS, 5], limit: PAGE }]);
  // Deletions are applied before the messages beside them are taken, and
  // kept, so a page read later can't add a deleted message back.
  const observed = () => {
    const events = live.snapshot().events as readonly RelayEvent[];
    const gone = new Set<string>();
    for (const event of events) {
      if (event.kind !== 5) continue;
      for (const [name, id] of event.tags) {
        if (name !== "e" || !id) continue;
        const known = tombstones.get(id) ?? [];
        if (known.some((deletion) => deletion.id === event.id)) continue;
        tombstones.set(id, [...known, event]);
        const target = signed.get(id);
        if (target && deleted(target)) gone.add(id);
      }
    }
    if (gone.size) {
      for (const id of gone) {
        docs.delete(id);
        signed.delete(id);
      }
      corpus.remove((doc) => gone.has(doc.id));
      publish({});
    }
    // The horizon bounds what Finder reads, not what the app delivers.
    take(events, true);
  };
  const stopLive = live.subscribe(observed);

  // Lost access drops the channel's messages; names arriving relabel rows.
  const relabel = () => {
    const list = session.channels.list();
    if (list.status === "ready") {
      const gone = new Set(
        [...docs.values()]
          .filter((doc) => !relevant(doc.channelId))
          .map((doc) => doc.channelId),
      );
      if (gone.size) {
        for (const [id, doc] of docs)
          if (gone.has(doc.channelId)) {
            docs.delete(id);
            signed.delete(id);
          }
        corpus.remove((doc) => gone.has(doc.channelId));
        for (const id of gone) {
          cursors.delete(id);
          revoked.add(id);
          // A later rejoin reads this channel's history from the start.
          for (const [key, progress] of fills)
            if (progress.channelIds?.includes(id)) fills.delete(key);
        }
      }
    }
    const relabeled = [...docs.values()].map((doc) => finderDoc(session, doc));
    for (const doc of relabeled) docs.set(doc.id, doc);
    corpus.add(relabeled);
    publish({});
  };
  let pending: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(pending);
    pending = setTimeout(relabel, 1000);
  };
  const stopList = session.channels.subscribeList(soon);
  const stopProfiles = session.profiles.subscribe(soon);

  fill().catch((error) => {
    if (!signal.aborted)
      publish({
        phase: "error",
        error: error instanceof Error ? error.message : "Indexing failed",
      });
  });

  return {
    status: () => status,
    searchChannel,
    remember,
    dispose() {
      controller.abort();
      clearTimeout(pending);
      stopLive();
      live.dispose();
      stopList();
      stopProfiles();
    },
  };
}

export type FinderSync = ReturnType<typeof startFinderSync>;
