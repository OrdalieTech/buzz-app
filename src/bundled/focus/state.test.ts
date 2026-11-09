import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FOCUS_KEY, createFocus } from "./state";

function browser(stored?: unknown) {
  const values = new Map<string, string>(
    stored === undefined ? [] : [[FOCUS_KEY, JSON.stringify(stored)]],
  );
  const listeners = new Set<(event: StorageEvent) => void>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
  const host = {
    localStorage: storage,
    addEventListener: (_: string, fn: (event: StorageEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (_: string, fn: (event: StorageEvent) => void) =>
      listeners.delete(fn),
  } as unknown as Window;
  return { host, values, storage, listeners };
}

const NOW = Date.UTC(2026, 10, 2, 20);
const at = (seconds: number) => Math.floor(NOW / 1000) + seconds;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

it("starts, persists and ends itself at the deadline", () => {
  const { host, values } = browser();
  const focus = createFocus(host);
  const listener = vi.fn();
  focus.subscribe(listener);
  focus.start(at(1800));
  expect(focus.snapshot().until).toBe(at(1800));
  expect(JSON.parse(values.get(FOCUS_KEY) ?? "")).toEqual({
    until: at(1800),
  });
  vi.advanceTimersByTime(1800_000);
  expect(focus.snapshot().until).toBeUndefined();
  expect(values.has(FOCUS_KEY)).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
});

it("rejects a deadline that is not in the future", () => {
  const focus = createFocus(browser().host);
  expect(() => focus.start(at(0))).toThrow("future");
  expect(focus.snapshot().until).toBeUndefined();
});

it("restores an active Focus after a restart and drops an expired one", () => {
  const status = {
    until: at(-1),
    scope: "wss://a:viewer",
    previous: null,
    published: at(-61),
    replaced: "event-before",
  };
  expect(createFocus(browser({ until: at(60) }).host).snapshot().until).toBe(
    at(60),
  );
  const expired = createFocus(browser({ until: at(-1), status }).host);
  // The deadline passed while closed; the replaced status still needs restoring.
  expect(expired.snapshot()).toMatchObject({ until: undefined, status });
});

it("keeps the replaced status after ending until the binding forgets it", () => {
  const { host, values } = browser();
  const focus = createFocus(host);
  focus.start(at(60));
  focus.recordStatus({
    until: at(60),
    scope: "s",
    previous: { text: "Lunch", emoji: "🥪", expiresAt: at(99) },
  });
  focus.end();
  expect(focus.snapshot().status?.previous?.text).toBe("Lunch");
  expect(values.has(FOCUS_KEY)).toBe(true);
  focus.recordStatus(undefined);
  expect(values.has(FOCUS_KEY)).toBe(false);
});

it("follows another window's change and tolerates corrupt storage", () => {
  const { host, values, listeners } = browser();
  const focus = createFocus(host);
  values.set(FOCUS_KEY, JSON.stringify({ until: at(300) }));
  for (const listener of listeners)
    listener({
      storageArea: host.localStorage,
      key: FOCUS_KEY,
    } as StorageEvent);
  expect(focus.snapshot().until).toBe(at(300));
  values.set(FOCUS_KEY, "{");
  for (const listener of listeners)
    listener({
      storageArea: host.localStorage,
      key: FOCUS_KEY,
    } as StorageEvent);
  expect(focus.snapshot().until).toBeUndefined();
});

it("reports a storage failure without losing the in-memory Focus", () => {
  const { host, storage } = browser();
  storage.setItem.mockImplementation(() => {
    throw new Error("quota");
  });
  const focus = createFocus(host);
  focus.start(at(60));
  expect(focus.snapshot()).toMatchObject({
    until: at(60),
    error: "Focus could not be saved on this device.",
  });
});
