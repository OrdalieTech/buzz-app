import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelQueries } from "../relay/contracts";

type Directory = NonNullable<
  ReturnType<NonNullable<ChannelQueries["openDirectory"]>>
>;
const none: Directory = [];
const noSubscribe = () => () => {};

type Read =
  | { status: "loading" }
  | { status: "ready"; partial: boolean }
  | { status: "error" };

/** The community's open channels, read while `active`, for browsing without
 * a query. Entries are display-only directory names: opening one reaches its
 * read-only preview, which resolves the channel. A first read's rows show
 * page by page while it loads; a finished read's stay whole while the next
 * one runs. */
export function useChannelDirectory(
  channels: Pick<
    ChannelQueries,
    | "subscribeList"
    | "subscribeDirectory"
    | "openDirectory"
    | "browseDirectory"
    | "readDirectory"
    | "directoryComplete"
  >,
  active: boolean,
) {
  const { subscribeList, subscribeDirectory } = channels;
  // Pages arrive on their own subscription; the list says when an access
  // change or cache clear drops the directory.
  const subscribe = useCallback(
    (listener: () => void) => {
      const offList = subscribeList(listener);
      const offDirectory = subscribeDirectory?.(listener);
      return () => {
        offList();
        offDirectory?.();
      };
    },
    [subscribeList, subscribeDirectory],
  );
  const directory = useSyncExternalStore(
    active ? subscribe : noSubscribe,
    () =>
      active
        ? (channels.browseDirectory?.() ?? channels.openDirectory?.() ?? none)
        : none,
  );
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<Read>({ status: "loading" });
  const readDirectory = channels.readDirectory;
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry reruns this finite read.
  useEffect(() => {
    if (!active) return;
    if (!readDirectory) {
      setRead({ status: "error" });
      return;
    }
    const controller = new AbortController();
    setRead({ status: "loading" });
    readDirectory({ signal: controller.signal }).then(
      ({ partial }) => {
        if (!controller.signal.aborted) setRead({ status: "ready", partial });
      },
      () => {
        if (!controller.signal.aborted) setRead({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [active, readDirectory, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // An access change drops a finished read's directory without ending this
  // session; read the new one rather than show its absence as no channels.
  const stale =
    active &&
    read.status === "ready" &&
    channels.directoryComplete?.() === false;
  useEffect(() => {
    if (stale) retry();
  }, [stale, retry]);
  return {
    directory,
    // A refresh keeps the finished read's rows whole: nothing more to wait for.
    loading:
      stale ||
      (active && read.status === "loading" && !channels.directoryComplete?.()),
    partial: !stale && read.status === "ready" && read.partial,
    error: read.status === "error",
    retry,
  };
}

const noCounts: ReadonlyMap<string, number> = new Map();
/** A failed count waits this long before its row may ask again, doubling
 * with each failure up to `RETRY_MAX`. */
const RETRY_FIRST = 5_000;
const RETRY_MAX = 5 * 60_000;

/** Member counts for the directory rows someone has seen: `show` takes the
 * ids in view, and each id is read once per mount. The first rows read at
 * once; later ones a moment after they show, so a fast scroll reads in one
 * batch. A failed read is tried again when its row next shows, after a
 * back-off, so scrolling past it doesn't repeat a failing read. */
export function useMemberCounts(
  channels: Pick<ChannelQueries, "readMemberCounts">,
) {
  const [counts, setCounts] = useState(noCounts);
  const asked = useRef(new Set<string>());
  const failures = useRef(new Map<string, { count: number; at: number }>());
  const queue = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const controller = useRef<AbortController>(undefined);
  const first = useRef(true);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      controller.current?.abort();
    },
    [],
  );
  const read = channels.readMemberCounts;
  const show = useCallback(
    (ids: readonly string[]) => {
      if (!read) return;
      const now = Date.now();
      for (const id of ids) {
        const failure = failures.current.get(id);
        const waiting =
          failure &&
          now - failure.at <
            Math.min(RETRY_MAX, RETRY_FIRST * 2 ** (failure.count - 1));
        if (!asked.current.has(id) && !waiting) {
          asked.current.add(id);
          queue.current.add(id);
        }
      }
      if (!queue.current.size || timer.current) return;
      const flush = () => {
        timer.current = undefined;
        const batch = [...queue.current];
        queue.current.clear();
        controller.current ??= new AbortController();
        const { signal } = controller.current;
        const fail = (ids: readonly string[]) => {
          const at = Date.now();
          for (const id of ids) {
            asked.current.delete(id);
            const count = (failures.current.get(id)?.count ?? 0) + 1;
            failures.current.set(id, { count, at });
          }
        };
        read(batch, { signal }).then(
          ({ counts: found, failed }) => {
            if (signal.aborted) return;
            for (const id of found.keys()) failures.current.delete(id);
            fail(failed);
            if (found.size)
              setCounts((previous) => new Map([...previous, ...found]));
          },
          () => fail(batch),
        );
      };
      if (first.current) {
        first.current = false;
        flush();
      } else timer.current = setTimeout(flush, 100);
    },
    [read],
  );
  return { counts, show };
}
