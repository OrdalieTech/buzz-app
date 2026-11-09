import { expect, it, vi } from "vitest";
import { createMemberAdditions } from "./operations";

it("coalesces reopened views and retries a failed addition", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const add = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(async () => {
      await gate;
      throw new Error("Could not add");
    })
    .mockResolvedValue(undefined);
  const owner = createMemberAdditions(new AbortController().signal, add);
  const first = owner.add("channel", "person");
  const retry = owner.add("channel", "person");
  expect(retry).toBe(first);
  const failed = expect(first).rejects.toThrow("Could not add");
  release();
  await failed;
  expect(owner.snapshot()[0]).toMatchObject({
    confirmed: false,
    pending: false,
    error: "Could not add",
  });
  await owner.add("channel", "person");
  expect(add).toHaveBeenCalledTimes(2);
  expect(owner.snapshot()).toEqual([]);
});

it("session disposal cancels the continuation and clears recovery state", async () => {
  const lifetime = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = createMemberAdditions(lifetime.signal, () => gate);
  const operation = owner.add("channel", "person");
  await Promise.resolve();
  lifetime.abort();
  const cancelled = expect(operation).rejects.toThrow();
  release();
  await cancelled;
  expect(owner.snapshot()).toEqual([]);
  await expect(owner.add("channel", "person")).rejects.toThrow(
    "connection closed",
  );
});

it("passes a requested guest role to the addition, and only to that one", async () => {
  const roles: (string | undefined)[] = [];
  const owner = createMemberAdditions(
    new AbortController().signal,
    async (_channel, _person, intent) => {
      roles.push(intent.role);
    },
  );
  await owner.add("channel", "agent", { role: "guest" });
  await owner.add("other", "agent");
  expect(roles).toEqual(["guest", undefined]);
});

it("joins an addition under way only when it asks for the same role", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const roles: (string | undefined)[] = [];
  const add = vi.fn(
    async (_channel: string, _agent: string, intent: object) => {
      roles.push((intent as { role?: string }).role);
      await gate;
    },
  );
  const owner = createMemberAdditions(new AbortController().signal, add);
  const first = owner.add("channel", "agent");
  expect(owner.add("channel", "agent")).toBe(first);
  await expect(
    owner.add("channel", "agent", { role: "guest" }),
  ).rejects.toThrow(/another role/);
  release();
  await first;
  expect(add).toHaveBeenCalledOnce();
  expect(roles).toEqual([undefined]);
});

it("keeps Retry separate from a concurrent explicit Add and clears its flag afterward", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const add = vi.fn(
    async (_channel: string, _person: string, intent: { retry?: true }) => {
      if (add.mock.calls.length === 1) {
        expect(intent).toMatchObject({ retry: true });
        await gate;
      } else expect(intent.retry).toBeUndefined();
    },
  );
  const owner = createMemberAdditions(new AbortController().signal, add);
  const retry = owner.add("channel", "person", { retry: true });
  try {
    expect(owner.add("channel", "person", { retry: true })).toBe(retry);
    const explicit = owner.add("channel", "person");
    expect(explicit).not.toBe(retry);
    await expect(explicit).rejects.toThrow(/already.*running/);
  } finally {
    release();
    await retry;
  }
  await owner.add("channel", "person");
  expect(add).toHaveBeenCalledTimes(2);
});

it("batches additions to a channel requested in the same turn and adds the rest singly", async () => {
  const add = vi.fn(async (_channel: string, _key: string) => {});
  const addAtOnce = vi.fn(async () => new Set(["one", "two"]));
  const owner = createMemberAdditions(
    new AbortController().signal,
    add,
    undefined,
    addAtOnce,
  );
  await Promise.all(
    ["one", "two", "three"].map((key) => owner.add("channel", key)),
  );
  await owner.add("other", "four");
  expect(addAtOnce).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ["one", "two", "three"],
    expect.any(Map),
  );
  // Whoever the roster didn't show, and a lone request, get a single addition.
  expect(add.mock.calls.map(([channel, key]) => [channel, key])).toEqual([
    ["channel", "three"],
    ["other", "four"],
  ]);
  expect(owner.snapshot()).toEqual([]);
});

it("never batches a Retry, which may only finish its own receipt", async () => {
  const add = vi.fn(async () => {});
  const addAtOnce = vi.fn(async () => new Set(["one", "two"]));
  const owner = createMemberAdditions(
    new AbortController().signal,
    add,
    undefined,
    addAtOnce,
  );
  await Promise.all(
    ["one", "two"].map((key) => owner.add("channel", key, { retry: true })),
  );
  expect(addAtOnce).not.toHaveBeenCalled();
  expect(add).toHaveBeenCalledTimes(2);
});

it("adds everyone singly when the batch fails", async () => {
  const add = vi.fn(async () => {});
  const owner = createMemberAdditions(
    new AbortController().signal,
    add,
    undefined,
    async () => {
      throw new Error("Roster unavailable");
    },
  );
  await Promise.all(["one", "two"].map((key) => owner.add("channel", key)));
  expect(add).toHaveBeenCalledTimes(2);
});
