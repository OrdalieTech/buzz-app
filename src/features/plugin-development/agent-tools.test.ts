import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { createPluginManager, type PluginManager } from "../../plugins/manager";
import type { PluginState } from "../../plugins/runtime";
import type { PluginInfo, StorageResult } from "../../plugins/types";
import { registerPluginDevelopmentTools, SETTLE_MS } from "./agent-tools";

type Outcome = "active" | "failed" | "hang";
type Grants = NonNullable<PluginInfo["manifest"]["host"]>;

/** The plugin manager as the tools see it, over a registry that follows the
 * native rules: reload needs the plugin disabled and its host access
 * unchanged, and rollback swaps in the previous revision. */
function fakeManager(
  initial: Partial<PluginInfo> = {},
  { paused = false, builtIn }: { paused?: boolean; builtIn?: string } = {},
) {
  let plugin: PluginInfo = {
    manifest: { id: "example.page", name: "Example", apiVersion: 1 },
    source: "external",
    enabled: true,
    revision: "one",
    previous: null,
    reloadable: true,
    updateSource: { root: "/work/example", path: "dist" },
    error: null,
    ...initial,
  };
  const build: { revision: string; host?: Grants } = { revision: "two" };
  const outcomes: Record<string, Outcome> = { one: "active", two: "active" };
  let activation: Record<string, PluginState> = builtIn
    ? { [builtIn]: { revision: "built-in", status: "active", error: null } }
    : {};
  const listeners = new Set<() => void>();
  let error: string | null = null;
  let busy = false;
  const calls: string[] = [];
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const start = () => {
    if (!plugin.enabled || paused) {
      const { [plugin.manifest.id]: _gone, ...rest } = activation;
      activation = rest;
      publish();
      return;
    }
    const { revision } = plugin;
    activation = {
      ...activation,
      [plugin.manifest.id]: { revision, status: "starting", error: null },
    };
    publish();
    queueMicrotask(() => {
      const outcome = outcomes[revision] ?? "active";
      if (outcome === "hang") return;
      if (plugin.revision !== revision || !plugin.enabled) return;
      activation = {
        ...activation,
        [plugin.manifest.id]: {
          revision,
          status: outcome,
          error: outcome === "failed" ? "Error: boom" : null,
        },
      };
      publish();
    });
  };
  // What the manager last published, when it differs from the registry.
  let shown: PluginInfo | null = null;
  const snapshot = () =>
    ({
      configuration: {
        status: "ready",
        externalPluginsPaused: paused,
        catalog: {
          profile: "test",
          location: "test",
          plugins: [shown ?? plugin],
        },
      } satisfies StorageResult,
      activation,
      busy,
      error,
      refreshError: null,
    }) as ReturnType<PluginManager["snapshot"]>;
  // Like the manager: refused while another change runs, busy until it ends.
  // Actions named here outlast the manager's wait: it reports a timeout,
  // stays busy, and the native change still lands a second later without
  // being published, so the catalog shows the old state until the next
  // completed change.
  const late = new Set<string>();
  const run = async (name: string, operation: () => void) => {
    if (busy) return false;
    busy = true;
    error = null;
    calls.push(name);
    publish();
    if (late.delete(name)) {
      setTimeout(() => {
        shown = plugin;
        operation();
        start();
        busy = false;
        publish();
      }, 1000);
      error = "Error: Plugin storage did not respond within 10 seconds";
      publish();
      return false;
    }
    await Promise.resolve();
    try {
      operation();
      shown = null;
      start();
      return true;
    } catch (reason) {
      error = String(reason);
      return false;
    } finally {
      busy = false;
      publish();
    }
  };
  const manager = {
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    change: (action: string, _id: string) =>
      run(action, () => {
        if (action === "enable") plugin = { ...plugin, enabled: true };
        else if (action === "disable") plugin = { ...plugin, enabled: false };
        else if (action === "rollback") {
          if (!plugin.previous) throw new Error("No previous revision");
          plugin = { ...plugin, revision: plugin.previous, previous: null };
        }
      }),
    reload: (_id: string) =>
      run("reload", () => {
        if (plugin.enabled)
          throw new Error("Disable the plugin before reloading it from disk");
        if (
          JSON.stringify(build.host ?? {}) !==
          JSON.stringify(plugin.manifest.host ?? {})
        )
          throw new Error(
            "Host access changed; use Load from folder to review it",
          );
        if (build.revision !== plugin.revision)
          plugin = {
            ...plugin,
            previous: plugin.revision,
            revision: build.revision,
          };
      }),
  };
  start();
  return { manager, build, outcomes, calls, late, plugin: () => plugin };
}

