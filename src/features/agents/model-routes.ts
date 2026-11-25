// Model routes: choices such as "Auto Balanced" that a bundled plugin adds to
// a harness's Model menu (`Agents.registerModelRouter`). An agent saves a
// route as its model, `route:<id>`; its synced settings keep the route beside
// the model (`synced-route.ts`). Each turn it starts asks the plugin's
// router which of the harness's own models and effort levels to run it on:
// the harness calls `Delivery.route` where a delivery starts a turn, and runs
// that turn on its answer as on a per-message pick. A message that steers a
// running turn asks nothing and keeps that turn's choice, so the session's
// prompt cache stays warm. No harness ever runs a route id, and each launches
// its process on its own default (`launchModel`).
//
// - `routes(harness)` lists a harness's routes, the one new agents start on
//   (`initial`), the one agents on Automatic use (`automatic`), and whether
//   the menu shows only routes (`exclusive`).
// - `select(request)` answers with one of `request.models` and, optionally,
//   one of its efforts. A failure, a late answer or a model the harness
//   doesn't list runs the route's `fallback`, else the harness's default.
// - An owner's explicit model pick for a message wins over the route.
// - A saved route whose plugin is off runs on the harness's default.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Model, Models } from "./service";

export const ROUTE_PREFIX = "route:";
/** The longest a turn waits for a router before it runs the fallback. */
export const ROUTE_TIMEOUT_MS = 30_000;

/** The model value an agent saves for route `id`. */
export const routeModel = (id: string) => `${ROUTE_PREFIX}${id}`;
/** The route id a saved model names, if it names one. */
export function routeOf(model: string | undefined) {
  const value = model?.trim();
  return value?.startsWith(ROUTE_PREFIX)
    ? value.slice(ROUTE_PREFIX.length) || undefined
    : undefined;
}
/** The model a harness starts its process on: each turn on a route runs
 * on its own pick, so the process starts on the harness's default. */
export const launchModel = (model: string) => (routeOf(model) ? "" : model);

export type ModelRoute = Readonly<{
  /** Lowercase letters, digits, `.`, `_` and `-`. */
  id: string;
  /** The menu's name for it, e.g. `Auto Balanced`. */
  label: string;
  /** A short line under the label, e.g. the models it chooses between. */
  description?: string;
  /** What a turn runs on when the router can't answer. */
  fallback?: Readonly<{ model: string; effort?: string }>;
}>;
export type HarnessRoutes = Readonly<{
  routes: readonly ModelRoute[];
  /** The route new agents of the harness start on. */
  initial?: string;
  /** The route agents on Automatic use, with the recommended model as the
   * fallback. */
  automatic?: string;
  /** The Model menu offers only routes (and an agent's current model). */
  exclusive?: boolean;
}>;
export type RouteMessage = Readonly<{
  pubkey: string;
  content: string;
  /** Unix seconds. */
  createdAt: number;
}>;
/** A file or image attached to the turn's message, as its `imeta` tag
 * names it. */
export type RouteAttachment = Readonly<{
  name?: string;
  /** Its MIME type, e.g. `image/png`. */
  type?: string;
  /** Bytes. */
  size?: number;
}>;
/** One of the agent's local skills, as the composer's `/` lists them. */
export type RouteSkill = Readonly<{ name: string; description: string }>;
/** The conversation's last turn a route chose for, on this device while the
 * app runs. */
export type RouteTurn = Readonly<{
  route: string;
  /** The harness's model id; absent when it ran on the harness's default. */
  model?: string;
  effort?: string;
  fallback?: true;
  /** Unix milliseconds: when the route chose, and when that turn's work
   * ended (absent while it still runs). A harness's prompt cache is warm
   * for a while after its last model call, so a router can weigh the cost
   * of a switch against how long ago `endedAt` was. */
  chosenAt: number;
  endedAt?: number;
}>;
/** What the turn is, beyond its prompt and thread: what the host already
 * holds about it, gathered without asking any other service. */
