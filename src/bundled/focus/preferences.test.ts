import { expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  FOCUS_PREFERENCES_KEY,
  createPreferences,
} from "./preferences";

function browser(stored?: string, failing = false) {
  const values = new Map<string, string>(
    stored === undefined ? [] : [[FOCUS_PREFERENCES_KEY, stored]],
  );
  const listeners = new Set<(event: StorageEvent) => void>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      if (failing) throw new Error("full");
      values.set(key, value);
    }),
  };
  const host = {
    localStorage,
    addEventListener: (_: string, fn: (event: StorageEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (_: string, fn: (event: StorageEvent) => void) =>
      listeners.delete(fn),
  } as unknown as Window;
  return { host, values, localStorage, listeners };
}

it("defaults to an hour, and keeps changes", () => {
  const { host, values } = browser();
  const preferences = createPreferences(host);
  expect(preferences.snapshot()).toEqual(DEFAULT_PREFERENCES);
  preferences.set({ length: "today" });
  expect(createPreferences(host).snapshot()).toEqual({ length: "today" });
  expect(values.has(FOCUS_PREFERENCES_KEY)).toBe(true);
});

it("falls back on unreadable settings", () => {
  expect(
    createPreferences(
      browser(JSON.stringify({ length: "99" })).host,
    ).snapshot(),
  ).toEqual(DEFAULT_PREFERENCES);
  expect(createPreferences(browser("{").host).snapshot()).toEqual(
    DEFAULT_PREFERENCES,
  );
});

it("follows another window and reports a failed save", () => {
  const { host, values, localStorage, listeners } = browser(undefined, true);
  const preferences = createPreferences(host);
  preferences.set({ length: "7200" });
  expect(preferences.error()).toMatch("could not be saved");
  values.set(FOCUS_PREFERENCES_KEY, JSON.stringify({ length: "1800" }));
  for (const listener of listeners)
    listener({
      storageArea: localStorage,
      key: FOCUS_PREFERENCES_KEY,
    } as unknown as StorageEvent);
  expect(preferences.snapshot().length).toBe("1800");
});
