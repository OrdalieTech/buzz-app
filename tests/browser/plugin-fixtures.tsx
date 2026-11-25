// Installed fixture code only; app composition, manager, contributions and UI remain production.
import { soloRegionFixture } from "./solo-region-fixture";
import { companionPlugins } from "./companion-fixture";
import { trailingBrief, trailingCard } from "./trailing-fixture";
import { AsideWidget, type AsideSize } from "./aside-fixture";
import * as shortcutCounter from "../../examples/plugins/shortcut-counter/plugin.js";
import shortcutManifest from "../../examples/plugins/shortcut-counter/manifest.json";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { BundledPlugin } from "../../src/plugins/manager";
import type { Navigation } from "../../src/features/navigation/controller";
import type { PageProps } from "../../src/features/pages/service";
import type { PageNavigation } from "../../src/features/navigation/service";
import type { PageTabTarget } from "../../src/features/conversation/contracts";
import type { RelayData } from "../../src/features/relay/service";
import { PanelSubview } from "../../src/features/panels/PanelSubview";
import { FolderOpenIcon } from "../../src/shared/design-system/icons";
import type { PanelProps } from "../../src/features/panels/service";
import type { NotificationInput } from "../../src/features/notifications/service";

function DrillInFixture({ target, context }: PanelProps) {
  const [log, setLog] = useState(false);
  return (
    <>
      <p>Wrong match</p>
      <input aria-label="Panel draft" defaultValue="" />
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.focus();
          context?.push?.(`${target}:detail`);
        }}
      >
        Open child detail
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.focus();
          setLog(true);
        }}
      >
        Open local log
      </button>
      {log && (
        <PanelSubview
          title="Fixture log"
          backLabel="Back to detail"
          onBack={() => setLog(false)}
        >
          <p>Log contents</p>
        </PanelSubview>
      )}
    </>
  );
}

