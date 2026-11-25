import { afterEach, expect, it, vi } from "vitest";
import { byteSize } from "./budget";
import { createHeadPersistence, type HeadPersistence } from "./persistence";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Store = Partial<IDBObjectStore>;
function transaction(
  abort: () => void,
  run: (cache: HeadPersistence) => Promise<unknown> = (cache) =>
    cache.remove("channel"),
  store: Store = { delete: vi.fn() },
) {
  const tx = {
    abort: vi.fn(abort),
    error: null,
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    objectStore: () => store,
  };
  const request = {
    onsuccess: () => {},
    result: { transaction: () => tx, close: vi.fn() },
  };
  vi.stubGlobal("indexedDB", { open: () => request });
  const cache = createHeadPersistence("viewer", "relay");
  const result = run(cache);
  request.onsuccess();
  return { tx, result };
}

it("waits for completion when a timeout races an already-finished transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => {
    throw new DOMException("The transaction has finished", "InvalidStateError");
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("still aborts and rejects a genuinely stalled transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => tx.onabort());
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects unexpected abort errors instead of leaving the operation pending", async () => {
  vi.useFakeTimers();
  const failure = new Error("Unexpected abort failure");
  const { result } = transaction(() => {
    throw failure;
  });
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
});

function inactivating() {
  const state = { active: true };
  const get = { onsuccess: () => {}, result: undefined };
  const store: Store = {
    get: vi.fn(() => get as unknown as IDBRequest),
    getAll: vi.fn(),
    put: vi.fn(() => {
      if (state.active) return {} as IDBRequest<IDBValidKey>;
      throw new DOMException(
        "Failed to store record in an IDBObjectStore: The transaction is inactive or finished.",
        "TransactionInactiveError",
      );
    }),
  };
  return { state, get, store };
}
const writeStartup = (cache: HeadPersistence) =>
  cache.writeStartup?.({}) ?? Promise.reject();

it("ignores a request result delivered after the timeout aborted its transaction", async () => {
  vi.useFakeTimers();
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(
    () => {
      state.active = false;
    },
    writeStartup,
    store,
  );
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(() => get.onsuccess()).not.toThrow();
  expect(store.put).not.toHaveBeenCalled();
  tx.onabort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("swallows a follow-up request thrown by a browser-initiated abort", async () => {
  vi.useFakeTimers();
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(() => {}, writeStartup, store);
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get).toHaveBeenCalledOnce();
  state.active = false;
  expect(() => get.onsuccess()).not.toThrow();
  expect(store.put).toHaveBeenCalledOnce();
  expect(store.getAll).not.toHaveBeenCalled();
  tx.onabort();
  await rejected;
  expect(tx.abort).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

const MB = 1024 * 1024;
/** A startup store holding `held`, recording what one profile write keeps. */
function startupStore(held: { key: string; bytes: number; savedAt: number }[]) {
  const rows = { onsuccess: () => {}, result: held };
  const store = {
    put: vi.fn(),
    delete: vi.fn(),
    getAll: () => rows as unknown as IDBRequest,
  };
  return { rows, store };
}

it("evicts the profile mirror before any saved roster", async () => {
  vi.useFakeTimers();
  const { rows, store } = startupStore([
    { key: "viewer:relay", bytes: 6.5 * MB, savedAt: 1 },
  ]);
  const { tx, result } = transaction(
    () => {},
    (cache) =>
      cache.writeProfiles?.([{ name: "x".repeat(2 * MB) }]) ??
      Promise.resolve(),
    store,
  );
  await vi.advanceTimersByTimeAsync(0);
  rows.onsuccess();
  expect(store.put).toHaveBeenCalledOnce();
  expect(store.delete.mock.calls).toEqual([["viewer:relay:profiles"]]);
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
});

it("measures only this viewer and relay's saved records", async () => {
  const answer = (result: unknown) => ({
    result,
    set onsuccess(handler: () => void) {
      handler();
    },
  });
  const startup: Record<string, { bytes: number }> = {
    "viewer:relay": { bytes: 5 },
    "viewer:relay:profiles": { bytes: 7 },
    "viewer:other": { bytes: 100 },
  };
  const store = {
    get: (key: string) => answer(startup[key]),
    getAll: () =>
      answer([
        { scope: "viewer:relay", head: { bytes: 11 } },
        { scope: "viewer:other", head: { bytes: 13 } },
      ]),
  };
  const tx = {
    objectStore: () => store,
    set oncomplete(complete: () => void) {
      queueMicrotask(complete);
    },
  };
  const request = {
    onsuccess: () => {},
    result: { transaction: () => tx, close: vi.fn() },
  };
  vi.stubGlobal("indexedDB", { open: () => request });
  vi.stubGlobal("IDBKeyRange", { lowerBound: () => ({}) });
  const usage = createHeadPersistence("viewer", "relay").usage?.();
  request.onsuccess();
  await expect(usage).resolves.toBe(23);
});

it("saves optional events whole in the room saved rosters leave, the earliest giving way", async () => {
  vi.useFakeTimers();
  const { rows, store } = startupStore([
    { key: "viewer:relay", bytes: 7 * MB, savedAt: 1 },
    { key: "viewer:relay:profiles", bytes: 3 * MB, savedAt: 2 },
    { key: "other:relay:profiles", bytes: MB / 2, savedAt: 0 },
  ]);
  const names = [{ id: "name" }];
  const optional = ["a", "b", "c"].map((id) => ({
    id,
    note: "x".repeat(400 * 1024),
  }));
  const { tx, result } = transaction(
    () => {},
    (cache) => cache.writeProfiles?.(names, optional) ?? Promise.resolve(),
    store,
  );
  await vi.advanceTimersByTimeAsync(0);
  rows.onsuccess();
  const data = [...names, optional[1], optional[2]];
  expect(store.put).toHaveBeenCalledExactlyOnceWith({
    key: "viewer:relay:profiles",
    data,
    bytes: byteSize(data),
    savedAt: expect.any(Number),
  });
  // The new copy fits beside the roster; only another identity's gives way.
  expect(store.delete.mock.calls).toEqual([["other:relay:profiles"]]);
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
});
