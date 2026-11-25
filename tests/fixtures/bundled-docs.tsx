// Production plugin, document UI, channel workspace, sessions and outboxes.
// Only the upstream relay/identity inventory is replaced with disposable keys.
import { Context } from "@deepseek-ai/cordis";
import {
  StrictMode,
  useState,
  useSyncExternalStore,
  useLayoutEffect,
  useEffect,
} from "react";
import { createRoot } from "react-dom/client";
import * as docs from "../../src/bundled/docs";
import * as links from "../../src/bundled/links";
import { ConversationService } from "../../src/features/conversation/service";
import { provideNavigation } from "../../src/features/navigation/service";
import { PagesService } from "../../src/features/pages/service";
import { PanelsService } from "../../src/features/panels/service";
import { docsFixture } from "../../src/bundled/docs/testing";
import {
  docMarkdownLink,
  parseDoc,
  type DocAddress,
} from "../../src/bundled/docs/model";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import { message } from "../../src/features/relay/testing";
import type { AddedTool } from "../../src/buzz-mcp/session-tools";
import type { PageNavigation } from "../../src/features/navigation/service";
import type { PageProps } from "../../src/features/pages/service";
import type { ComponentType } from "react";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { ChannelWorkspaceFixture } from "./channel-workspace";
import "../../src/shared/styles/globals.css";

const f = await docsFixture({ live: true });
const research = f.seed(
  "Storage research",
  "# Findings\n\nEach working doc has its own private system channel.\n\n- Stable doc identity\n- Retained revisions\n- Explicit sharing",
);
const plan = f.seed(
  "Connected docs plan",
  `# Connected docs\n\nA working plan for people and their agents.\n\n1. Create and edit the same document.\n2. Follow supporting research.\n3. Share the doc deliberately.\n\n## Supporting research\n\n${docMarkdownLink(research, f.origin)}`,
);
const agentDoc = f.seed(
  "Agent outline",
  "# Agent outline\n\nShared by your agent.",
);
const agentChannel = f.channels.get(agentDoc.channel);
if (!agentChannel) throw new Error("Missing agent doc storage");
agentChannel.creator = f.carl.pubkey;
const sharedDoc = f.seed(
  "Shared research",
  "# Shared research\n\nFrom another person.",
);
const sharedChannel = f.channels.get(sharedDoc.channel);
if (!sharedChannel) throw new Error("Missing shared doc storage");
sharedChannel.creator = f.sam.pubkey;
sharedChannel.roles = { [f.sam.pubkey]: "owner", [f.viewer.pubkey]: "guest" };
const general = "00000001-1111-4111-8111-111111111111";
f.channels.set(general, {
  id: general,
  name: "docs-design",
  creator: f.viewer.pubkey,
  labels: [],
  type: "stream",
  roles: { [f.viewer.pubkey]: "owner", [f.carl.pubkey]: "member" },
  created: 1_790_000_000,
  updated: 1_790_000_000,
});
f.accepted.push(
  message(
    f.carl,
    general,
    `I’ve updated the ${docMarkdownLink(plan, f.origin)}. Open it beside this conversation to review the plan.`,
    1_790_000_100,
  ),
);
// The fixture seeds this conversation after constructing its session. Admit
// its signed state before mounting, as a real membership notification would.
await f.session.channels.resolve?.([general], { consistency: "strong" });
const artifactWriter = f.session.configArtifactWriter;
if (!artifactWriter) throw new Error("Missing doc artifact writer");
let pendingReceipt: Promise<void> | undefined;
let releaseReceipt: (() => void) | undefined;
const snapshot: RelaySnapshot = {
  status: "ready",
  generation: 1,
  viewer: f.viewer.pubkey,
  scope: f.session.scope,
  origin: f.origin,
  session: {
    ...f.session,
    configArtifactWriter: {
      ...artifactWriter,
      async publish(...args) {
        const receipt = pendingReceipt;
        pendingReceipt = undefined;
        const result = await artifactWriter.publish(...args);
        await receipt;
        return result;
      },
    },
  },
};
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: () => f.owner.clearCache(),
};
const ctx = new Context();
ctx.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const conversation = new ConversationService(ctx);
const host = provideNavigation(ctx, undefined);
const pages = new PagesService(ctx),
  panels = new PanelsService(ctx);
