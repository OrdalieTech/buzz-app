// A model route where an agent's settings leave this app's memory: its
// synced settings (NIP-AP `buzz.agent.settings`), its saved record, and a
// shared or exported definition. A version of Buzz without routes would run
// `route:<id>` as a model, so each keeps the route beside the model and the
// model empty, and that version runs the harness's default.
//
// Synced settings:
// The route sits beside `settings`, as `modelRoute: "<id>"`, and
// `settings.model` stays empty. A version of Buzz without routes reads only
// `settings`, so it runs the harness's default instead of handing a route to
// its harness as a model. That version keeps `modelRoute` when it saves
// (NIP-AP "Editing"), so the route holds only while `settings.model` is
// empty: a model picked there takes the agent off its route. In a config the
// route stays the model, `route:<id>`.
import { routeModel, routeOf } from "./model-routes";

const ID = /^[a-z0-9._-]+$/;

/** The settings a config publishes, with its route moved beside them. */
export function publishedRoute(settings: Readonly<Record<string, string>>): {
  settings: Record<string, string>;
  modelRoute: string | undefined;
} {
  const id = routeOf(settings.model);
  return id
    ? { settings: { ...settings, model: "" }, modelRoute: id }
    : { settings: { ...settings }, modelRoute: undefined };
}

/** A body's synced settings with its route as their model, while no model
 * was picked in `settings` since. */
export function routedSettings(
  body: Readonly<{ modelRoute?: unknown }>,
  settings: Readonly<Record<string, string>>,
): Record<string, string> {
  const id = body.modelRoute;
  const model: unknown = settings.model;
  const picked = typeof model === "string" ? model.trim() : model;
  return typeof id === "string" && ID.test(id) && !picked
    ? { ...settings, model: routeModel(id) }
    : { ...settings };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const valid = (id: unknown): id is string =>
  typeof id === "string" && ID.test(id);

/** A record's config as it is saved: its route, `route:<id>` as its model,
 * moves to the record's `modelRoute`, as in synced settings. A version
 * without routes reads only `config`, and drops `modelRoute` when it saves
 * the record. */
export function savedRoute(config: unknown): {
  config: unknown;
  modelRoute?: string;
} {
  const id =
    isObject(config) && typeof config.model === "string"
      ? routeOf(config.model)
      : undefined;
  if (!id) return { config };
  // A route no router could offer still leaves the model.
  const saved = { ...(config as object), model: "" };
  return valid(id) ? { config: saved, modelRoute: id } : { config: saved };
}

/** A saved record's config with its route as its model again, while the
 * config's model is still empty. */
export function loadedRoute(modelRoute: unknown, config: unknown): unknown {
  if (!valid(modelRoute) || !isObject(config)) return config;
  const model = config.model;
  if (model !== undefined && (typeof model !== "string" || model.trim()))
    return config;
  return { ...config, model: routeModel(modelRoute) };
}

/** A shared definition's model as a catalog entry or snapshot keeps it: a
 * route goes in its own field, and the model is left out. */
export function sharedRoute(model: string): {
  model: string;
  route?: string;
} {
  const id = routeOf(model);
  if (!id) return { model };
  return valid(id) ? { model: "", route: id } : { model: "" };
}

/** The model a catalog entry or snapshot shares: its route, while it names
 * no model. */
export const sharedModel = (model: string, route: unknown) =>
  !model && valid(route) ? routeModel(route) : model;
