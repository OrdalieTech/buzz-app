import { afterEach, expect, it, vi } from "vitest";
import {
  activeRoute,
  initialModel,
  launchModel,
  noteConversationTurn,
  previousRoutedTurn,
  type ModelRouter,
  resetModelRoutesForTests,
  routeLabel,
  routeOf,
  routesFor,
  routeTurn,
  turnRoute,
  setModelRouters,
  withRoutes,
} from "./model-routes";
import type { Model } from "./service";

afterEach(() => {
  resetModelRoutesForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MODELS: readonly Model[] = [
  {
    id: "opus",
    label: "Opus",
    efforts: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
  },
  { id: "sonnet", label: "Sonnet", efforts: [{ id: "high", label: "High" }] },
];

function router(
  select: ModelRouter["select"] = async () => ({
    model: "sonnet",
    effort: "high",
    rationale: "Small task",
  }),
  overrides: Partial<ReturnType<ModelRouter["routes"]> & object> = {},
): ModelRouter {
  return {
    id: "test",
    routes: (harness) =>
      harness === "claude-code"
        ? {
            routes: [
              {
                id: "auto-balanced",
                label: "Auto Balanced",
                description: "Opus, Sonnet",
                fallback: { model: "opus", effort: "high" },
              },
              { id: "auto-premium", label: "Auto Premium" },
            ],
            initial: "auto-balanced",
            automatic: "auto-premium",
            ...overrides,
          }
        : undefined,
    select,
  };
}

const turn = (
  overrides: Partial<Parameters<typeof routeTurn>[0]> = {},
): Parameters<typeof routeTurn>[0] => ({
  harness: "claude-code",
  pick: {},
  current: "route:auto-balanced",
  automatic: false,
  models: MODELS,
  request: {
    agent: { pubkey: "a".repeat(64), name: "Agent" },
    prompt: "Fix a typo",
    history: async () => [],
    context: async () => ({
      trigger: "mention" as const,
      skills: [],
      attachments: [],
    }),
  },
  signal: new AbortController().signal,
  ...overrides,
});

it("reads route ids from saved models and keeps them off the command line", () => {
  expect(routeOf("route:auto-balanced")).toBe("auto-balanced");
  expect(routeOf(" route:x ")).toBe("x");
  expect(routeOf("route:")).toBeUndefined();
  expect(routeOf("opus")).toBeUndefined();
  expect(launchModel("route:auto-balanced")).toBe("");
  expect(launchModel("opus")).toBe("opus");
});

it("lists a harness's routes from the active routers, first id wins", () => {
  expect(routesFor("claude-code").routes).toEqual([]);
  const second: ModelRouter = {
    id: "second",
    routes: () => ({
      routes: [
        { id: "auto-balanced", label: "Duplicate" },
        { id: "Bad Id", label: "Rejected" },
        { id: "auto-fast", label: "Auto Fast" },
      ],
      initial: "auto-balanced",
      exclusive: true,
    }),
    select: async () => undefined,
  };
  setModelRouters([router(), second]);
  const routes = routesFor("claude-code");
  expect(routes.routes.map((route) => route.label)).toEqual([
    "Auto Balanced",
    "Auto Premium",
    "Auto Fast",
  ]);
  expect(routes.initial).toBe("auto-balanced");
  expect(routes.exclusive).toBe(true);
  expect(routesFor("codex").routes.map((route) => route.label)).toEqual([
    "Duplicate",
    "Auto Fast",
  ]);
  expect(initialModel("claude-code")).toBe("route:auto-balanced");
  expect(routeLabel("claude-code", "route:auto-premium")).toBe("Auto Premium");
  expect(routeLabel("claude-code", "route:gone")).toBe("Unavailable route");
  expect(routeLabel("claude-code", "opus")).toBeUndefined();
  expect(activeRoute("claude-code", "opus", true)?.id).toBe("auto-premium");
  expect(activeRoute("claude-code", "route:auto-balanced", false)?.id).toBe(
    "auto-balanced",
  );
});

it("re-reads routes when a router says they changed", () => {
  let label = "Auto Balanced";
  let notify = () => {};
  setModelRouters([
    {
      id: "test",
      routes: () => ({ routes: [{ id: "auto", label }] }),
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
      select: async () => undefined,
    },
  ]);
  expect(routesFor("codex").routes[0]?.label).toBe("Auto Balanced");
  label = "Auto Renamed";
  expect(routesFor("codex").routes[0]?.label).toBe("Auto Balanced");
  notify();
  expect(routesFor("codex").routes[0]?.label).toBe("Auto Renamed");
});

it("puts routes first in a model list and hides others only when exclusive", () => {
  setModelRouters([router()]);
  const models = { current: "opus", models: MODELS };
  expect(withRoutes("claude-code", models).models.map(({ id }) => id)).toEqual([
    "route:auto-balanced",
    "route:auto-premium",
    "opus",
    "sonnet",
  ]);
  expect(withRoutes("codex", models)).toBe(models);
  resetModelRoutesForTests();
  setModelRouters([router(undefined, { exclusive: true })]);
  expect(withRoutes("claude-code", models).models.map(({ id }) => id)).toEqual([
    "route:auto-balanced",
    "route:auto-premium",
    "opus",
  ]);
});

it("asks the saved route's router for an idle turn's model and effort", async () => {
  const select = vi.fn<ModelRouter["select"]>(async () => ({
    model: "sonnet",
    effort: "high",
    rationale: "Small task",
  }));
  setModelRouters([router(select)]);
  await expect(routeTurn(turn())).resolves.toEqual({
    model: "sonnet",
    effort: "high",
    routed: {
      route: expect.objectContaining({ id: "auto-balanced" }),
      label: "Sonnet · High",
      rationale: "Small task",
    },
  });
  expect(select).toHaveBeenCalledWith(
    expect.objectContaining({
      harness: "claude-code",
      route: "auto-balanced",
      prompt: "Fix a typo",
      models: MODELS,
    }),
  );
});

it("lets an explicit model pick win", async () => {
  const select = vi.fn<ModelRouter["select"]>(async () => ({
    model: "sonnet",
  }));
  setModelRouters([router(select)]);
  expect(
    turnRoute({
      harness: "claude-code",
      pick: { model: "opus" },
      current: "route:auto-balanced",
      automatic: false,
    }),
  ).toBeUndefined();
  await expect(routeTurn(turn({ pick: { model: "opus" } }))).resolves.toEqual({
    model: "opus",
  });
  expect(select).not.toHaveBeenCalled();
});

it("reads the thread once, ending the read with the choice", async () => {
  const read = vi.fn(async (_signal: AbortSignal) => [
    { pubkey: "b".repeat(64), content: "Earlier", createdAt: 1 },
  ]);
  let signal: AbortSignal | undefined;
  setModelRouters([
    router(async (request) => {
      await request.history();
      await request.history();
      signal = request.signal;
      return { model: "sonnet" };
    }),
  ]);
  await routeTurn(turn({ request: { ...turn().request, history: read } }));
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0]).toBe(signal);
  expect(signal?.aborted).toBe(true);
});