export type ModelRouteContext = Readonly<{
  /** What started it: a chat `mention` (or DM), a `watch`, a watch's
   * `catch-up`, a plugin's `source` watch, a `timer`, a plugin's wake
   * (`plugin`), the agent's own `handoff` from another conversation, or
   * `attention`. */
  trigger:
    | "mention"
    | "watch"
    | "catch-up"
    | "source"
    | "timer"
    | "plugin"
    | "handoff"
    | "attention";
  /** The kind of channel it is in, when known. */
  conversation?: "dm" | "solo" | "channel";
  /** Its message is a reply in a thread. */
  thread?: true;
  /** `history` holds the channel's earlier messages rather than a thread's:
   * a DM's, a Solo chat's or a channel session's top-level message. */
  channelHistory?: true;
  /** The agent's own standing instructions, whole. */
  instructions?: string;
  /** Its harness's local skills; empty when the harness has no skill
   * folders here. */
  skills: readonly RouteSkill[];
  /** The agent's workspace, and the folder this conversation runs in when a
   * plugin gave it one. Paths on this device. */
  workspace?: string;
  folder?: string;
  attachments: readonly RouteAttachment[];
  previous?: RouteTurn;
}>;
export type ModelRouteRequest = Readonly<{
  /** The agent type's id, e.g. `claude-code` or `codex`. */
  harness: string;
  route: string;
  agent: Readonly<{ pubkey: string; name: string }>;
  /** The text of the message or wake that starts the turn. */
  prompt: string;
  /** Earlier messages in the turn's conversation, oldest first: its
   * thread's, or for a top-level message in a DM, a Solo chat or a channel
   * session, the channel's. Read only when asked, at most once. */
  history(): Promise<readonly RouteMessage[]>;
  /** The rest of what the host knows about the turn; read only when asked,
   * at most once. */
  context(): Promise<ModelRouteContext>;
  /** The harness's own models for the agent, each with its effort levels. */
  models: readonly Model[];
  signal: AbortSignal;
}>;
export type ModelRouteChoice = Readonly<{
  model: string;
  effort?: string;
  rationale?: string;
}>;
export type ModelRouter = Readonly<{
  id: string;
  routes(harness: string): HarnessRoutes | undefined;
  /** Tells `listener` when `routes` may answer differently. */
  subscribe?(listener: () => void): () => void;
  select(request: ModelRouteRequest): Promise<ModelRouteChoice | undefined>;
}>;

const ROUTE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EMPTY: HarnessRoutes = Object.freeze({ routes: Object.freeze([]) });

// The active routers, kept here so every model menu can read them without a
// service in its props, as `recommended.ts` keeps this launch's setup.
let routers: readonly ModelRouter[] = [];
let stops: (() => void)[] = [];
let cache = new Map<
  string,
  Readonly<{ routes: HarnessRoutes; owners: ReadonlyMap<string, ModelRouter> }>
>();
const listeners = new Set<() => void>();
// Counts the times the routes may have changed, for lists that hold them.
let generation = 0;
const changed = () => {
  cache = new Map();
  generation++;
  for (const listener of listeners) listener();
};

/** Replaces the active routers (AgentsService, as plugins start and stop). */
export function setModelRouters(next: readonly ModelRouter[]) {
  for (const stop of stops) stop();
  routers = next;
  stops = next.flatMap((router) => {
    try {
      return router.subscribe ? [router.subscribe(changed)] : [];
    } catch (error) {
      console.warn(`Model router ${router.id} could not subscribe`, error);
      return [];
    }
  });
  changed();
}

/** The routes for `harness`, checked: the first router to offer a route id
 * keeps it. The same object until the routers change. */
