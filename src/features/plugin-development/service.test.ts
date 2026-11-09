import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import type { PluginManager } from "../../plugins/manager";
import { PLUGIN_DEVELOPMENT, PluginDevelopmentService } from "./service";

it("hands plugin management only to the Plugin development plugin", () => {
  const root = new Context();
  const manager = {} as PluginManager;
  new PluginDevelopmentService(root, () => manager);
  const as = (id: string) =>
    root.extend({ pluginOwner: { id, revision: "bundled" } });
  expect(as(PLUGIN_DEVELOPMENT).pluginDevelopment.plugins()).toBe(manager);
  expect(() => as("example.page").pluginDevelopment.plugins()).toThrow(
    /Plugin development/,
  );
  expect(() => root.pluginDevelopment.plugins()).toThrow();
});