declare global {
  interface Window {
    fixtureLinkSetup?: (status: "checking" | "ready" | "needs-setup") => void;
    stalePanelClose?: () => void;
    fixtureNavigation?: Navigation;
    fixtureNotify?: (input: NotificationInput) => Promise<boolean>;
    /** Adds or removes the reader's aside in place; undefined follows the route. */
    fixtureAside?: (size: AsideSize | null | undefined) => void;
    fixturePageBroken?: boolean;
    fixtureSidebarWorkIconThrows?: boolean;
    fixtureSidebarRecovery?: boolean;
    delayFixture?: { started: boolean; release?: () => void };
    stopFixtureDependency?: () => Promise<void>;
    startFixtureDependency?: () => void;
    capturedPendingRequest?: PageNavigation | undefined;
    pendingMounted?: boolean;
    fixtureRelay?: RelayData;
    revocationProbe?: "complete" | "resolve";
    revocationAccepted?: boolean;
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    fixtureConnection: object;
  }
}
function PendingDestination({ navigation }: PageProps) {
  useEffect(() => {
    if (!navigation) return;
    window.capturedPendingRequest = navigation;
    window.pendingMounted = true;
    return () => {
      window.pendingMounted = false;
    };
  }, [navigation]);
  return <p>Pending provider destination</p>;
}
function Notes({ close, target }: PanelProps) {
  const [text, setText] = useState("");
  useEffect(() => {
    window.stalePanelClose = close;
  }, [close]);
  return (
    <label>
      Panel note ({target})
      <input
        aria-label="Panel note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
function Legacy() {
  const [text, setText] = useState("");
  return (
    <label>
      Legacy page draft
      <input
        aria-label="Legacy page draft"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
function RetryPage() {
  const [broken, setBroken] = useState(false);
  if (broken || window.fixturePageBroken)
    throw new Error("Fixture page render failure");
  return (
    <button type="button" onClick={() => setBroken(true)}>
      Break fixture page
    </button>
  );
}

function SidebarWorkIcon() {
  if (window.fixtureSidebarWorkIconThrows)
    throw new Error("Fixture sidebar icon failure");
  return <FolderOpenIcon aria-hidden="true" />;
}

// Full-window paint, so any pixel the shell leaves uncovered shows which wins.
const fill = (background: string, zIndex?: number) => () => (
  <div style={{ position: "absolute", inset: 0, background, zIndex }} />
);

export const fixturePlugins: readonly BundledPlugin[] = [
  soloRegionFixture,
  {
    manifest: {
      id: "fixture.notices",
      name: "Notice fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      apply(ctx) {
        const notices = ctx.reflect.get("notices");
        void notices
          ?.show({
            title: "Let Fixture delete a.txt?",
            actions: [
              { id: "once", label: "Allow once", prominent: true },
              { id: "deny", label: "Deny" },
            ],
          })
          .then((answer) =>
            notices.show({ title: `Answered ${answer ?? "nothing"}` }),
          );
        void notices?.show({ title: "Fixture is waiting" });
      },
    },
  },
  {
    manifest: {
      id: "fixture.backdrops",
      name: "Backdrop fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      apply(ctx) {
        const backdrops = ctx.reflect.get("backdrops");
        // The earlier layer raises its content; the later one must still win.
        backdrops?.register({
          id: "under",
          component: fill("rgb(255 0 0)", 1),
        });
        backdrops?.register({ id: "over", component: fill("rgb(0 0 255)") });
      },
    },
  },
  {
    manifest: {
      id: "fixture.provider",
      name: "Provider fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      inject: ["agents"],
      apply(ctx) {
        const state = { readiness: "ready" as const };
        ctx.agents.register({
          id: "sample",
          title: "Fixture provider",
          defaults: () => ({ config: {} }),
          provider: {
            snapshot: () => state,
            subscribe: () => () => {},
            check() {},
            DialogBody: ({ onClose }) => (
              <button type="button" onClick={onClose}>
                Done
              </button>
            ),
          },
        });
      },
    },
  },
  {
    manifest: {
      id: "fixture.sidebar-rows",
      name: "Host row fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      apply(ctx) {
        ctx.reflect.get("sidebarRows")?.register({
          version: 1,
          id: "rows",
          render: (row, Default) =>
            row.id === "beta" ? (
              <div data-plugin-row="decorated" title="Tracked by this plugin">
                {Default}
              </div>
            ) : (
              Default
            ),
          sortModes: [
            {
              id: "reverse",
              label: "Reverse name",
              compare: (a, b) => b.label.localeCompare(a.label),
            },
          ],
        });
      },
    },
  },
  {
    manifest: {
      id: "fixture.sidebar-sections",
      name: "Sidebar section fixture",
      apiVersion: 1,
    },
    module: {
      apply(ctx) {
        const rows = [
          {
            id: "work",
            label: "Queue",
            badge: "New",
            count: 2,
            status: "Active",
          },
        ];
        const listeners = new Set<() => void>();
        ctx.reflect.get("sidebarSections")?.register({
          version: 1,
          id: "work",
          title: "Workspace",
          icon: <SidebarWorkIcon />,
          rows: {
            snapshot: () => rows,
            subscribe(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          select: () => ({
            version: 1,
            kind: "page",
            pluginId: "buzz.channels",
            pageId: "channels",
          }),
        });
        const reviewRows = [{ id: "review", label: "Review queue item" }];
        ctx.reflect.get("sidebarSections")?.register({
          version: 1,
          id: "review",
          title: "Review queue",
          icon: <FolderOpenIcon aria-hidden="true" />,
          rows: {
            snapshot: () => reviewRows,
            subscribe: () => () => {},
          },
          select: () => ({
            version: 1,
            kind: "page",
            pluginId: "buzz.channels",
            pageId: "channels",
          }),
        });
      },
    },
  },
  {
    manifest: {
      id: "fixture.page-placement",
      name: "Page placement fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      inject: ["pages"],
      apply(ctx) {
        for (const [id, title, placement] of [
          ["wide", "A deliberately long topbar destination", "topbar"],
          ["tool", "Toolbar destination", "toolbar"],
        ] as const)
          ctx.pages.register({
            id,
            title,
            placement,
            primary: true,
            component: () => <h1>{title}</h1>,
          });
        // Listed in the Messages sidebar, with no sidebar of its own.
        ctx.pages.register({
          id: "listed",
          title: "Listed destination",
          primary: true,
          component: () => <h1>Listed destination</h1>,
        });
        ctx.pages.register({
          id: "sidebar",
          title: "Sidebar playground",
          primary: true,
          component: () => <h1>Sidebar playground</h1>,
          sidebar: ({ target, children }) => {
            if (window.fixtureSidebarRecovery)
              throw new Error("Fixture page render failure");
            return (
              <div className="shell-sidebar-default">
                <aside
                  aria-label="Fixture sidebar"
                  className="flex h-full min-h-0 flex-col gap-3 bg-surface-panel p-3 text-standard"
                >
                  <p>
                    Target:{" "}
                    {target.kind === "page" ? target.pageId : target.kind}
                  </p>
                  <button type="button" tabIndex={0}>
                    Fixture sidebar action
                  </button>
                  {children}
                </aside>
              </div>
            );
          },
        });
        if (window.fixtureSidebarRecovery)
          for (let index = 1; index <= 12; index += 1)
            ctx.pages.register({
              id: `recovery-${index}`,
              title: `Recovery entry ${String(index).padStart(2, "0")}`,
              primary: true,
              component: () => <h1>Recovery destination</h1>,
            });
      },
    },
  },
  {
    manifest: {
      id: "fixture.notifications",
      name: "Notification fixture",
      apiVersion: 1,
    },
    module: {
      inject: ["notifications"],
      apply(ctx) {
        const producer = ctx.notifications.register({
          id: "updates",
          label: "Fixture updates",
        });
        window.fixtureNotify = producer.submit;
      },
    },
  },
  {
    manifest: {
      id: "fixture.dependency",
      name: "Dependency fixture",
      apiVersion: 1,
    },
    module: {
      apply(ctx) {
        const start = () =>
          ctx.plugin((child) => {
            child.provide("fixtureConnection", {});
          });
        let provider = start();
        window.stopFixtureDependency = async () => {
          await provider.dispose();
        };
        window.startFixtureDependency = () => {
          provider = start();
        };
      },
    },
  },
  {
    manifest: { id: "fixture.pending", name: "Pending fixture", apiVersion: 1 },
    module: {
      inject: ["pages", "fixtureConnection", "relay"],
      apply(ctx) {
        window.fixtureRelay = ctx.relay;
        ctx.pages.register({
          id: "pending",
          title: "Pending fixture",
          primary: true,
          handlesNavigation: true,
          component: PendingDestination,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.session", name: "Session fixture", apiVersion: 1 },
    module: {
      inject: ["pages", "relay", "conversation", "navigation"],
      apply(ctx) {
        const relay = ctx.relay;
        window.fixtureRelay = relay;
        function SessionPage({ navigation }: PageProps) {
          const connection = useSyncExternalStore(
            relay.subscribe,
            relay.snapshot,
          );
          const bound = navigation?.forSession(relay, connection);
          return connection.status === "ready" ? (
            <PendingDestination
              key={`${connection.scope}:${connection.generation}`}
              navigation={bound}
            />
          ) : (
            <p>Session pending reconnect</p>
          );
        }
        function ThreadFocusPage({ navigation }: PageProps) {
          const connection = useSyncExternalStore(
            relay.subscribe,
            relay.snapshot,
          );
          const Tabs = ctx.conversation.ui.Tabs;
          const target = navigation?.target;
          const threadId =
            target?.kind === "page" ? target.route?.params : undefined;
          useEffect(() => {
            navigation?.complete({ status: "opened" });
          }, [navigation]);
          if (
            connection.status !== "ready" ||
            !Tabs ||
            typeof threadId !== "string"
          )
            return null;
          return (
            <Tabs
              id="focus-fixture"
              session={connection.session}
              scope={connection.scope}
              label="Focus fixture"
            >
              {(open) => (
                <>
                  <input aria-label="Page draft" />
                  <button
                    type="button"
                    onClick={() => open({ channelId: "beta", threadId })}
                  >
                    Open cold thread
                  </button>
                </>
              )}
            </Tabs>
          );
        }
        function ReaderPage({ navigation }: PageProps) {
          const [request, setRequest] = useState<{
            opening: AbortSignal | undefined;
            signal: AbortSignal;
          }>();
          const connection = useSyncExternalStore(
            relay.subscribe,
            relay.snapshot,
          );
          const Workspace = ctx.conversation.ui.Workspace;
          const route = navigation?.target;
          const opening = navigation?.signal;
          const params =
            route?.kind === "page"
              ? (route.route?.params as PageTabTarget & {
                  trailing?: "none" | "short" | "long";
                  aside?: AsideSize;
                })
              : undefined;
          const trailing = params?.trailing;
          // A plugin adds or removes its aside in place, as its content arrives.
          const [shownAside, setShownAside] = useState<AsideSize | null>();
          // The page's own control drives the aside, as the contract asks.
          const [asideOpen, setAsideOpen] = useState(true);
          const [asideFloating, setAsideFloating] = useState<boolean>();
          useEffect(() => {
            window.fixtureAside = setShownAside;
            return () => {
              delete window.fixtureAside;
            };
          }, []);
          const asideSize =
            shownAside === undefined
              ? params?.aside
              : (shownAside ?? undefined);
          // The route's own target, kept stable across renders.
          const target = useMemo(() => {
            if (!params) return undefined;
            const { trailing: _, aside: __, ...target } = params;
            return target;
          }, [params]);
          // Approving removes the card in place, as a plugin's decision does.
          const [approved, setApproved] = useState<string>();
          const card = useMemo(
            () =>
              trailing &&
              trailing !== approved &&
              trailingCard(trailingBrief(trailing), () =>
                setApproved(trailing),
              ),
            [trailing, approved],
          );
          useEffect(() => {
            if (connection.status === "ready" && Workspace && params)
              navigation?.complete({ status: "opened" });
          }, [connection.status, Workspace, params, navigation]);
          if (connection.status !== "ready" || !Workspace || !params)
            return null;
          return (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                height: "100%",
              }}
            >
              <button
                type="button"
                onClick={() =>
                  flushSync(() =>
                    setRequest({
                      opening,
                      signal: new AbortController().signal,
                    }),
                  )
                }
              >
                Jump retained transcript
              </button>
              {asideSize && (
                <button
                  type="button"
                  aria-expanded={asideOpen}
                  data-aside-floating={asideFloating}
                  onClick={() => setAsideOpen(!asideOpen)}
                >
                  {asideOpen ? "Hide plan" : "Show plan"}
                </button>
              )}
              <div style={{ flex: 1, minHeight: 0 }}>
                <Workspace
                  id="reader-fixture"
                  session={connection.session}
                  scope={connection.scope}
                  label="Transcript fixture"
                  target={target as PageTabTarget}
                  {...(card ? { trailing: card } : {})}
                  {...(asideSize
                    ? {
                        aside: <AsideWidget size={asideSize} />,
                        asideOpen,
                        onAsideOpenChange: setAsideOpen,
                        onAsideFloatingChange: setAsideFloating,
                      }
                    : {})}
                  latestRequest={
                    request && request.opening === opening
                      ? request.signal
                      : navigation?.traversal
                        ? undefined
                        : opening
                  }
                />
              </div>
            </div>
          );
        }
        ctx.pages.register({
          id: "reader",
          title: "Transcript fixture",
          layout: "workspace",
          handlesNavigation: true,
          route: {
            version: 1,
            validate: (params) =>
              !!params && typeof params === "object" && "channelId" in params,
          },
          component: ReaderPage,
          sidebar: ({ target }) => (
            <button
              type="button"
              onClick={() => void ctx.navigation.open(target)}
            >
              Reselect transcript
            </button>
          ),
        });
        ctx.pages.register({
          id: "thread-focus",
          title: "Thread focus fixture",
          primary: true,
          handlesNavigation: true,
          route: {
            version: 1,
            validate: (params) => typeof params === "string",
          },
          component: ThreadFocusPage,
        });
        ctx.pages.register({
          id: "session",
          title: "Session fixture",
          primary: true,
          handlesNavigation: true,
          component: SessionPage,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.delayed", name: "Delayed fixture", apiVersion: 1 },
    module: {
      inject: ["pages", "agents"],
      async apply(ctx) {
        const gate = window.delayFixture;
        if (gate)
          await new Promise<void>((resolve) => {
            gate.started = true;
            gate.release = resolve;
          });
        const state = { readiness: "ready" as const };
        ctx.agents.register({
          id: "provider",
          title: "Delayed provider",
          defaults: () => ({ config: {} }),
          provider: {
            snapshot: () => state,
            subscribe: () => () => {},
            check() {},
            DialogBody: () => <p>Delayed provider controls</p>,
          },
        });
        ctx.pages.register({
          id: "slow",
          title: "Delayed fixture",
          primary: true,
          component: () => <p>Delayed destination presented</p>,
        });
      },
    },
  },
  { manifest: { ...shortcutManifest, apiVersion: 1 }, module: shortcutCounter },
  {
    manifest: {
      id: "fixture.navigation",
      name: "Navigation fixture",
      apiVersion: 1,
    },
    module: {
      inject: ["pages", "navigation"],
      apply(ctx) {
        window.fixtureNavigation = ctx.navigation;
        // Run in the contribution notification itself, before React unmount cleanup.
        ctx.effect(() =>
          ctx.pages.subscribe(() => {
            const request = window.capturedPendingRequest;
            if (
              !request ||
              !window.revocationProbe ||
              ctx.pages
                .snapshot()
                .some((page) => page.key === "fixture.pending/pending")
            )
              return;
            window.revocationAccepted =
              window.revocationProbe === "complete"
                ? request.complete({ status: "opened" })
                : request.resolve({
                    version: 1,
                    kind: "settings",
                    section: "appearance",
                  });
            delete window.revocationProbe;
          }),
        );
        ctx.pages.register({
          id: "retry",
          title: "Retry fixture",
          primary: true,
          component: RetryPage,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.notes", name: "Notes fixture", apiVersion: 1 },
    module: {
      inject: ["panels", "pages"],
      apply(ctx) {
        // Order -10 on purpose: a global resolve(target) launcher bug must hit this instead.
        ctx.panels.register({
          id: "catch-all",
          title: "Wrong panel",
          matches: () => true,
          order: -10,
          component: DrillInFixture,
        });
        ctx.panels.register({
          id: "notes",
          title: "Notes",
          matches: () => false,
          launcher: { icon: "/bestie.png", target: "not-an-agent-api" },
          component: Notes,
        });
        ctx.pages.register({
          id: "legacy",
          title: "Legacy",
          primary: true,
          component: Legacy,
        });
      },
    },
  },
  {
    manifest: {
      id: "fixture.link-setup",
      name: "Tracker previews",
      apiVersion: 1,
    },
    module: {
      inject: ["conversation", "settingsCards"],
      apply(ctx) {
        let status: "checking" | "ready" | "needs-setup" = "needs-setup";
        const listeners = new Set<() => void>();
        const set = (next: typeof status) => {
          status = next;
          for (const listener of [...listeners]) listener();
        };
        window.fixtureLinkSetup = set;
        ctx.conversation.registerLinkPreview({
          id: "tracker",
          title: "Tracker",
          matches: (url) => new URL(url).host === "tracker.example",
          order: 0,
          status: () => status,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          settings: "setup",
          component: ({ url }) => (
            <p data-tracker-card>Tracker issue {new URL(url).pathname}</p>
          ),
        });
        function TrackerSetup() {
          const current = useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            () => status,
          );
          return current === "ready" ? (
            <p>Signed in to Tracker</p>
          ) : (
            <button type="button" onClick={() => set("ready")}>
              Sign in to Tracker
            </button>
          );
        }
        ctx.settingsCards.register({
          id: "setup",
          title: "Tracker previews",
          group: "Plugins",
          component: TrackerSetup,
        });
      },
    },
  },
  ...companionPlugins,
];