export function routesFor(harness: string): HarnessRoutes {
  return resolved(harness).routes;
}
function resolved(harness: string) {
  const cached = cache.get(harness);
  if (cached) return cached;
  const routes: ModelRoute[] = [];
  const owners = new Map<string, ModelRouter>();
  let initial: string | undefined;
  let automatic: string | undefined;
  let exclusive = false;
  for (const router of routers) {
    let offered: HarnessRoutes | undefined;
    try {
      offered = router.routes(harness);
    } catch (error) {
      console.warn(`Model router ${router.id} could not list routes`, error);
    }
    for (const route of offered?.routes ?? []) {
      if (
        !ROUTE_ID.test(route?.id ?? "") ||
        typeof route.label !== "string" ||
        !route.label.trim() ||
        owners.has(route.id)
      )
        continue;
      owners.set(route.id, router);
      routes.push(
        Object.freeze({
          id: route.id,
          label: route.label.trim(),
          ...(route.description?.trim() && {
            description: route.description.trim(),
          }),
          ...(route.fallback?.model && {
            fallback: Object.freeze({ ...route.fallback }),
          }),
        }),
      );
    }
    const mine = (id: string | undefined) =>
      id && owners.get(id) === router ? id : undefined;
    initial ??= mine(offered?.initial);
    automatic ??= mine(offered?.automatic);
    exclusive ||= routes.length > 0 && offered?.exclusive === true;
  }
  const result: HarnessRoutes = routes.length
    ? Object.freeze({
        routes: Object.freeze(routes),
        ...(initial && { initial }),
        ...(automatic && { automatic }),
        ...(exclusive && { exclusive }),
      })
    : EMPTY;
  const entry = Object.freeze({ routes: result, owners });
  cache.set(harness, entry);
  return entry;
}
export function subscribeRoutes(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** A number that changes whenever any harness's routes may have: lists
 * that hold routes in their models, as the composer's do, list again. */
export const routesGeneration = () => generation;
/** The routes for `harness`, rendering again when they change. */
export function useModelRoutes(harness: string) {
  return useSyncExternalStore(
    subscribeRoutes,
    () => routesFor(harness),
    () => routesFor(harness),
  );
}
/** The model a new agent of `harness` starts on: its initial route, or "". */
export const initialModel = (harness: string) => {
  const { initial } = routesFor(harness);
  return initial ? routeModel(initial) : "";
};
/** Starts a new agent's blank model on the harness's initial route, once:
 * a later choice of Default stays. `active` is false for an existing agent
 * or one on Automatic. */
export function useInitialRoute(
  harness: string,
  active: boolean,
  model: string,
  apply: (model: string) => void,
) {
  const { initial } = useModelRoutes(harness);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !active || !initial) return;
    done.current = true;
    if (!model.trim()) apply(routeModel(initial));
  }, [active, apply, initial, model]);
}
/** The route a saved model names, while a router offers it. */
export const routeFor = (harness: string, model: string | undefined) => {
  const id = routeOf(model);
  return id
    ? routesFor(harness).routes.find((route) => route.id === id)
    : undefined;
};
/** A display name for a saved model that names a route. */
export const routeLabel = (harness: string, model: string | undefined) =>
  routeOf(model)
    ? (routeFor(harness, model)?.label ?? "Unavailable route")
    : undefined;
/** The route an agent runs on, if any: on Automatic, the harness's
 * Automatic route; otherwise the route its saved model names. */
export const activeRoute = (
  harness: string,
  model: string | undefined,
  automatic: boolean,
) => {
  if (!automatic) return routeFor(harness, model);
  const { automatic: id, routes } = routesFor(harness);
  return id ? routes.find((route) => route.id === id) : undefined;
};

/** `models` with the harness's routes first, for pickers such as the
 * composer's; the harness's own rows for a route are replaced, and an
 * exclusive harness's other own models are left out. */
export function withRoutes(harness: string, models: Models): Models {
  const { routes, exclusive } = routesFor(harness);
  // An exclusive menu keeps only the agent's current own model, if any.
  const own = models.models.filter(
    (model) =>
      !routeOf(model.id) && (!exclusive || model.id === models.current),
  );
  if (!routes.length && own.length === models.models.length) return models;
  return {
    ...models,
    models: [
      ...routes.map((route) => ({
        id: routeModel(route.id),
        label: route.label,
        efforts: [],
      })),
      ...own,
    ],
  };
}

export type TurnPick = Readonly<{ model?: string; effort?: string }>;
export type RoutedPick = TurnPick &
  Readonly<{
    /** What chose the pick, for the turn's activity. */
    routed?: Readonly<{
      route: ModelRoute;
      /** What it runs on, for people: e.g. `Sonnet 5.5 · High`. */
      label: string;
      rationale?: string;
      /** The router didn't answer usably. */
      fallback?: true;
    }>;
    /** Notes that the turn's work ended (AgentsService sets it, the runner
     * calls it), so the conversation's `RouteTurn` has its `endedAt`. */
    ended?: () => void;
  }>;

