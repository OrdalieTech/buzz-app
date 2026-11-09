// The Plugin development plugin: agent tools for writing and reloading
// local plugins. The tools themselves are in features/plugin-development.
import type { Context } from "@deepseek-ai/cordis";
import { registerPluginDevelopmentTools } from "../../features/plugin-development/agent-tools";

export const inject = [
  "agents",
  "pages",
  "panels",
  "sidebarSections",
  "pluginDevelopment",
];

export function apply(ctx: Context) {
  const { agents, pages, panels, pluginDevelopment } = ctx;
  const sections = ctx.sidebarSections;
  registerPluginDevelopmentTools({
    plugins: () => pluginDevelopment.plugins(),
    agents,
    registered: () => ({
      pages: pages.snapshot(),
      panels: panels.snapshot(),
      sidebarSections: sections?.snapshot() ?? [],
      // Agents lists them as tools; each is a contribution keyed by name.
      agentTools: agents.tools().map((tool) => ({
        id: tool.name,
        pluginId: (tool as { pluginId?: string }).pluginId ?? "",
      })),
    }),
  });
}
