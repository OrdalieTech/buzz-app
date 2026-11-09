import type { StatusInput } from "../../features/relay/user-status";

/** Device-local and app-wide: Focus survives restarts and community switches. */
export const FOCUS_KEY = "buzz-focus.v1";
// setTimeout clamps longer delays to zero; re-arm in steps instead.
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The status Focus replaced, kept until it is restored in its community. */
export type FocusStatusRecord = Readonly<{
  /** The Focus deadline it was replaced for. */
  until: number;
  scope: string;
  previous: StatusInput | null;
  /** When the telescope status was published (its `created_at`), so ending
   * Focus restores only while that status is still the latest one. */
  published?: number;
  /** The newest status event's id before the telescope was set, so a retry
   * can tell a set that never landed from anything published since. */
  replaced?: string;
}>;
export type FocusSnapshot = Readonly<{
  /** Unix seconds; `undefined` when Focus is off. */
  until: number | undefined;
  status: FocusStatusRecord | undefined;
  error: string | null;
}>;

function parseStatus(value: unknown): StatusInput | null {
  if (!value || typeof value !== "object") return null;
  const { text, emoji, expiresAt } = value as Record<string, unknown>;
  if (typeof text !== "string" || typeof emoji !== "string") return null;
  return Number.isSafeInteger(expiresAt)
    ? { text, emoji, expiresAt: expiresAt as number }
    : { text, emoji };
}

function parse(raw: string | null, now: number) {
  const value = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const until =
    Number.isSafeInteger(value.until) && (value.until as number) > now
      ? (value.until as number)
      : undefined;
  const record = value.status as Record<string, unknown> | undefined;
  const status =
    record &&
    typeof record.scope === "string" &&
    record.scope &&
    Number.isSafeInteger(record.until)
      ? {
          until: record.until as number,
          scope: record.scope,
          previous: parseStatus(record.previous),
          ...(Number.isSafeInteger(record.published)
            ? { published: record.published as number }
            : {}),
          ...(typeof record.replaced === "string" && record.replaced
            ? { replaced: record.replaced }
            : {}),
        }
      : undefined;
  return { until, status };
}

export function createFocus(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
  now = () => Date.now(),
) {
  let state: FocusSnapshot = {
    until: undefined,
    status: undefined,
    error: null,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const seconds = () => Math.floor(now() / 1000);
  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (state.until === undefined) return;
    const deadline = state.until * 1000;
    timer = setTimeout(
      () => (deadline <= now() ? end() : arm()),
      Math.max(0, Math.min(deadline - now(), MAX_TIMER_MS)),
    );
  };
  let disposed = false;
  const set = (next: Omit<FocusSnapshot, "error">) => {
    // Late status work from a disabled plugin must not touch storage.
    if (disposed) return;
    state = { ...next, error: null };
    try {
      if (next.until === undefined && !next.status)
        host?.localStorage.removeItem(FOCUS_KEY);
      else host?.localStorage.setItem(FOCUS_KEY, JSON.stringify(next));
    } catch {
      state = { ...state, error: "Focus could not be saved on this device." };
    }
    arm();
    for (const listener of listeners) listener();
  };
  const restore = () => {
    try {
      state = {
        ...parse(host?.localStorage.getItem(FOCUS_KEY) ?? null, seconds()),
        error: null,
      };
    } catch {
      state = { until: undefined, status: undefined, error: null };
    }
    arm();
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === host?.localStorage && event.key === FOCUS_KEY)
      restore();
  };
  const end = () => {
    if (state.until !== undefined)
      set({ until: undefined, status: state.status });
  };
  host?.addEventListener("storage", onStorage);
  restore();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Starts Focus; the deadline must be in the future. */
    start(until: number) {
      if (!Number.isSafeInteger(until) || until <= seconds())
        throw new Error("Choose a time in the future.");
      set({ until, status: state.status });
    },
    end,
    /** Owned by the status binding: remembers or forgets the replaced status. */
    recordStatus(status: FocusStatusRecord | undefined) {
      set({ until: state.until, status });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      host?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

export type Focus = ReturnType<typeof createFocus>;