/** A pick of one of `models`, with an effort that model lists. */
function listed(
  models: readonly Model[],
  choice: TurnPick | undefined,
): TurnPick | undefined {
  const model = models.find((item) => item.id === choice?.model);
  if (!model) return undefined;
  return {
    model: model.id,
    ...(choice?.effort &&
      model.efforts.some((level) => level.id === choice.effort) && {
        effort: choice.effort,
      }),
  };
}

/** A pick's display name, from the harness's labels for its model and
 * effort; no model is the harness's default. */
function pickLabel(models: readonly Model[], pick: TurnPick | undefined) {
  const model = models.find((item) => item.id === pick?.model);
  if (!model) return "the default model";
  const effort = model.efforts.find((level) => level.id === pick?.effort);
  return effort ? `${model.label} · ${effort.label}` : model.label;
}

/** The route a turn runs on, if any: one picked for its message, or, without
 * an explicit model pick, Automatic's or the saved one (`current`). */
export function turnRoute(
  input: Readonly<{
    harness: string;
    pick: TurnPick;
    /** The model the agent runs on without a pick (`Models.current`). */
    current: string;
    automatic: boolean;
  }>,
) {
  const { pick } = input;
  if (pick.model && !routeOf(pick.model)) return undefined;
  return (
    routeOf(pick.model) ??
    (input.automatic
      ? routesFor(input.harness).automatic
      : routeOf(input.current))
  );
}

/** The pick a turn starts with: `pick`, the owner's for this message, unless
 * the agent runs on a route (`turnRoute`), whose router chooses. */
export async function routeTurn(
  input: Readonly<{
    harness: string;
    pick: TurnPick;
    current: string;
    automatic: boolean;
    models: readonly Model[];
    request: Omit<
      ModelRouteRequest,
      "route" | "models" | "harness" | "signal" | "history" | "context"
    > & {
      /** Read with the selection's own signal, which ends with it. */
      history(signal: AbortSignal): Promise<readonly RouteMessage[]>;
      context(signal: AbortSignal): Promise<ModelRouteContext>;
    };
    signal: AbortSignal;
  }>,
): Promise<RoutedPick> {
  const { harness, pick } = input;
  const id = turnRoute(input);
  if (!id) return pick;
  const { routes, owners } = resolved(harness);
  const route = routes.routes.find((item) => item.id === id);
  const router = owners.get(id);
  // The route's plugin is off, or no longer offers it.
  if (!route || !router) return {};
  const own = input.models.filter((model) => !routeOf(model.id));
  const late = new AbortController();
  const timer = setTimeout(
    () => late.abort(new Error("The model router took too long")),
    ROUTE_TIMEOUT_MS,
  );
  const signal = AbortSignal.any([input.signal, late.signal]);
  let history: Promise<readonly RouteMessage[]> | undefined;
  let context: Promise<ModelRouteContext> | undefined;
  let choice: ModelRouteChoice | undefined;
  try {
    // A router that ignores the signal still can't hold the turn past it.
    choice = await new Promise<ModelRouteChoice | undefined>(
      (resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        router
          .select({
            ...input.request,
            history: () => (history ??= input.request.history(signal)),
            context: () => (context ??= input.request.context(signal)),
            harness,
            route: id,
            models: own,
            signal,
          })
          .then(resolve, reject);
      },
    );
  } catch (error) {
    input.signal.throwIfAborted();
    console.warn(`Model route ${id} could not choose a model`, error);
  } finally {
    clearTimeout(timer);
    // Ends any read of the thread or context the router left running.
    if (!late.signal.aborted) late.abort(new Error("The model route chose"));
  }
  input.signal.throwIfAborted();
  const chosen = listed(own, choice);
  if (chosen)
    return {
      ...chosen,
      routed: {
        route,
        label: pickLabel(own, chosen),
        ...(choice?.rationale && { rationale: choice.rationale }),
      },
    };
  if (choice)
    console.warn(`Model route ${id} chose a model this harness doesn't list`);
  // Automatic's recommended model runs without a pick.
  const fallback = input.automatic ? undefined : listed(own, route.fallback);
  return {
    ...fallback,
    routed: { route, label: pickLabel(own, fallback), fallback: true },
  };
}

