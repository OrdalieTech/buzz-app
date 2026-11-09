/** A preset length: seconds, or the rest of today. */
export type FocusLength = "1800" | "3600" | "7200" | "today";
export const focusLengths: readonly (readonly [FocusLength, string])[] = [
  ["1800", "30 minutes"],
  ["3600", "1 hour"],
  ["7200", "2 hours"],
  ["today", "Rest of today"],
];

export type FocusPreferences = Readonly<{
  /** The length the dialog starts with and the shortcut focuses for. */
  length: FocusLength;
}>;
export const FOCUS_PREFERENCES_KEY = "buzz-focus-preferences.v1";
export const DEFAULT_PREFERENCES: FocusPreferences = Object.freeze({
  length: "3600",
});

const isLength = (value: unknown): value is FocusLength =>
  focusLengths.some(([length]) => length === value);
function parse(raw: string | null): FocusPreferences {
  if (!raw) return DEFAULT_PREFERENCES;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCES;
  const { length } = value as Record<string, unknown>;
  return Object.freeze({
    length: isLength(length) ? length : DEFAULT_PREFERENCES.length,
  });
}

/** Focus defaults, kept on this device and shared across windows. */
export function createPreferences(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let current = DEFAULT_PREFERENCES;
  let error: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const restore = () => {
    try {
      current = parse(
        host?.localStorage.getItem(FOCUS_PREFERENCES_KEY) ?? null,
      );
    } catch {
      current = DEFAULT_PREFERENCES;
    }
    notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.storageArea === host?.localStorage &&
      event.key === FOCUS_PREFERENCES_KEY
    )
      restore();
  };
  host?.addEventListener("storage", onStorage);
  restore();
  return {
    snapshot: () => current,
    error: () => error,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(change: Partial<FocusPreferences>) {
      current = Object.freeze({ ...current, ...change });
      error = null;
      try {
        host?.localStorage.setItem(
          FOCUS_PREFERENCES_KEY,
          JSON.stringify(current),
        );
      } catch {
        error = "Focus settings could not be saved on this device.";
      }
      notify();
    },
    dispose() {
      host?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

export type Preferences = ReturnType<typeof createPreferences>;
