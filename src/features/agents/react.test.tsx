// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, waitFor, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAgent, useMentionModels, AgentsContext } from "./react";
import type { Agent, Agents, Models } from "./service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("still finds a saved agent whose type plugin is not registered", () => {
  const agent = { pubkey: "a".repeat(64), type: "gone/echo" } as Agent;
  const agents = {
    subscribe: () => () => {},
    find: (pubkey: string) => (pubkey === agent.pubkey ? agent : undefined),
    types: () => [],
  } as unknown as Agents;
  const { result } = renderHook(() => useAgent(agents, agent.pubkey));
  expect(result.current).toEqual({ agent, type: undefined });
  const other = renderHook(() => useAgent(agents, "b".repeat(64)));
  expect(other.result.current).toBeUndefined();
});

const high = { id: "high", label: "High" };
const models = (current: string) => ({
  current,
  models: [{ id: current, label: current, efforts: [high] }],
});

it("loads models and their effort levels asynchronously before an agent runs", async () => {
  const pending = deferred<Models>();
  const agent = { pubkey: "agent", type: "codex", name: "Codex" } as Agent;
  const snapshot = { status: "ready", agents: [agent] };
  const types = [{ key: "codex", models: () => pending.promise }];
  const service = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AgentsContext.Provider value={service}>{children}</AgentsContext.Provider>
  );
  const { result } = renderHook(() => useMentionModels(["agent"]), {
    wrapper,
  });
  expect(result.current).toEqual([
    { pubkey: "agent", name: "Codex", current: "", models: [], loading: true },
  ]);
  await act(async () => {
    pending.resolve({ ...models("GPT test"), sendDefaults: true });
  });
  expect(result.current).toEqual([
    {
      pubkey: "agent",
      name: "Codex",
      ...models("GPT test"),
      sendDefaults: true,
    },
  ]);
});

it("loads a single model without effort levels for saved-choice validation", async () => {
  const agents = ["fixed", "tunable"].map(
    (pubkey) => ({ pubkey, type: pubkey, name: pubkey }) as Agent,
  );
  const snapshot = { status: "ready", agents };
  const types = [
    {
      key: "fixed",
      models: async () => ({
        current: "only",
        models: [{ id: "only", label: "Only", efforts: [] }],
      }),
    },
    { key: "tunable", models: async () => models("Tunable") },
  ];
  const service = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AgentsContext.Provider value={service}>{children}</AgentsContext.Provider>
  );
  const { result } = renderHook(() => useMentionModels(["fixed", "tunable"]), {
    wrapper,
  });
  // Both lookups settle together, so the tunable one is the barrier.
  await waitFor(() =>
    expect(result.current.map((choice) => choice.current)).toEqual([
      "only",
      "Tunable",
    ]),
  );
});

it("discards pending metadata after the mentioned agent changes", async () => {
  const pending = deferred<ReturnType<typeof models>>();
  const agents = ["old", "new"].map(
    (pubkey) => ({ pubkey, type: "type", name: pubkey }) as Agent,
  );
  const snapshot = { status: "ready", agents };
  const types = [
    {
      key: "type",
      models: async (agent: Agent) =>
        agent.pubkey === "old" ? pending.promise : models("New model"),
    },
  ];
  const service = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AgentsContext.Provider value={service}>{children}</AgentsContext.Provider>
  );
  const { result, rerender } = renderHook(
    ({ pubkey }) => useMentionModels([pubkey]),
    { initialProps: { pubkey: "old" }, wrapper },
  );
  rerender({ pubkey: "new" });
  await waitFor(() => expect(result.current[0]?.current).toBe("New model"));
  await act(async () => {
    pending.resolve(models("Old model"));
  });
  expect(result.current.map((choice) => choice.pubkey)).toEqual(["new"]);
});
