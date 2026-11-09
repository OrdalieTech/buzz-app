import { Service, type Context } from "@deepseek-ai/cordis";
import type { PluginManager } from "../../plugins/manager";

/** The bundled plugin whose agent tools manage plugins. */
export const PLUGIN_DEVELOPMENT = "buzz.plugin-development";

declare module "@deepseek-ai/cordis" {
  interface Context {
    pluginDevelopment: PluginDevelopmentService;
  }
}

/** Plugin management for the Plugin development plugin only, as
 * `connectExternal` is the Agents plugin's: another plugin's call throws. */
export class PluginDevelopmentService extends Service {
  constructor(
    ctx: Context,
    private readonly manager: () => PluginManager,
  ) {
    super(ctx, "pluginDevelopment");
  }

  plugins(): PluginManager {
    if (this.ctx.pluginOwner?.id !== PLUGIN_DEVELOPMENT)
      throw new Error("Only Buzz's Plugin development plugin manages plugins.");
    return this.manager();
  }
}
