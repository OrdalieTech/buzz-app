import type { Contribution } from "../../plugins/contributions";
import type {
  ContributionReader,
  LinkPreviewRenderer,
  LinkPreviewStatus,
} from "../conversation/contracts";

type StatusStore = Readonly<{
  get(): LinkPreviewStatus;
  subscribe(listener: () => void): () => void;
}>;

const ready: StatusStore = Object.freeze({
  get: () => "ready" as const,
  subscribe: () => () => {},
});

const stores = new WeakMap<Contribution<LinkPreviewRenderer>, StatusStore>();

function read(entry: Contribution<LinkPreviewRenderer>): LinkPreviewStatus {
  try {
    const status = entry.status?.();
    return status === "checking" || status === "needs-setup" ? status : "ready";
  } catch {
    return "ready";
  }
}

/** One store per registration, shared by every card it draws, so a renderer
 * is asked once rather than once per link. It answers `checking` until a
 * subscription has read the provider, so nothing mounts on a stale answer. A
 * registration that has left the registry keeps its last answer and is no
 * longer asked or listened to. */
export function linkPreviewStatus(
  registry: ContributionReader<LinkPreviewRenderer>,
  entry: Contribution<LinkPreviewRenderer>,
): StatusStore {
  if (!entry.status || !entry.subscribe) return ready;
  const known = stores.get(entry);
  if (known) return known;
  const listeners = new Set<() => void>();
  const installed = () => registry.snapshot().includes(entry);
  let current: LinkPreviewStatus | undefined;
  let stop: (() => void) | undefined;
  const refresh = () => {
    if (!installed()) return;
    const next = read(entry);
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const store: StatusStore = Object.freeze({
    get() {
      return stop ? (current ?? "checking") : "checking";
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop && installed()) {
        let live = true;
        let failed = false;
        let unsubscribe: (() => void) | undefined;
        try {
          const result = entry.subscribe?.(() => {
            if (live) refresh();
          });
          if (typeof result === "function") unsubscribe = result;
        } catch {
          failed = true;
        }
        if (failed) {
          // A provider that can't report changes would leave its links stuck
          // on one answer, so they draw as if it had no status. The next first
          // subscriber tries again.
          live = false;
          stop = () => {};
          current = "ready";
          for (const each of [...listeners]) each();
        } else {
          stop = () => {
            live = false;
            try {
              unsubscribe?.();
            } catch {
              // A provider's unsubscribe failing must not break unmounting.
            }
          };
          refresh();
        }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size || !stop) return;
        stop();
        stop = undefined;
        current = undefined;
      };
    },
  });
  stores.set(entry, store);
  return store;
}

/** Every store a message's links use, read as one snapshot so the host can
 * decide which links draw before folding them. */
export function combineStatuses(stores: readonly StatusStore[]) {
  return Object.freeze({
    subscribe(listener: () => void) {
      const stops = stores.map((store) => store.subscribe(listener));
      return () => {
        for (const stopStore of stops) stopStore();
      };
    },
    get: () => stores.map((store) => store.get()).join(","),
  });
}
