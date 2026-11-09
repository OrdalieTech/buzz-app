// Agent tools for writing and reloading local plugins: read the authoring
// guide, see what each plugin is doing, and replace a folder plugin's code
// with the build in its folder. Reload is the Settings reload (which refuses
// changed host access) between a disable and an enable, so an agent can never
// grant a plugin more than its owner reviewed, and a new plugin still needs
// the owner to load it in Settings.
import guide from "../../../docs/plugin-authoring-guide.md?raw";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { PluginManager } from "../../plugins/manager";
import type { PluginState } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";

type Registered = readonly Readonly<{ id: string; pluginId: string }>[];
type Plugins = Pick<
  PluginManager,
  "snapshot" | "subscribe" | "change" | "reload"
>;
export type PluginDevelopmentHost = Readonly<{
  plugins: () => Plugins;
  agents: Readonly<{ addTool(tool: AddedTool): void }>;
  /** What active plugins registered, by kind. */
  registered: () => Readonly<Record<string, Registered>>;
}>;

/** How long a reloaded plugin may take to settle. The runtime fails it within
 * about 30 s: 10 s each for the old revision's cleanup, loading the module and
 * activation. */
export const SETTLE_MS = 35_000;
/** Upper bound on waiting for another plugin change (Settings, another
 * agent) to finish; a reload from disk may take 120 s. */
const IDLE_MS = 130_000;

const LOAD_FROM_FOLDER =
  "Ask your owner to open Settings → Plugins → Manage plugins, choose Add, then Browse under Add from folder (not drag and drop, which keeps no folder to reload), pick the folder with manifest.json and plugin.js, review it and choose Install plugin. Then call plugin_reload after each change.";
const REVIEW_ACCESS =
  "The build's manifest.host differs from what your owner approved. Ask them to open Settings → Plugins, open this plugin and choose Update to review the new host access, or put manifest.host back.";

const idArg = (args: Record<string, unknown>) => {
  if (typeof args.id !== "string" || !args.id)
    throw new Error("id must be the plugin's manifest id.");
  return args.id;
};