/** The latest turn an agent's route chose for on this device, while the app
 * runs: what it runs on now, or ran on last. */
export type LatestRoutedTurn = Readonly<{
  route: string;
  /** e.g. `Sonnet 5.5 · High`. */
  label: string;
  fallback?: true;
  /** Only while the owner can read the channel it was chosen for. */
  rationale?: string;
  /** The channel the turn was chosen for, if any. */
  channelId?: string;
  /** Unix milliseconds. */
  at: number;
}>;
type NotedTurn = Readonly<{
  turn: LatestRoutedTurn;
  /** The turn without its rationale, for an owner who cannot read its
   * channel: a DM only the agent is in, say. */
  withheld: LatestRoutedTurn;
  ownerReadable(): boolean;
}>;
const latest = new Map<string, NotedTurn>();
const latestListeners = new Set<() => void>();
/** Records the turn `pubkey`'s route just chose for in `channelId`
 * (AgentsService). `ownerReadable` tells, as it is shown, whether the owner
 * can read that channel. */
export function noteRoutedTurn(
  pubkey: string,
  routed: NonNullable<RoutedPick["routed"]>,
  where: Readonly<{ channelId?: string; ownerReadable(): boolean }>,
) {
  const withheld: LatestRoutedTurn = Object.freeze({
    route: routed.route.label,
    label: routed.label,
    ...(routed.fallback && { fallback: true as const }),
    ...(where.channelId && { channelId: where.channelId }),
    at: Date.now(),
  });
  latest.set(
    pubkey,
    Object.freeze({
      turn: routed.rationale
        ? Object.freeze({ ...withheld, rationale: routed.rationale })
        : withheld,
      withheld,
      ownerReadable: where.ownerReadable,
    }),
  );
  for (const listener of latestListeners) listener();
}
const subscribeLatest = (listener: () => void) => {
  latestListeners.add(listener);
  return () => {
    latestListeners.delete(listener);
  };
};
/** The latest turn `pubkey`'s route chose for, rendering again on the next.
 * Its rationale, read from that turn's conversation, only while the owner
 * can read it. */
export function useLatestRoutedTurn(pubkey: string) {
  const noted = useSyncExternalStore(
    subscribeLatest,
    () => latest.get(pubkey),
    () => latest.get(pubkey),
  );
  if (!noted) return undefined;
  return noted.ownerReadable() ? noted.turn : noted.withheld;
}

// Each conversation's last routed turn, by agent pubkey and the
// conversation's key as harnesses key their sessions.
const turns = new Map<string, RouteTurn>();
const MAX_TURNS = 500;
const turnKey = (pubkey: string, conversation: string) =>
  `${pubkey}\0${conversation}`;
/** The last turn a route chose for in `conversation`, while the app runs. */
export function previousRoutedTurn(pubkey: string, conversation: string) {
  return turns.get(turnKey(pubkey, conversation));
}
/** Records the turn a route just chose for in `conversation`; the call it
 * returns notes when that turn's work ended. */
export function noteConversationTurn(
  pubkey: string,
  conversation: string,
  route: string,
  pick: RoutedPick,
  now: () => number = Date.now,
) {
  const key = turnKey(pubkey, conversation);
  const turn: RouteTurn = Object.freeze({
    route,
    ...(pick.model && { model: pick.model }),
    ...(pick.effort && { effort: pick.effort }),
    ...(pick.routed?.fallback && { fallback: true as const }),
    chosenAt: now(),
  });
  turns.delete(key);
  turns.set(key, turn);
  // The oldest conversations go first.
  for (const old of turns.keys()) {
    if (turns.size <= MAX_TURNS) break;
    turns.delete(old);
  }
  return () => {
    // A later turn in the conversation replaced it.
    if (turns.get(key) !== turn) return;
    turns.set(key, Object.freeze({ ...turn, endedAt: now() }));
  };
}

/** Clears the routers between tests. */
export function resetModelRoutesForTests() {
  setModelRouters([]);
  latest.clear();
  turns.clear();
}