it("reads the turn's context once, with the choice's signal", async () => {
  const read = vi.fn(async (_signal: AbortSignal) => ({
    trigger: "watch" as const,
    instructions: "Be brief.",
    skills: [{ name: "review", description: "Reviews a diff" }],
    attachments: [{ name: "shot.png", type: "image/png" }],
  }));
  let seen: unknown;
  let signal: AbortSignal | undefined;
  setModelRouters([
    router(async (request) => {
      seen = await request.context();
      await request.context();
      signal = request.signal;
      return { model: "sonnet" };
    }),
  ]);
  await routeTurn(turn({ request: { ...turn().request, context: read } }));
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0]).toBe(signal);
  expect(seen).toMatchObject({ trigger: "watch", instructions: "Be brief." });
});

it("keeps each conversation's last routed turn and when its work ended", () => {
  let now = 1_000;
  const clock = () => now;
  const pubkey = "a".repeat(64);
  const first = noteConversationTurn(
    pubkey,
    "chan",
    "auto",
    { model: "sonnet", effort: "high" },
    clock,
  );
  expect(previousRoutedTurn(pubkey, "chan")).toEqual({
    route: "auto",
    model: "sonnet",
    effort: "high",
    chosenAt: 1_000,
  });
  expect(previousRoutedTurn(pubkey, "chan/root")).toBeUndefined();
  expect(previousRoutedTurn("b".repeat(64), "chan")).toBeUndefined();
  now = 4_000;
  first();
  expect(previousRoutedTurn(pubkey, "chan")).toMatchObject({ endedAt: 4_000 });
  // A later turn replaces it, and the earlier one's end changes nothing.
  const second = noteConversationTurn(
    pubkey,
    "chan",
    "auto",
    {
      routed: {
        route: { id: "auto", label: "Auto" },
        label: "x",
        fallback: true,
      },
    },
    clock,
  );
  now = 9_000;
  first();
  expect(previousRoutedTurn(pubkey, "chan")).toEqual({
    route: "auto",
    fallback: true,
    chosenAt: 4_000,
  });
  second();
  expect(previousRoutedTurn(pubkey, "chan")).toMatchObject({ endedAt: 9_000 });
});