export function registerPluginDevelopmentTools(host: PluginDevelopmentHost) {
  const catalog = () => {
    const { configuration } = host.plugins().snapshot();
    if (configuration.status === "loading")
      throw new Error("Buzz is still reading its plugins. Try again.");
    if (configuration.status === "recovery")
      throw new Error(
        `Plugin settings need recovery in Settings → Plugins: ${configuration.reason}`,
      );
    return configuration;
  };
  const activation = (id: string): PluginState | undefined =>
    host.plugins().snapshot().activation[id];
  const find = (id: string) =>
    catalog().catalog.plugins.find((plugin) => plugin.manifest.id === id);
  const folder = (plugin: PluginInfo) =>
    plugin.updateSource && "root" in plugin.updateSource
      ? `${plugin.updateSource.root}/${plugin.updateSource.path}`.replace(
          /\/\.$/,
          "",
        )
      : null;
  const brief = (plugin: PluginInfo) => ({
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    source: plugin.source,
    enabled: plugin.enabled,
    status: activation(plugin.manifest.id)?.status ?? "stopped",
  });

  /** Resolves once no plugin change is running, or false after IDLE_MS. */
  function idle() {
    const plugins = host.plugins();
    return new Promise<boolean>((resolve) => {
      const finish = (done: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(done);
      };
      const timer = setTimeout(() => finish(false), IDLE_MS);
      const unsubscribe = plugins.subscribe(() => {
        if (!plugins.snapshot().busy) finish(true);
      });
      if (!plugins.snapshot().busy) finish(true);
    });
  }

  /** Runs a management action once the manager is idle; null when it is
   * done, else why it was refused. */
  async function manage(operation: () => Promise<boolean>) {
    const busy = "Another plugin change is still running. Try again.";
    if (!(await idle())) return busy;
    // Idle now, so the manager starts the action and reports its own error.
    return (await operation())
      ? null
      : (host.plugins().snapshot().error ?? busy);
  }

  /** One reload at a time, so two never interleave their disable and enable. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>) => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  const missing = (id: string) =>
    activation(id)
      ? new Error(`${id} is built into Buzz and cannot be changed.`)
      : new Error(`No plugin ${id} is installed. ${LOAD_FROM_FOLDER}`);

  /** The plugin's state once `revision` has finished starting, or undefined
   * when it is still starting after SETTLE_MS. */
  function settled(id: string, revision: string) {
    const plugins = host.plugins();
    return new Promise<PluginState | undefined>((resolve) => {
      const check = () => {
        const state = plugins.snapshot().activation[id];
        if (state?.revision !== revision || state.status === "starting")
          return false;
        finish(state);
        return true;
      };
      const finish = (state: PluginState | undefined) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(state);
      };
      const timer = setTimeout(() => finish(undefined), SETTLE_MS);
      const unsubscribe = plugins.subscribe(() => void check());
      check();
    });
  }

  host.agents.addTool({
    name: "plugin_authoring_guide",
    description:
      "Read this before writing or changing a Buzz plugin (a page, panel, sidebar section, settings card or agent tool in this app). Returns the plugin contract, a template to copy and how to install and reload it.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async call() {
      return guide.trim();
    },
  });

  host.agents.addTool({
    name: "plugin_status",
    description:
      "List Buzz plugins with whether each is enabled and running (starting, active, failed or stopped). With id, also returns that plugin's error, revision, source folder and what it registered (pages, panels, sidebar sections, agent tools). Use it before and after plugin_reload.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "A plugin's manifest id, for its details.",
        },
      },
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const current = catalog();
      if (args.id === undefined)
        return JSON.stringify({
          externalPluginsPaused: current.externalPluginsPaused,
          plugins: current.catalog.plugins.map(brief),
        });
      const id = idArg(args);
      const plugin = find(id);
      if (!plugin) throw missing(id);
      const state = activation(id);
      const registered = Object.fromEntries(
        Object.entries(host.registered()).map(([kind, items]) => [
          kind,
          items.filter((item) => item.pluginId === id).map((item) => item.id),
        ]),
      );
      return JSON.stringify({
        ...brief(plugin),
        revision: plugin.revision,
        error: state?.error ?? plugin.error,
        reloadable: plugin.reloadable,
        folder: folder(plugin),
        host: plugin.manifest.host ?? null,
        registered,
      });
    },
  });

  host.agents.addTool({
    name: "plugin_reload",
    description:
      "Replace an installed folder plugin with the build now in its folder, wait for it to start and report the result. If the new code fails to start, the revision that was running is restored. Refuses changed manifest.host, which the owner must review; a plugin that is not installed yet must first be loaded by the owner in Settings.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The plugin's manifest id." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    call: (_client, _context, args) => serial(() => reload(idArg(args))),
  });

  async function reload(id: string) {
    // Read the plugin only once a change already running (an owner's disable
    // in Settings) has finished, so reload never undoes it.
    if (!(await idle()))
      throw new Error("Another plugin change is still running. Try again.");
    const paused = catalog().externalPluginsPaused;
    const plugin = find(id);
    if (!plugin) throw missing(id);
    if (plugin.source === "bundled")
      throw new Error(`${id} is bundled with Buzz and cannot be reloaded.`);
    if (!plugin.reloadable || !folder(plugin))
      throw new Error(
        `${id} was not installed from a folder, so it has no folder to reload. ${LOAD_FROM_FOLDER}`,
      );
    const before = plugin.revision;
    const wasEnabled = plugin.enabled;
    const wasActive = activation(id)?.status === "active";
    const plugins = host.plugins();
    const failed = (stage: string, error: string, nextStep: string) =>
      JSON.stringify({ application: "failed", stage, error, nextStep });
    /** After a failed step, turns the plugin back on if it was on. A step
     * the manager stopped waiting for can still finish, and the manager does
     * not publish that late result, so the catalog may still say enabled.
     * Enabling is harmless when it is on and returns the stored catalog.
     * Null when it is on. */
    const restore = () =>
      wasEnabled ? manage(() => plugins.change("enable", id)) : null;
    const alsoFailed = (error: string, again: string | null) =>
      again ? `${error} Re-enabling failed too: ${again}` : error;

    if (wasEnabled) {
      const error = await manage(() => plugins.change("disable", id));
      if (error)
        return failed(
          "disable",
          alsoFailed(error, await restore()),
          "Try again.",
        );
    }
    const refused = await manage(() => plugins.reload(id));
    if (refused) {
      const again = await restore();
      const nextStep = /host access changed/i.test(refused)
        ? REVIEW_ACCESS
        : "Fix the build in the plugin's folder (it needs manifest.json and plugin.js with the same manifest id), then call plugin_reload again.";
      return failed("reload", alsoFailed(refused, again), nextStep);
    }
    const reloaded = find(id);
    const revision = reloaded?.revision ?? before;
    const unchanged = revision === before;
    if (!wasEnabled)
      return JSON.stringify({
        application: "saved",
        revision,
        unchanged,
        nextStep:
          "The plugin is disabled, so it is saved but not running. Ask your owner to enable it in Settings → Plugins.",
      });
    const enableError = await manage(() => plugins.change("enable", id));
    if (enableError && (await restore()))
      return failed(
        "enable",
        enableError,
        "Ask your owner to enable it in Settings → Plugins.",
      );
    if (paused)
      return JSON.stringify({
        application: "saved",
        revision,
        unchanged,
        nextStep:
          "Buzz was started with external plugins paused (safe mode), so it is saved but not running. It runs after a normal restart.",
      });
    const state = await settled(id, revision);
    if (state?.status === "active")
      return JSON.stringify({ application: "applied", revision, unchanged });
    const error = state?.error ?? "Plugin did not finish starting in time.";
    // Restore only a revision that was running; an earlier broken one is no better.
    if (unchanged || !wasActive || reloaded?.previous !== before)
      return failed(
        "activation",
        error,
        "Fix the error in the plugin's folder and call plugin_reload again; plugin_status shows its state.",
      );
    const rollbackError = await manage(() => plugins.change("rollback", id));
    const restored = rollbackError ? undefined : await settled(id, before);
    const rolledBack = restored?.status === "active";
    return JSON.stringify({
      application: "failed",
      stage: "activation",
      error,
      rolledBack,
      ...(rollbackError ? { rollbackError } : {}),
      nextStep: rolledBack
        ? "The previous revision is running again. Fix the error in the plugin's folder and call plugin_reload again."
        : "Restoring the previous revision failed too, so the plugin is not running. Fix the error in the plugin's folder and call plugin_reload again; plugin_status shows its state.",
    });
  }
}
