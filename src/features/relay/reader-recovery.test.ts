import { afterEach, expect, it, vi } from "vitest";
import { ACTIVE_READS, createRelayReader } from "./reader";
import { scriptedTransport } from "./testing";
import { yieldToHost } from "./yield";

vi.mock("./yield", () => ({ yieldToHost: vi.fn() }));
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const owners: ReturnType<typeof createRelayReader>[] = [];
const turns: (() => void)[] = [];
const filter = (id: string) => [{ kinds: [0], authors: [id], limit: 1 }];
function setup(options: Parameters<typeof createRelayReader>[1] = {}) {
  vi.mocked(yieldToHost).mockImplementation(
    () => new Promise<void>((resolve) => turns.push(resolve)),
  );
  const wire = scriptedTransport("viewer", "relay");
  const owner = createRelayReader(wire.transport, options);
  owners.push(owner);
  return { ...wire, ...owner, read: owner.reader.read };
}
async function nextTurn() {
  expect(turns).toHaveLength(1);
  turns.shift()?.();
  await flush();
}
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const resolve of turns.splice(0)) resolve();
  await flush();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("settles a failed read immediately but fences all dispatch until a host task", async () => {
  const h = setup();
  const error = new TypeError("Load failed");
  const first = h.read(filter("emoji"), { priority: "background" });
  const caught = first.catch((reason) => reason);
  const active = h.next();
  const queued = h.read(filter("profile"), { priority: "background" });
  active.fail(error);
  await flush();
  expect(await caught).toBe(error);
  expect(active.signal?.aborted).toBe(true);
  expect(h.pending).toHaveLength(0);
  // A consumer's retry, promotion, or another completion must not bypass the fence.
  const retry = h.read(filter("retry"));
  h.promote(() => true);
  await flush();
  expect(h.pending).toHaveLength(0);
  await nextTurn();
  expect(h.pending).toHaveLength(2);
  h.next().respond([]);
  h.next().respond([]);
  await Promise.all([queued, retry]);
});

it.each(["dispose", "invalidate"] as const)(
  "%s cancels queued work before a deferred pump can dispatch it",
  async (action) => {
    const h = setup();
    const first = h
      .read(filter("first"), { priority: "background" })
      .catch(() => {});
    const active = h.next();
    const queued = h
      .read(filter("queued"), { priority: "background" })
      .catch((e) => e);
    active.fail(new TypeError("Load failed"));
    await flush();
    h[action]();
    expect(await queued).toMatchObject({ name: "AbortError" });
    await nextTurn();
    expect(h.pending).toHaveLength(0);
    await first;
    if (action === "invalidate") {
      const fresh = h.read(filter("fresh"));
      h.next().respond([]);
      await fresh;
    }
  },
);

it("retains queued deadlines during recovery and ignores late transport rejection", async () => {
  vi.useFakeTimers();
  const h = setup({ timeoutMs: 100 });
  const first = h
    .read(filter("first"), { priority: "background" })
    .catch((e) => e);
  const active = h.next();
  const queued = h
    .read(filter("queued"), { priority: "background" })
    .catch((e) => e);
  active.fail(new TypeError("Load failed"));
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  expect(await queued).toMatchObject({ message: "Relay read timed out" });
  await nextTurn();
  expect(h.pending).toHaveLength(0);
  await first;
  const late = h.read(filter("late")).catch((e) => e);
  const expired = h.next();
  await vi.advanceTimersByTimeAsync(101);
  await late;
  expired.fail(new TypeError("late rejection"));
  await flush();
  expect(turns).toHaveLength(0);
});

it("coalesces simultaneous failures into one turn and recovers normal capacity", async () => {
  const h = setup();
  const reads = Array.from({ length: ACTIVE_READS + 1 }, (_, i) =>
    h.read(filter(`r${i}`)).catch((e) => e),
  );
  const active = Array.from({ length: ACTIVE_READS }, () => h.next());
  for (const request of active) request.fail(new Error("offline"));
  await flush();
  expect(h.pending).toHaveLength(0);
  await nextTurn();
  expect(h.pending).toHaveLength(1);
  h.next().respond([]);
  await Promise.all(reads);
  // Success still releases queued capacity without imposing a task boundary.
  const more = Array.from({ length: ACTIVE_READS + 1 }, (_, i) =>
    h.read(filter(`m${i}`)),
  );
  h.next().respond([]);
  await flush();
  expect(h.pending).toHaveLength(ACTIVE_READS);
  for (let i = 0; i < ACTIVE_READS; i++) h.next().respond([]);
  await Promise.all(more);
  expect(turns).toHaveLength(0);
});

it("does not recurse into a synchronously failing adapter", async () => {
  const h = setup();
  h.transport.query = vi.fn(() => {
    throw new Error("adapter failed");
  });
  const first = h.read(filter("one")).catch((e) => e);
  const queued = h.read(filter("two")).catch((e) => e);
  const third = h.read(filter("three")).catch((e) => e);
  expect(h.transport.query).toHaveBeenCalledTimes(1);
  expect(await first).toMatchObject({ message: "adapter failed" });
  await nextTurn();
  expect(h.transport.query).toHaveBeenCalledTimes(2);
  expect(await queued).toMatchObject({ message: "adapter failed" });
  await nextTurn();
  expect(h.transport.query).toHaveBeenCalledTimes(3);
  expect(await third).toMatchObject({ message: "adapter failed" });
  await nextTurn();
});
