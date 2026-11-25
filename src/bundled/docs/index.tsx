import type { PluginModule } from "../../plugins/api";
import { createDocsWorkspace, type DocsWorkspace } from "./workspace";
import { docTools } from "./tools";
import { parseDocUrl } from "./model";
import type { RelaySession } from "../../features/relay/session";
import { WorkingDocPanel, WorkingDocsPage } from "./WorkingDocsPage";
import { DocsUiProvider } from "./ui";
import { workingRoute } from "./working-route";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "panels",
  "agents",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const ui = { conversation: ctx.conversation.ui, panels: ctx.panels };
  ctx.agents.addInstructions({
    id: "docs",
    text: "For document deliverables, prefer a live Doc to a .md attachment unless the person requests a file. Call doc_help for the create/verify/link/update workflow. Update the same Doc on follow-ups; never broaden sharing automatically. Docs, Canvas and published notes use separate tools.",
  });
  const workspaces = new Map<RelaySession, DocsWorkspace>();
  const lifetime = new AbortController();
  const getWorkspace = (session: RelaySession) => {
    session.lifetimeSignal.throwIfAborted();
    let workspace = workspaces.get(session);
    if (!workspace) {
      workspace = createDocsWorkspace(session);
      workspaces.set(session, workspace);
      const owned = workspace;
      session.lifetimeSignal.addEventListener(
        "abort",
        () => {
          owned.dispose();
          workspaces.delete(session);
        },
        { once: true, signal: lifetime.signal },
      );
    }
    return workspace;
  };
  ctx.effect(() => () => {
    lifetime.abort();
    for (const workspace of workspaces.values()) workspace.dispose();
    workspaces.clear();
  });
  for (const tool of docTools((client) => {
    const connection =
      ctx.agents.relay(client.key)?.snapshot() ?? relay.snapshot();
    return connection.status === "ready"
      ? getWorkspace(connection.session)
      : undefined;
  }))
    ctx.agents.addTool(tool);
  ctx.panels.register({
    id: "doc",
    addressable: true,
    title: "Doc",
    keepOpen: true,
    channelPlacement: "tab",
    matches: (target) => !!parseDocUrl(target),
    component: (props) => (
      <DocsUiProvider value={ui}>
        <WorkingDocPanel
          key={props.target}
          {...props}
          relay={relay}
          getWorkspace={getWorkspace}
          navigator={ctx.navigation}
        />
      </DocsUiProvider>
    ),
  });
  ctx.pages.register({
    id: "docs",
    title: "Docs",
    layout: "workspace",
    primary: true,
    placement: "dock",
    route: {
      version: 1,
      validate: (params) => !!workingRoute(params),
    },
    component: (props) => (
      <DocsUiProvider value={ui}>
        <WorkingDocsPage
          {...props}
          relay={relay}
          getWorkspace={getWorkspace}
          navigator={ctx.navigation}
        />
      </DocsUiProvider>
    ),
  });
};
