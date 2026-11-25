import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import {
  LOADING_PINS,
  pinLists,
  readPinnedMessages,
  type PinSnapshot,
  type PinSource,
} from "../relay/pins";

const noSubscribe = () => () => {};

/** The channel's pins, newest first. Without a channel it stays loading. */
export function usePinnedMessages(
  source: PinSource,
  channelId: string | undefined,
): PinSnapshot {
  const store = pinLists(source);
  const subscribe = useCallback(
    (listener: () => void) =>
      channelId ? store.subscribe(channelId, listener) : noSubscribe(),
    [store, channelId],
  );
  const snapshot = () => (channelId ? store.snapshot(channelId) : LOADING_PINS);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type PinnedMessages = Readonly<{
  status: "loading" | "ready" | "error";
  /** Loaded pins in list order; ids that did not load are left out. */
  rows: readonly ChannelMessage[];
}>;

/** An open panel also reloads every row on this period, so a message erased
 * without a list change leaves it. Jittered so open panels do not read
 * together. */
const REFRESH_MS = 10 * 60_000;
/** Live edits and deletions wait this long, so a burst becomes one read. */
const SETTLE_MS = 250;
/** A failed read is retried after this, doubled per failure up to the cap
 * and jittered, so a relay outage does not get every open panel at once. */
const RETRY_MS = 5_000;
const RETRY_CAP_MS = 5 * 60_000;
const EDIT_KIND = 40003;
const DELETION_KINDS = [5, 9005];

/** Loads the rows behind `ids`. A list change reads only ids not loaded yet;
 * a live edit reloads the pin it names, and a deletion the pins whose edit it
 * withdraws (a deleted pin leaves the list itself). `attempt`, catch-up and the period
 * reload every row; an agent's owner learned after its pin loaded reloads
 * that pin. One read runs at a time; triggers meanwhile wait for it. A
 * failed read is retried in the background with backoff. Earlier rows the
 * list still names stay shown while a read runs or after it fails. */
export function usePinnedRows(
  source: PinSource,
  channelId: string,
  ids: readonly string[],
  attempt = 0,
): PinnedMessages {
  const key = ids.join(",");
  const [state, setState] = useState<PinnedMessages>({
    status: "loading",
    rows: [],
  });
  const [loader, setLoader] = useState<ReturnType<typeof rowLoader>>();
  useEffect(() => {
    const current = rowLoader(source, channelId, setState);
    setLoader(current);
    return () => current.stop();
  }, [source, channelId]);
  useEffect(() => {
    loader?.want(key ? key.split(",") : []);
  }, [loader, key]);
  useEffect(() => {
    void attempt;
    loader?.reload();
  }, [loader, attempt]);
  return state;
}

function rowLoader(
  source: PinSource,
  channelId: string,
  publish: (state: PinnedMessages) => void,
) {
  const controller = new AbortController();
  /** Read rows by id; null when the relay no longer returns it. */
  const rows = new Map<string, ChannelMessage | null>();
  /** The owner each agent's message was folded with, by agent: an owner
   * learned later may apply an edit the fold dropped. */
  const owners = new Map<string, string | undefined>();
  const owner = (pubkey: string) => {
    const value = source.profiles?.owner?.(pubkey);
    owners.set(pubkey, value);
    return value;
  };
  const folding: PinSource = {
    ...source,
    profiles: { ...source.profiles, owner },
  };
  /** Edits read, by id, to the pins they name. */
  const edits = new Map<string, readonly string[]>();
  const dirty = new Set<string>();
  let ids: readonly string[] = [];
  let reading = false;
  let failed = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = () =>
    publish({
      status: reading
        ? "loading"
        : failed
          ? "error"
          : dirty.size
            ? "loading"
            : ids.some((id) => !rows.has(id))
              ? "error"
              : "ready",
      rows: ids.flatMap((id) => {
        const row = rows.get(id);
        return row ? [row] : [];
      }),
    });
  const schedule = (delay: number) => {
    if (!reading && !timer && dirty.size)
      timer = setTimeout(() => void run(), delay);
    show();
  };
  async function run() {
    timer = undefined;
    const batch = [...dirty];
    dirty.clear();
    reading = true;
    show();
    try {
      const found = await readPinnedMessages(
        folding,
        channelId,
        batch,
        controller.signal,
      );
      for (const [edit, pins] of edits)
        if (pins.some((id) => batch.includes(id))) edits.delete(edit);
      for (const [edit, pins] of found.edits) edits.set(edit, pins);
      for (const id of batch)
        if (named.has(id)) rows.set(id, found.rows.get(id) ?? null);
      failed = false;
      failures = 0;
    } catch {
      // Retried in the background; rows already loaded stay shown.
      failed = true;
      failures++;
      for (const id of batch) if (named.has(id)) dirty.add(id);
    }
    reading = false;
    if (!controller.signal.aborted)
      schedule(
        failed
          ? Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_CAP_MS) *
              (0.5 + Math.random() / 2)
          : 0,
      );
  }
  const named = new Set<string>();
  const stopLive = source.subscribeLive(
    ({ events }) => {
      const before = dirty.size;
      for (const event of events)
        for (const [name, id] of event.tags) {
          if (name !== "e" || !id) continue;
          if (event.kind === EDIT_KIND && named.has(id)) dirty.add(id);
          if (DELETION_KINDS.includes(event.kind))
            for (const pin of edits.get(id) ?? [])
              if (named.has(pin)) dirty.add(pin);
        }
      if (dirty.size > before) schedule(SETTLE_MS);
    },
    { replay: true },
  );
  // A cut replay may miss an edit: reload every row when the channel catches
  // up after its route re-establishes, as the list itself is read again.
  const catchingUp = () =>
    source.live
      .snapshot()
      .heads.some(
        (head) => head.state === "pending" && head.channelId === channelId,
      );
  let pending = catchingUp();
  const stopCatchUp = source.live.subscribe(() => {
    const now = catchingUp();
    if (now && !pending) reload();
    pending = now;
  });
  const stopProfiles = source.profiles?.subscribe?.(() => {
    const before = dirty.size;
    for (const id of named) {
      const author = rows.get(id)?.authorId;
      if (
        author &&
        owners.has(author) &&
        owners.get(author) !== source.profiles?.owner?.(author)
      )
        dirty.add(id);
    }
    if (dirty.size > before) schedule(SETTLE_MS);
  });
  const interval = setInterval(
    () => reload(),
    REFRESH_MS + Math.random() * 60_000,
  );
  function reload() {
    for (const id of ids) dirty.add(id);
    // An explicit or periodic reload does not wait out a retry delay.
    clearTimeout(timer);
    timer = undefined;
    schedule(0);
  }
  return {
    want(next: readonly string[]) {
      ids = next;
      named.clear();
      for (const id of next) named.add(id);
      for (const id of rows.keys()) if (!named.has(id)) rows.delete(id);
      for (const id of dirty) if (!named.has(id)) dirty.delete(id);
      for (const id of next) if (!rows.has(id)) dirty.add(id);
      schedule(0);
    },
    reload,
    stop() {
      controller.abort();
      clearTimeout(timer);
      clearInterval(interval);
      stopLive();
      stopCatchUp();
      stopProfiles?.();
    },
  };
}
