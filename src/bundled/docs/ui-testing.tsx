import {
  act,
  cleanup,
  render as renderReact,
  type RenderOptions,
} from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { Context } from "@deepseek-ai/cordis";
import { ConversationService } from "../../features/conversation/service";
import { PanelsService } from "../../features/panels/service";
import { DocsUiProvider } from "./ui";
import { docsFixture } from "./testing";
import { createDocsWorkspace } from "./workspace";
import type { RelaySession } from "../../features/relay/session";

const contexts: Context[] = [];
const workspaces: {
  workspace: ReturnType<typeof createDocsWorkspace>;
  dispose(): void;
}[] = [];
beforeEach(() => {
  localStorage.clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup();
  for (const { workspace, dispose } of workspaces.splice(0)) {
    workspace.dispose();
    dispose();
  }
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

export async function workspaceFixture(
  options?: Parameters<typeof docsFixture>[0],
  sessionForWorkspace: (session: RelaySession) => RelaySession = (session) =>
    session,
) {
  const relay = await docsFixture(options);
  const fixture = {
    ...relay,
    workspace: createDocsWorkspace(sessionForWorkspace(relay.session)),
  };
  workspaces.push(fixture);
  return fixture;
}
export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
export function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Exercise the same injected UI owners as the running plugin.
export function render(node: ReactNode, options?: RenderOptions) {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const conversation = new ConversationService(ctx);
  const panels = new PanelsService(ctx);
  return renderReact(node, {
    ...options,
    wrapper: ({ children }) => (
      <DocsUiProvider value={{ conversation: conversation.ui, panels }}>
        {children}
      </DocsUiProvider>
    ),
  });
}