ctx.provide("relay", relay);
const tools = new Map<string, AddedTool>();
ctx.provide("agents", {
  relay: () => relay,
  addInstructions() {},
  addTool: (tool: AddedTool) => tools.set(tool.name, tool),
  snapshot: () => ({
    status: "unavailable",
    agents: [],
    running: [],
    teams: [],
  }),
  subscribe: () => () => {},
});
const scope = ctx
  .extend({ pluginOwner: { id: "com.squareup.docs", revision: "fixture" } })
  .plugin(docs);
await scope;
await ctx
  .extend({ pluginOwner: { id: "buzz.links", revision: "fixture" } })
  .plugin(links);
const tool = (name: string) => {
  const found = tools.get(name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
};
Object.assign(window, {
  docsFixture: {
    plan,
    agentDoc,
    holdSaveReceipt() {
      pendingReceipt = new Promise((resolve) => {
        releaseReceipt = resolve;
      });
    },
    releaseSaveReceipt() {
      releaseReceipt?.();
      releaseReceipt = undefined;
    },
    head(id: string) {
      const event = f.heads.get(id);
      return event ? parseDoc(event) : undefined;
    },
    async agentEdit(address: DocAddress, markdown: string, broadcast = true) {
      const doc = JSON.parse(
        (await tool("doc_get").call(f.client(), {}, address)) as string,
      );
      const result = JSON.parse(
        (await tool("doc_set").call(
          f.client(),
          {},
          {
            id: doc.id,
            channel: doc.channel,
            revision: doc.revision,
            title: doc.title,
            text: markdown,
          },
        )) as string,
      );
      const event = f.heads.get(address.id);
      if (!event) throw new Error("Missing accepted revision");
      if (broadcast) f.deliver(event);
      return result;
    },
  },
});

const docsTarget = {
  version: 1,
  kind: "page",
  pluginId: "com.squareup.docs",
  pageId: "docs",
  scope: { viewer: f.viewer.pubkey, communityOrigin: f.origin },
} as const;
function RoutedDocs({ Entry }: { Entry: ComponentType<PageProps> }) {
  const state = useSyncExternalStore(
    host.navigation.subscribe,
    host.navigation.snapshot,
  );
  const [request, setRequest] = useState<PageNavigation>();
  useLayoutEffect(() => {
    if (
      state.entry.target.kind !== "page" ||
      state.entry.target.pluginId !== "com.squareup.docs"
    )
      return;
    const binding = host.request(state.attempt, {
      valid: () => true,
      subscribe: () => () => {},
    });
    setRequest(binding.request);
    binding.request.complete({ status: "opened" });
    return binding.dispose;
  }, [state.attempt, state.entry.target]);
  // The app does not expose the previous visit's request while it binds a new
  // one. Exercise the same gap when switching modes inside a document.
  return (
    <Entry
      navigation={request?.entryId === state.entry.id ? request : undefined}
    />
  );
}
function Fixture() {
  const navigation = useSyncExternalStore(
    host.navigation.subscribe,
    host.navigation.snapshot,
  );
  const selected =
    navigation.entry.target.kind === "conversation" ? "conversation" : "docs";
  useEffect(() => {
    if (host.navigation.snapshot().entry.target.kind === "home")
      void host.navigation.open(docsTarget, { replace: true });
  }, []);
  const entries = useSyncExternalStore(pages.subscribe, pages.snapshot);
  const Entry = entries.find((entry) => entry.id === "docs")?.component;
  return (
    <ToastProvider>
      <div
        style={{
          height: "100dvh",
          display: "flex",
          flexDirection: "column",
          padding: "1rem",
          gap: "0.75rem",
        }}
      >
        <nav
          aria-label="Fixture navigation"
          style={{ display: "flex", gap: "1rem" }}
        >
          <button
            type="button"
            onClick={() => {
              void host.navigation.open(docsTarget);
            }}
          >
            Docs browser
          </button>
          <button
            type="button"
            onClick={() => {
              void host.navigation.open({
                version: 1,
                kind: "conversation",
                scope: docsTarget.scope,
                channelId: general,
              });
            }}
          >
            Conversation
          </button>
        </nav>
        <main style={{ flex: 1, minHeight: 0 }}>
          <div hidden={selected !== "docs"} style={{ height: "100%" }}>
            {Entry && <RoutedDocs Entry={Entry} />}
          </div>
          <div hidden={selected !== "conversation"} style={{ height: "100%" }}>
            <ChannelWorkspaceFixture
              extensions={conversation}
              relay={relay}
              panels={panels}
              pages={pages}
              host={host}
            />
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
window.addEventListener("pagehide", () => {
  void scope.dispose();
  void ctx.fiber.dispose();
  f.dispose();
});