function tools(manager: object, registered = {}) {
  const added = new Map<string, AddedTool>();
  registerPluginDevelopmentTools({
    plugins: () => manager as unknown as PluginManager,
    agents: { addTool: (tool) => void added.set(tool.name, tool) },
    registered: () => registered,
  });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const tool = added.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const reply = await tool.call({} as never, {} as never, args);
    if (typeof reply !== "string") throw new Error("expected text");
    return name === "plugin_authoring_guide" ? reply : JSON.parse(reply);
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("returns the bundled authoring guide", async () => {
  const call = tools(fakeManager().manager);
  expect(await call("plugin_authoring_guide")).toContain("plugin_reload");
});

it("lists plugins and details one with what it registered", async () => {
  const { manager } = fakeManager();
  await vi.advanceTimersByTimeAsync(0);
  const call = tools(manager, {
    pages: [
      { id: "main", pluginId: "example.page" },
      { id: "other", pluginId: "someone.else" },
    ],
    agentTools: [{ id: "example_tool", pluginId: "example.page" }],
  });
  expect(await call("plugin_status")).toEqual({
    externalPluginsPaused: false,
    plugins: [
      {
        id: "example.page",
        name: "Example",
        source: "external",
        enabled: true,
        status: "active",
      },
    ],
  });
  expect(await call("plugin_status", { id: "example.page" })).toMatchObject({
    status: "active",
    revision: "one",
    error: null,
    folder: "/work/example/dist",
    registered: { pages: ["main"], agentTools: ["example_tool"] },
  });
  await expect(call("plugin_status", { id: "missing" })).rejects.toThrow(
    /Browse/,
  );
});

it("applies a build that starts", async () => {
  const { manager, calls, plugin } = fakeManager();
  await vi.advanceTimersByTimeAsync(0);
  const call = tools(manager);
  expect(await call("plugin_reload", { id: "example.page" })).toEqual({
    application: "applied",
    revision: "two",
    unchanged: false,
  });
  expect(calls).toEqual(["disable", "reload", "enable"]);
  expect(plugin()).toMatchObject({ enabled: true, revision: "two" });
});

it("restores the running revision when the new build fails to start", async () => {
  const { manager, outcomes, calls, plugin } = fakeManager();
  outcomes.two = "failed";
  await vi.advanceTimersByTimeAsync(0);
  const call = tools(manager);
  expect(await call("plugin_reload", { id: "example.page" })).toMatchObject({
    application: "failed",
    stage: "activation",
    error: "Error: boom",
    rolledBack: true,
  });
  expect(calls).toEqual(["disable", "reload", "enable", "rollback"]);
  expect(plugin()).toMatchObject({ enabled: true, revision: "one" });
});

it("keeps a failed build when the plugin was not running before", async () => {
  const { manager, outcomes, calls, plugin } = fakeManager();
  outcomes.one = "failed";
  outcomes.two = "failed";
  await vi.advanceTimersByTimeAsync(0);
  const call = tools(manager);
  const result = await call("plugin_reload", { id: "example.page" });
  expect(result).toMatchObject({ application: "failed", stage: "activation" });
  expect(result.rolledBack).toBeUndefined();
  expect(calls).not.toContain("rollback");
  expect(plugin().revision).toBe("two");
});

it("treats a build still starting after the deadline as failed and restores the old one", async () => {
  const { manager, outcomes, calls } = fakeManager();
  outcomes.two = "hang";
  await vi.advanceTimersByTimeAsync(0);
  const call = tools(manager);
  const result = call("plugin_reload", { id: "example.page" });
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  expect(await result).toMatchObject({
    application: "failed",
    error: "Plugin did not finish starting in time.",
  });
  expect(calls).toContain("rollback");
});

it("refuses changed host access and leaves the old revision running", async () => {
  const { manager, build, calls, plugin } = fakeManager();
  build.host = { networkOrigins: ["https://example.com"] };
  await vi.advanceTimersByTimeAsync(0);
  const call = tools(manager);
  expect(await call("plugin_reload", { id: "example.page" })).toMatchObject({
    application: "failed",
    stage: "reload",
    error: expect.stringMatching(/Host access changed/),
    nextStep: expect.stringMatching(/Update/),
  });
  expect(calls).toEqual(["disable", "reload", "enable"]);
  expect(plugin()).toMatchObject({ enabled: true, revision: "one" });
});

it("saves without starting a plugin its owner disabled", async () => {
  const { manager, calls, plugin } = fakeManager({ enabled: false });
  const call = tools(manager);
  expect(await call("plugin_reload", { id: "example.page" })).toMatchObject({
    application: "saved",
    revision: "two",
  });
  expect(calls).toEqual(["reload"]);
  expect(plugin().enabled).toBe(false);
});

it("keeps the plugin enabled in safe mode and says it is not running", async () => {
  const { manager, plugin } = fakeManager({}, { paused: true });
  const call = tools(manager);
  expect(await call("plugin_reload", { id: "example.page" })).toMatchObject({
    application: "saved",
    nextStep: expect.stringMatching(/safe mode/),
  });
  expect(plugin()).toMatchObject({ enabled: true, revision: "two" });
});

it("refuses plugins it cannot reload", async () => {
  const bundled = tools(fakeManager({ source: "bundled" }).manager);
  await expect(
    bundled("plugin_reload", { id: "example.page" }),
  ).rejects.toThrow(/bundled/);
  const git = tools(
    fakeManager({
      reloadable: false,
      updateSource: {
        repository: "https://x/y.git",
        reference: "main",
        path: ".",
      },
    }).manager,
  );
  await expect(git("plugin_reload", { id: "example.page" })).rejects.toThrow(
    /not installed from a folder/,
  );
  const call = tools(fakeManager().manager);
  await expect(call("plugin_reload", { id: "missing" })).rejects.toThrow(
    /Browse/,
  );
});

it("says so when the restored revision does not start either", async () => {
  const { manager, outcomes } = fakeManager();
  await vi.advanceTimersByTimeAsync(0);
  outcomes.one = "failed";
  outcomes.two = "failed";
  const call = tools(manager);
  expect(await call("plugin_reload", { id: "example.page" })).toMatchObject({
    application: "failed",
    rolledBack: false,
    nextStep: expect.stringMatching(/not running/),
  });
});

it("runs parallel reloads one after another", async () => {
  const { manager, calls, plugin } = fakeManager();
  await vi.advanceTimersByTimeAsync(0);
  const call = tools(manager);
  const results = await Promise.all([
    call("plugin_reload", { id: "example.page" }),
    call("plugin_reload", { id: "example.page" }),
  ]);
  expect(results.map((result) => result.application)).toEqual([
    "applied",
    "applied",
  ]);
  expect(calls).toEqual([
    ...["disable", "reload", "enable"],
    ...["disable", "reload", "enable"],
  ]);
  expect(plugin().enabled).toBe(true);
});

it("names a plugin built into Buzz as not changeable", async () => {
  const { manager } = fakeManager({}, { builtIn: "buzz.emoji" });
  const call = tools(manager);
  await expect(call("plugin_reload", { id: "buzz.emoji" })).rejects.toThrow(
    /built into Buzz/,
  );
});

it("leaves a plugin off when the owner turns it off as reload starts", async () => {
  const { manager, calls, plugin } = fakeManager();
  await vi.advanceTimersByTimeAsync(0);
  const call = tools(manager);
  const owner = manager.change("disable", "example.page");
  const result = await call("plugin_reload", { id: "example.page" });
  expect(await owner).toBe(true);
  expect(result).toMatchObject({ application: "saved", revision: "two" });
  expect(calls).toEqual(["disable", "reload"]);
  expect(plugin().enabled).toBe(false);
});

it("turns the plugin back on when a disable lands after the manager gave up", async () => {
  const { manager, calls, late, plugin } = fakeManager();
  await vi.advanceTimersByTimeAsync(0);
  late.add("disable");
  const call = tools(manager);
  const result = call("plugin_reload", { id: "example.page" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({
    application: "failed",
    stage: "disable",
    error: expect.stringMatching(/did not respond/),
  });
  expect(calls).toEqual(["disable", "enable"]);
  expect(plugin()).toMatchObject({ enabled: true, revision: "one" });
});

it("turns the plugin back on when a disable lands late in the real manager", async () => {
  let enabled = true;
  const stored = (): StorageResult => ({
    status: "ready",
    externalPluginsPaused: false,
    catalog: {
      profile: "test",
      location: "test",
      plugins: [
        {
          manifest: { id: "example.page", name: "Example", apiVersion: 1 },
          source: "external",
          enabled,
          revision: "one",
          previous: null,
          reloadable: true,
          updateSource: { root: "/work/example", path: "dist" },
          error: null,
        },
      ],
    },
  });
  const changePlugin = vi.fn(async (action: string, _id: string) => {
    // Lands after the manager's 10-second wait.
    if (action === "disable")
      await new Promise((done) => setTimeout(done, 10_500));
    enabled = action === "enable" || (action !== "disable" && enabled);
    return stored();
  });
  const root = new Context();
  const manager = createPluginManager(root, {
    bundled: [],
    storage: {
      getCatalog: async () => stored(),
      changePlugin,
      recoverSettings: async () => stored(),
      readModule: async () => "",
      reloadPlugin: async () => stored(),
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    const call = tools(manager);
    const result = call("plugin_reload", { id: "example.page" });
    await vi.advanceTimersByTimeAsync(10_500);
    expect(await result).toMatchObject({
      application: "failed",
      stage: "disable",
      error: expect.stringMatching(/did not respond/),
    });
    expect(changePlugin.mock.calls.map(([action]) => action)).toEqual([
      "disable",
      "enable",
    ]);
    expect(enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.snapshot().configuration).toEqual(stored());
  } finally {
    await manager.dispose();
    await root.fiber.dispose();
  }
});
