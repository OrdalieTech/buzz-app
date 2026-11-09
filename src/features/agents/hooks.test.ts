import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { createAgentHooks } from "./hooks";

it("requires declared access and resolves active callbacks on every event", async () => {
  const root = new Context();
  let active = true;
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const registry = createAgentHooks(root);
  const run = vi.fn();
  expect(() =>
    registry.register(root, {
      id: "x",
      harness: "third/type",
      event: "before",
      run,
    }),
  ).toThrow("Declare host.agentHooks");
  const fiber = root
    .extend({
      pluginOwner: { id: "policy", revision: "1", agentHooks: ["third/type"] },
    })
    .plugin((ctx) => {
      registry.register(ctx, {
        id: "b",
        harness: "third/type",
        event: "before",
        run,
      });
      registry.register(ctx, {
        id: "a",
        harness: "third/type",
        event: "before",
        run,
      });
      expect(() =>
        registry.register(ctx, {
          id: "other",
          harness: "fourth/type",
          event: "before",
          run,
        }),
      ).toThrow("Declare host.agentHooks");
    });
  await fiber.await();
  expect(registry.handlers("third/type", "before").map(({ id }) => id)).toEqual(
    ["a", "b"],
  );
  expect(registry.handlers("third/type", "after")).toEqual([]);
  active = false;
  for (const listener of listeners) listener();
  expect(registry.handlers("third/type", "before")).toEqual([]);
  active = true;
  for (const listener of listeners) listener();
  expect(registry.handlers("third/type", "before")).toHaveLength(2);
  await fiber.dispose();
  expect(registry.handlers("third/type", "before")).toEqual([]);
  await root.fiber.dispose();
});

it("isolates callback errors while preserving ordered native decisions", async () => {
  const { dispatchAgentHooks } = await import("./hooks");
  const error = new Error("observer failed");
  const run = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({ deny: true });
  const hooks = ["observer", "policy"].map((id) => ({
    id,
    pluginId: id,
    harness: "third/type",
    event: "before",
    run,
  }));
  await expect(
    dispatchAgentHooks(
      hooks,
      {},
      { agent: "a", session: "s" },
      (value) => value != null,
      1000,
    ),
  ).resolves.toEqual({ deny: true });
  expect(run).toHaveBeenCalledTimes(2);
  run.mockRejectedValue(error);
  await expect(
    dispatchAgentHooks(
      hooks,
      {},
      { agent: "a", session: "s" },
      (value) => value != null,
      1000,
    ),
  ).rejects.toThrow("observer failed");
});

it("shares one dispatch deadline and starts no callbacks after it", async () => {
  const { dispatchAgentHooks } = await import("./hooks");
  vi.useFakeTimers();
  try {
    let finish!: (value: unknown) => void;
    const later = vi.fn();
    const hooks = [
      {
        id: "slow",
        pluginId: "slow",
        harness: "third/type",
        event: "before",
        run: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      {
        id: "later",
        pluginId: "later",
        harness: "third/type",
        event: "before",
        run: later,
      },
    ];
    const result = dispatchAgentHooks(
      hooks,
      {},
      { agent: "a", session: "s" },
      (value) => value != null,
      2500,
    );
    const failed = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(2500);
    await failed;
    finish(undefined);
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("composes only the winning response with its registered plugin source", async () => {
  const { dispatchAgentHooks } = await import("./hooks");
  const compose = vi.fn((output, pluginId) => ({ output, pluginId }));
  const hooks = [
    {
      id: "same",
      pluginId: "observer",
      harness: "type",
      event: "before",
      run: () => undefined,
    },
    {
      id: "same",
      pluginId: "berd-call",
      harness: "type",
      event: "before",
      run: () => ({ reason: "Reply first", pluginId: "spoof" }),
    },
    {
      id: "same",
      pluginId: "reply-first",
      harness: "type",
      event: "before",
      run: vi.fn(),
    },
  ];
  await expect(
    dispatchAgentHooks(
      hooks,
      {},
      { agent: "a", session: "s" },
      (value) => value != null,
      1000,
      compose,
    ),
  ).resolves.toEqual({
    output: { reason: "Reply first", pluginId: "spoof" },
    pluginId: "berd-call",
  });
  expect(compose).toHaveBeenCalledOnce();
  expect(hooks[2]?.run).not.toHaveBeenCalled();
  compose.mockClear();
  await expect(
    dispatchAgentHooks(
      [],
      {},
      { agent: "a", session: "s" },
      () => true,
      1000,
      compose,
    ),
  ).resolves.toBeUndefined();
  expect(compose).not.toHaveBeenCalled();
});
