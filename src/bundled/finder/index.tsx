import { lazy, Suspense, useRef, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import { relayPartition } from "../../features/relay/partition";
import { activeModal } from "../../shared/design-system/overlayLayer";
import { createCorpus } from "./corpus.ts";
import { noteInterest, topInterest } from "./interest";
import type { FinderScope } from "./FinderDialog";
import {
  createFinderState,
  type FinderState,
  type FinderSync,
  type FinderSyncStatus,
  startFinderSync,
} from "./sync";

// Loaded on first open, so the plugin list doesn't pull the dialog and its
// styles into every page that imports it.
const FinderDialog = lazy(() =>
  import("./FinderDialog").then((m) => ({ default: m.FinderDialog })),
);

export const inject = ["pages", "relay", "navigation", "shortcuts"];

type State = Readonly<{
  open: boolean;
  revision: number;
  session?: RelaySession | undefined;
  status?: FinderSyncStatus | undefined;
  sync?: FinderSync | undefined;
  scope: FinderScope;
}>;

export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const corpus = createCorpus();
  const listeners = new Set<() => void>();
  let state: State = {
    open: false,
    revision: 0,
    scope: "buzz",
  };
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
  };

  // Interest in the conversation on screen: 1 per visit, and more when you
  // search in it or open a message from Finder.
  const interested = (weight: number) => {
    const { entry } = ctx.navigation.snapshot();
    if (entry.target.kind !== "conversation") return;
    const { viewer, communityOrigin } = entry.target.scope;
    noteInterest(
      relayPartition(communityOrigin, viewer),
      entry.target.channelId,
      weight,
    );
  };
  const inConversation = () =>
    ctx.navigation.snapshot().entry.target.kind === "conversation";
  /** Opens Finder, or switches scope while it's open, keeping the text. */
  const show = (scope: FinderScope) => {
    // Searching a channel counts once per switch, not per key press.
    if (scope === "channel" && (!state.open || state.scope !== "channel"))
      interested(2);
    set({ open: true, scope });
  };
  const here = (): FinderScope => (inConversation() ? "channel" : "buzz");
  /** Opens a conversation in the connected community. */
  const openConversation = (
    channelId: string,
    extra: { messageId?: string; threadRootId?: string } = {},
  ) => {
    const { viewer, scope } = relay.snapshot();
    if (!viewer || !scope?.endsWith(`:${viewer}`)) return;
    void ctx.navigation.open({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) },
      channelId,
      ...(extra.messageId && { messageId: extra.messageId }),
      ...(extra.threadRootId && { threadRootId: extra.threadRootId }),
    });
  };
  ctx.effect(() => {
    let visit: string | undefined;
    const visited = () => {
      const { entry } = ctx.navigation.snapshot();
      if (entry.id === visit) return;
      visit = entry.id;
      interested(1);
    };
    visited();
    return ctx.navigation.subscribe(visited);
  });

  // One reader per connected session, and one index per account in a
  // community: a reconnect resumes the index from its cursors. Signing out,
  // a refusal, or another account or community drops it.
  ctx.effect(() => {
    let current: { key: string; dispose(): void } | undefined;
    let kept: { scope: string; state: FinderState } | undefined;
    const drop = () => {
      current?.dispose();
      current = undefined;
      kept = undefined;
      corpus.clear();
    };
    const sync = () => {
      const snapshot = relay.snapshot();
      const scope = snapshot.scope ?? "";
      if (
        kept &&
        (snapshot.status === "disconnected" ||
          snapshot.denied ||
          (scope && scope !== kept.scope))
      )
        drop();
      const key =
        snapshot.status === "ready" && !snapshot.cached
          ? `${scope}:${snapshot.generation}`
          : "";
      if (key === current?.key) return;
      current?.dispose();
      current = undefined;
      if (!key)
        return set({
          session: undefined,
          status: undefined,
          sync: undefined,
          revision: state.revision + 1,
        });
      if (!kept) kept = { scope, state: createFinderState() };
      const running = startFinderSync({
        session: snapshot.session,
        corpus,
        state: kept.state,
        changed: () =>
          set({ revision: state.revision + 1, status: running.status() }),
        warm: () => (snapshot.scope ? topInterest(snapshot.scope, 24) : []),
      });
      current = { key, dispose: running.dispose };
      set({
        session: snapshot.session,
        status: running.status(),
        sync: running,
        revision: state.revision + 1,
      });
    };
    const stop = relay.subscribe(sync);
    sync();
    return () => {
      stop();
      drop();
    };
  });

  // Both work while Finder is open, so either key switches scope there. A
  // modal on its way out, such as Finder just after Escape, doesn't count.
  const available = () => {
    const modal = activeModal(document);
    return state.open || !modal || modal.hasAttribute("data-closed");
  };
  /** Focus is in a text field, by the shortcut dispatcher's own rule. */
  const typing = () => {
    const focused = document.activeElement as HTMLElement | null;
    return (
      !!focused &&
      (focused.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName) ||
        focused.getAttribute("role") === "textbox")
    );
  };
  ctx.shortcuts.register({
    id: "open",
    title: "Find in this channel",
    binding: { key: "p", mod: true },
    order: 10,
    allowInEditable: true,
    allowInModal: true,
    when: available,
    run: () => show(here()),
  });

  // Finder's own field takes it; other text fields keep ⌘⇧P (the
  // composer's Spoiler), so it's left to them.
  ctx.shortcuts.register({
    id: "all",
    title: "Find in all of Buzz",
    binding: { key: "p", mod: true, shift: true },
    order: 11,
    allowInEditable: true,
    allowInModal: true,
    when: () => state.open || (available() && !typing()),
    run: () => show("buzz"),
  });

  ctx.pages.registerOverlay({
    id: "finder",
    component: function Finder() {
      const { open, revision, session, status, sync, scope } =
        useSyncExternalStore(store.subscribe, store.snapshot);
      const target = useSyncExternalStore(
        ctx.navigation.subscribe,
        ctx.navigation.snapshot,
      ).entry.target;
      const currentChannelId =
        target.kind === "conversation" ? target.channelId : undefined;
      const opened = useRef(false);
      if (open) opened.current = true;
      if (!opened.current) return null;
      const count = corpus.size.toLocaleString();
      return (
        <Suspense fallback={null}>
          <FinderDialog
            open={open}
            onOpenChange={(next) => set({ open: next })}
            corpus={corpus}
            revision={revision}
            session={session}
            sync={sync}
            currentChannelId={currentChannelId}
            scope={scope === "channel" && !currentChannelId ? "buzz" : scope}
            onScopeChange={show}
            status={
              !session ? (
                <p className="px-3 text-body-sm text-subtle">
                  Connect to a community to search your conversations.
                </p>
              ) : status?.phase === "error" ? (
                <p className="px-3 text-body-sm text-subtle" role="alert">
                  Indexing stopped: {status.error}. {count} messages searchable.
                </p>
              ) : status?.phase !== "ready" ? (
                <p className="px-3 text-body-sm text-subtle" aria-live="polite">
                  Indexing your last 90 days… {count} messages so far.
                </p>
              ) : (
                <p className="px-3 text-body-sm text-subtle">
                  {count} messages indexed. Channels you open add theirs.
                </p>
              )
            }
            openMessage={(doc) => {
              const { viewer, scope } = relay.snapshot();
              // The visit adds 1; finding it here is worth more.
              if (viewer && scope?.endsWith(`:${viewer}`))
                noteInterest(scope, doc.channelId, 2);
              openConversation(doc.channelId, {
                messageId: doc.id,
                ...(doc.threadRootId && { threadRootId: doc.threadRootId }),
              });
            }}
          />
        </Suspense>
      );
    },
  });
};