it("routes a per-message route pick and Automatic's route", async () => {
  const select = vi.fn<ModelRouter["select"]>(async () => ({
    model: "opus",
  }));
  setModelRouters([router(select)]);
  await routeTurn(
    turn({ current: "opus", pick: { model: "route:auto-premium" } }),
  );
  await routeTurn(turn({ current: "opus", automatic: true }));
  expect(select.mock.calls.map(([request]) => request.route)).toEqual([
    "auto-premium",
    "auto-premium",
  ]);
  await expect(routeTurn(turn({ current: "opus" }))).resolves.toEqual({});
});

it("drops an effort the chosen model doesn't list", async () => {
  setModelRouters([router(async () => ({ model: "sonnet", effort: "low" }))]);
  await expect(routeTurn(turn())).resolves.toMatchObject({
    model: "sonnet",
  });
  expect((await routeTurn(turn())).effort).toBeUndefined();
});

it("falls back when the router fails, answers late or picks an unlisted model", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fallback = {
    model: "opus",
    effort: "high",
    routed: {
      route: expect.objectContaining({ id: "auto-balanced" }),
      label: "Opus · High",
      fallback: true,
    },
  };
  setModelRouters([
    router(async () => {
      throw new Error("down");
    }),
  ]);
  await expect(routeTurn(turn())).resolves.toEqual(fallback);
  resetModelRoutesForTests();
  setModelRouters([router(async () => ({ model: "haiku" }))]);
  await expect(routeTurn(turn())).resolves.toEqual(fallback);
  resetModelRoutesForTests();
  vi.useFakeTimers();
  setModelRouters([router(() => new Promise(() => {}))]);
  const late = routeTurn(turn());
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(late).resolves.toEqual(fallback);
});

it("falls back to Automatic's recommendation without a pick", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setModelRouters([router(async () => undefined)]);
  await expect(routeTurn(turn({ automatic: true }))).resolves.toEqual({
    routed: {
      route: expect.objectContaining({ id: "auto-premium" }),
      label: "the default model",
      fallback: true,
    },
  });
});

it("runs a saved route on the harness default while its plugin is off", async () => {
  await expect(routeTurn(turn())).resolves.toEqual({});
  await expect(routeTurn(turn({ current: "opus" }))).resolves.toEqual({});
});

it("stops when the turn is cancelled", async () => {
  const controller = new AbortController();
  setModelRouters([router(() => new Promise(() => {}))]);
  const routed = routeTurn(turn({ signal: controller.signal }));
  controller.abort(new Error("cancelled"));
  await expect(routed).rejects.toThrow("cancelled");
});
