import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

/** While registered, the sidebar shows only Solo: the All/Solo/Team tabs and
 * page destinations give way to `banner`, and the saved tab returns after.
 * Search and links still open any conversation. */
export type SidebarRestriction = Readonly<{
  id: string;
  scope: "solo";
  banner: ComponentType;
}>;
export type RegisteredSidebarRestriction = Contribution<SidebarRestriction>;
export type SidebarScope = Readonly<{
  snapshot(): readonly RegisteredSidebarRestriction[];
  subscribe(listener: () => void): () => void;
  /** Returns a remover; disabling the plugin removes it too. */
  restrict(restriction: SidebarRestriction): () => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    sidebarScope: SidebarScope;
  }
}

export class SidebarScopeService extends Service implements SidebarScope {
  private readonly restrictions;
  constructor(ctx: Context) {
    super(ctx, "sidebarScope");
    this.restrictions = createContributions<SidebarRestriction>(ctx);
  }
  snapshot = () => this.restrictions.snapshot();
  subscribe = (listener: () => void) => this.restrictions.subscribe(listener);
  restrict(restriction: SidebarRestriction) {
    if (
      !restriction ||
      typeof restriction.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(restriction.id) ||
      restriction.scope !== "solo" ||
      typeof restriction.banner !== "function"
    )
      throw new Error("A sidebar restriction needs an id, scope and banner");
    return this.restrictions.register(this.ctx, restriction);
  }
}
