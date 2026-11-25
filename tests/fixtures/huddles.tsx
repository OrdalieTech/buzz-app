import type { AudioSettingsState } from "../../src/features/huddle/audio-settings";
import { createHuddleRing, HUDDLE_RING } from "../../src/features/huddle/ring";
// Local presentation/capture fixture. No identity, relay connection, or remote write.
import {
  attachmentMessage,
  type UploadedAttachment,
} from "../../src/features/relay/attachments";
import { foldMessages } from "../../src/features/relay/fold";
import { createRoot } from "react-dom/client";
import { useState, useSyncExternalStore } from "react";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { MessageBody } from "../../src/features/conversation/MessageBody";
import { TargetOpenerProvider } from "../../src/features/conversation/opener";
import type {
  ContributionReader,
  MessageRenderer,
} from "../../src/features/conversation/contracts";
import {
  HuddleCard,
  parseHuddleTarget,
} from "../../src/bundled/huddles/HuddleCard";
import { huddleComposerExtensions } from "../../src/bundled/huddles/composer-extensions";
import { HuddlePanel } from "../../src/bundled/huddles/HuddlePanel";
import { Panel } from "../../src/shared/design-system/ui/Panel";
import { HuddleCapsule } from "../../src/bundled/huddles/HuddleCapsule";
import { HuddleWindowView } from "../../src/bundled/huddles/HuddleWindowView";
import { ChannelMembersButton } from "../../src/bundled/channels/ChannelMembersDialog";
import { HuddleLauncher } from "../../src/bundled/huddles/HuddleLauncher";
import { IconButton } from "../../src/shared/design-system/ui/IconButton";
import {
  MagnifyingGlassIcon,
  SlidersHorizontalIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  UserIcon,
  XIcon,
} from "../../src/shared/design-system/icons";
import {
  createHuddleWindow,
  type HuddleView,
  type HuddleWindowAction,
} from "../../src/features/huddle/window";
import { createHuddles } from "../../src/features/huddle/service";
import { openHuddleAudio } from "../../src/features/huddle/audio";
import type {
  HuddleBridge,
  HuddleUpdate,
} from "../../src/features/huddle/bridge";
import { createRelaySession } from "../../src/features/relay/session";
import type {
  ChannelMessage,
  Profile,
} from "../../src/features/relay/contracts";
import type { RelayData } from "../../src/features/relay/service";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

const viewer = "ab".repeat(32),
  peer = "cd".repeat(32);
const destination = {
  scope: `https://fixture.example:${viewer}`,
  relayUrl: "wss://fixture.example",
  viewer,
  channelId: "00000000-0000-4000-8000-000000000001",
  channelName: "Design",
};
const store = createRelaySession(null);
const guestKeys = ["de", "ef", "fa", "bc"].map((key) => key.repeat(32));
const profiles = new Map<string, Profile>([
  [viewer, { name: "Kenneth" }],
  [
    peer,
    {
      name: new URLSearchParams(location.search).has("longCaller")
        ? "Caller".repeat(400)
        : "Alex",
      picture: "https://fixture.example/media/avatar.png",
    },
  ],
  ...guestKeys.map((key, index): [string, Profile] => [
    key,
    { name: ["Sam", "Jo", "Robin", "Taylor"][index] ?? "Guest" },
  ]),
]);
const dmId = "00000000-0000-4000-8000-000000000003";
const channelList = {
  status: "ready" as const,
  channels: [
    {
      id: destination.channelId,
      name: "Design",
      ...(new URLSearchParams(location.search).has("archived")
        ? { archived: true as const }
        : {}),
      channelType: "stream" as const,
      members: [viewer, peer],
    },
    {
      id: dmId,
      name: "Alex",
      channelType: "dm" as const,
      members: [viewer, peer],
    },
  ],
};
const roomId = "00000000-0000-4000-8000-000000000002";
const lifecycleReadError = new URLSearchParams(location.search).has(
  "lifecycleReadError",
);
let lifecycleReadFailed = false;
let startedAt = Math.floor(Date.now() / 1000);
const lifecycleListeners = new Set<() => void>();
let endedAt: number | undefined;
let lifecycleRoom = roomId;
let lifecycleParent = destination.channelId;
let lifecycleCreator = viewer;
const lifecycleEvent = (kind: number, at: number) => ({
  id: String(kind).padStart(64, "0"),
  pubkey: kind === 48101 ? viewer : lifecycleCreator,
  kind,
  created_at: at,
  content: JSON.stringify({ ephemeral_channel_id: lifecycleRoom }),
  tags: [
    ["h", lifecycleParent],
    ["p", lifecycleCreator],
  ],
  sig: "",
});
const legacyRoom = new URLSearchParams(location.search).has("legacyRoom");
const room = {
  id: roomId,
  name: "Huddle",
  huddle: legacyRoom ? undefined : (true as const),
  visibility: "private" as const,
  channelType: "stream" as const,
  get parentChannelId() {
    return legacyRoom ? undefined : lifecycleParent;
  },
  members: [viewer, peer],
};
let discussionRows: ChannelMessage[] = [
  {
    id: "01".repeat(32),
    channelId: roomId,
    authorId: peer,
    createdAt: Math.floor(Date.now() / 1000),
    content: "Let’s keep our notes here while we talk.",
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
  },
];
const discussionListeners = new Set<() => void>();
const session = {
  ...store.session,
  scope: destination.scope,
  viewer,
  relayAuthor: viewer,
  observe: () => ({
    snapshot: () => ({
      status: lifecycleReadError
        ? lifecycleReadFailed
          ? ("error" as const)
          : ("loading" as const)
        : ("ready" as const),
      events: [
        lifecycleEvent(48100, startedAt),
        lifecycleEvent(48101, startedAt),
        ...(endedAt ? [lifecycleEvent(48103, endedAt)] : []),
      ],
    }),
    subscribe: (fn: () => void) => {
      lifecycleListeners.add(fn);
      return () => {
        lifecycleListeners.delete(fn);
      };
    },
    refresh: async () => {
      if (lifecycleReadError) {
        lifecycleReadFailed = true;
        for (const listener of lifecycleListeners) listener();
      }
    },
    dispose: () => {},
  }),
  channels: {
    ...store.session.channels,
    list: () => channelList,
    get: (id: string) =>
      id === roomId
        ? { ...room, ...(endedAt ? { archived: true as const } : {}) }
        : channelList.channels.find((c) => c.id === id),
    resolve: async () => {},
    ensure: () => {},
    window: (id: string) =>
      id === roomId
        ? {
            channelId: id,
            status: "ready" as const,
            rows: discussionRows,
            hasMore: false,
            loadingOlder: false,
            error: undefined,
          }
        : store.session.channels.window(id),
    subscribeWindow: (id: string, listener: () => void) => {
      if (id !== roomId)
        return store.session.channels.subscribeWindow(id, listener);
      discussionListeners.add(listener);
      return () => {
        discussionListeners.delete(listener);
      };
    },
  },
  profiles: {
    ...store.session.profiles,
    snapshot: () => profiles,
    ensure: async () => {},
  },
  attachments: {
    async upload(file: File, _room: string, signal: AbortSignal) {
      stats.uploadWaiting += 1;
      await uploadGate;
      signal.throwIfAborted();
      const text = await file.text();
      stats.uploads.push({ name: file.name, text });
      const sha256 = stats.uploads.length.toString(16).padStart(64, "0");
      return {
        name: file.name,
        url: `https://fixture.example/media/${sha256}${file.type.startsWith("image/") ? ".png" : ""}`,
        type: file.type,
        size: file.size,
        sha256,
      };
    },
  },
  messages: {
    ...store.session.messages,
    send: (
      id: string,
      text: string,
      mentions: readonly string[] = [],
      attachments: readonly UploadedAttachment[] = [],
    ) => {
      if (text.includes("reject this message"))
        throw new Error("Fixture rejected this message. Your draft is kept.");
      stats.sent.push({ text, mentions, attachments });
      const messageId = String(discussionRows.length + 1).padStart(64, "0");
      const message = attachmentMessage(
        text,
        attachments,
        "https://fixture.example",
      );
      discussionRows = [
        ...discussionRows,
        ...foldMessages(id, "", [
          {
            id: messageId,
            pubkey: viewer,
            created_at: Math.floor(Date.now() / 1000),
            kind: 9,
            content: message.content,
            tags: [
              ["h", id],
              ...message.tags,
              ...mentions.map((key) => ["p", key]),
            ],
          },
        ]),
      ];
      for (const listener of discussionListeners) listener();
      return messageId;
    },
  },
  read: async () => (legacyRoom ? [lifecycleEvent(48101, startedAt)] : []),
  media: (url: string) =>
    url.startsWith("https://fixture.example/media/") && url.endsWith(".png")
      ? "/tests/fixtures/design-system/assets/avatar.png"
      : url,
};
const snapshot = {
  status: "ready" as const,
  generation: 1,
  viewer,
  scope: destination.scope,
  session,
};
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  async clearCache() {},
};
let uploadGate: Promise<void> | undefined;
let releaseUpload: (() => void) | undefined;
let receive = (_: HuddleUpdate) => {};
const stats = {
  uploadWaiting: 0,
  layoutWaiting: 0,
  uploads: [] as { name: string; text: string }[],
  sent: [] as {
    text: string;
    mentions: readonly string[];
    attachments: readonly UploadedAttachment[];
  }[],
  opens: 0,
  closes: 0,
  frames: 0,
  lastFrameLength: 0,
  audioClosed: 0,
  audioOpened: 0,
  ringPlays: 0,
  // Every raw `playing` event, diagnostic only: ringPlays is what tests assert.
  ringPlayingEvents: 0,
  ringEnds: 0,
  ringPaused: 0,
};
let connect = () => {};
const deferConnection = new URLSearchParams(location.search).has(
  "deferConnection",
);
const bridge: HuddleBridge = {
  available: true,
  async open(_id, context, _room, fn) {
    lifecycleParent = context.channelId;
    endedAt = undefined;
    stats.opens++;
    receive = fn;
    connect = () =>
      fn({
        type: "connected",
        room: "00000000-0000-4000-8000-000000000002",
        participants: [viewer, peer],
      });
    if (!deferConnection) connect();
  },
  async close() {
    stats.closes++;
    // Local departure cannot end a room still owned by the incoming caller.
    if (lifecycleCreator !== peer) endedAt = Math.floor(Date.now() / 1000);
    for (const listener of lifecycleListeners) listener();
  },
  async touch() {},
  async send(_id, samples) {
    stats.frames++;
    stats.lastFrameLength = samples.length;
  },
};
const realAudio = new URLSearchParams(location.search).has("audio");
const huddles = createHuddles(relay, bridge, async (...args) => {
  stats.audioOpened++;
  let deviceState: AudioSettingsState = {
    inputs: [
      { id: "built-in", label: "MacBook microphone" },
      { id: "usb", label: "USB microphone" },
    ],
    outputs: [
      { id: "built-in", label: "MacBook speakers" },
      { id: "headphones", label: "Headphones" },
    ],
    input: "",
    output: "",
    outputSupported: true,
    busy: false,
    loading: false,
  };
  const deviceListeners = new Set<() => void>();
  const settings = {
    snapshot: () => deviceState,
    subscribe(fn: () => void) {
      deviceListeners.add(fn);
      return () => {
        deviceListeners.delete(fn);
      };
    },
    async refresh() {},
    async select(kind: "input" | "output", id: string) {
      deviceState = { ...deviceState, [kind]: id };
      for (const fn of deviceListeners) fn();
    },
    close() {
      deviceListeners.clear();
    },
  };
  const audio = realAudio
    ? await openHuddleAudio(...args)
    : {
        settings,
        mute() {},
        play() {},
        participants() {},
        close() {
          settings.close();
        },
      };
  return {
    ...audio,
    close() {
      stats.audioClosed++;
      audio.close();
    },
  };
});
const stopRing = createHuddleRing(huddles, () => {
  const audio = new Audio(HUDDLE_RING);
  // Count clip starts, not `playing` events. `playing` also fires whenever one
  // clip resumes after its ready state dips (`waiting`), which WebKit's media
  // pipeline can do while it prerolls on a loaded machine. `play` marks each
  // new play() from a paused clip, so only its first `playing` counts.
  //
  // Restarting a clip that is already playing (seek to zero, then play())
  // emits no `play`, and WebKit emits no `playing` for it either, so `seeking`
  // counts that one. Each repeat also seeks to zero, from the ended clip, and
  // WebKit reports that seek after the repeat's `playing`; `rewinding` skips
  // it so a repeat still counts once.
  let started = false;
  let rewinding = false;
  audio.addEventListener("play", () => {
    started = false;
  });
  audio.addEventListener("playing", () => {
    stats.ringPlayingEvents++;
    if (started) return;
    started = true;
    stats.ringPlays++;
  });
  audio.addEventListener("seeking", () => {
    if (rewinding) rewinding = false;
    else if (started && !audio.paused && audio.currentTime === 0)
      stats.ringPlays++;
  });
  audio.addEventListener("ended", () => {
    rewinding = true;
    stats.ringEnds++;
  });
  audio.addEventListener("pause", () => {
    stats.ringPaused++;
  });
  return audio;
});
let windowView: HuddleView | null = null;
let windowWidth = 520;
let layoutGate: Promise<void> | undefined;
let releaseLayout = () => {};
let fixedWindow = false;
const windowListeners = new Set<() => void>();
const setWindowView = (view: HuddleView | null) => {
  windowView = view;
  for (const listener of windowListeners) listener();
};
let windowAction = (
  _id: string,
  _action: HuddleWindowAction,
  _text?: string,
) => {};
const composerExtensions = huddleComposerExtensions({
  tools: ["buzz.emoji/picker", "buzz.mentions/picker"],
  completions: ["buzz.emoji/typeahead", "buzz.mentions/typeahead"],
});
const companion = createHuddleWindow(
  huddles,
  relay,
  {
    async open(view, act) {
      windowAction = act;
      setWindowView(view);
    },
    async update(id, view) {
      if (windowView?.id !== id) return;
      if (!!windowView.discussion !== !!view?.discussion) {
        if (!fixedWindow) windowWidth = view?.discussion ? 880 : 520;
        for (const listener of windowListeners) listener();
        if (layoutGate) {
          stats.layoutWaiting++;
          await layoutGate;
        }
      }
      setWindowView(view);
    },
  },
  composerExtensions,
);
const closeWindow = () => {
  const id = windowView?.id;
  setWindowView(null);
  if (id) windowAction(id, "closed");
};
declare global {
  interface Window {
    huddleFixture: {
      stats: typeof stats;
      connect(): void;
      request(room?: string): void;
      holdUpload(): void;
      releaseUpload(): void;
      holdLayout(): void;
      releaseLayout(): void;
      fixedWindow(value: boolean): void;
      participants(keys: string[]): void;
      speak(peer: string, level?: number): void;
      disconnect(error?: string): void;
      dispose(): Promise<void>;
    };
  }
}
window.huddleFixture = {
  holdUpload() {
    uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
  },
  releaseUpload() {
    releaseUpload?.();
    uploadGate = undefined;
  },
  stats,
  connect: () => connect(),
  request: (room = roomId) => {
    lifecycleRoom = room;
    // A newly simulated call starts now, after the request watcher activated.
    startedAt = Math.floor(Date.now() / 1000);
    lifecycleParent = dmId;
    lifecycleCreator = peer;
    endedAt = undefined;
    for (const fn of lifecycleListeners) fn();
  },
  holdLayout: () => {
    layoutGate = new Promise((resolve) => {
      releaseLayout = resolve;
    });
  },
  releaseLayout: () => {
    releaseLayout();
    layoutGate = undefined;
  },
  fixedWindow: (value) => {
    fixedWindow = value;
  },
  speak: (peer, level = 0.06) =>
    receive({ type: "audio", peer, samples: Array(960).fill(level) }),
  participants: (participants) =>
    receive({ type: "participants", participants }),
  disconnect: (error = "Huddle disconnected. You can join again.") =>
    receive({ type: "ended", error }),
  dispose: async () => {
    stopRing();
    await huddles.dispose();
    await companion.dispose();
  },
};
const cardRenderers = [
  {
    id: "huddle",
    title: "Huddle",
    key: "buzz.huddles/huddle",
    pluginId: "buzz.huddles",
    revision: "fixture",
    matches: (message: ChannelMessage) => !!message.huddle,
    component: ({
      message,
      open,
    }: {
      message: ChannelMessage;
      open?: ((target: string) => boolean) | undefined;
    }) => (
      <HuddleCard
        message={message}
        open={open}
        relay={relay}
        huddles={huddles}
        showWindow={companion.open}
      />
    ),
  },
];
const cardRegistry: ContributionReader<MessageRenderer> = {
  snapshot: () => cardRenderers,
  subscribe: () => () => {},
};
function Fixture() {
  useKeyboardFocusVisibility();
  useSyncExternalStore(
    (listener) => {
      windowListeners.add(listener);
      return () => {
        windowListeners.delete(listener);
      };
    },
    () => windowWidth,
  );
  const [dm, setDm] = useState(false);
  const [chatTarget, setChatTarget] = useState<string>();
  const [membersOpen, setMembersOpen] = useState(false);
  const view = useSyncExternalStore(
    (listener) => {
      windowListeners.add(listener);
      return () => {
        windowListeners.delete(listener);
      };
    },
    () => windowView,
  );
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--surface-base)",
        padding: 24,
      }}
    >
      <p className="text-caption text-secondary">
        Huddles fixture ·{" "}
        {realAudio ? "local microphone capture" : "simulated call"} · no relay
      </p>
      {
        <header
          className="shell-header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
            height: 48,
          }}
        >
          <IconButton
            variant="chrome"
            aria-label="Go back"
            icon={<ArrowLeftIcon size={16} />}
          />
          <IconButton
            variant="chrome"
            aria-label="Go forward"
            icon={<ArrowRightIcon size={16} />}
          />
          <HuddleCapsule
            huddles={huddles}
            relay={relay}
            companion={companion}
          />
          <IconButton
            variant="chrome"
            aria-label="Search Buzz"
            icon={<MagnifyingGlassIcon size={16} />}
          />
          <IconButton
            variant="avatar"
            aria-label="Your profile"
            icon={<UserIcon size={16} />}
          />
        </header>
      }
      {view && (
        <aside
          aria-label="Huddle window preview"
          style={{
            width: windowWidth,
            maxWidth: "100%",
            height: 560,
            margin: "24px 0",
            marginLeft: "max(0px, calc((100% - 880px) / 2))",
            border: "1px solid var(--border-standard)",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div style={{ position: "absolute", left: 8, top: 8, zIndex: 2 }}>
            <IconButton
              size="toolbar"
              variant="ghost"
              aria-label="Close Huddle window"
              onClick={closeWindow}
              icon={<XIcon size={16} />}
            />
          </div>
          <HuddleWindowView
            view={view}
            act={(action, text) => windowAction(view.id, action, text)}
          />
        </aside>
      )}
      <section
        aria-label="Conversation"
        style={{
          marginTop: 24,
          minHeight: 220,
          background: "var(--surface-panel)",
          color: "var(--text-standard)",
        }}
      >
        {foldMessages(destination.channelId, lifecycleCreator, [
          lifecycleEvent(48100, startedAt),
          ...(endedAt ? [lifecycleEvent(48103, endedAt)] : []),
        ]).map((message) => (
          <TargetOpenerProvider
            key={message.id}
            canOpen={(target) => !!parseHuddleTarget(target)}
            open={(target) => {
              setChatTarget(target);
              return true;
            }}
          >
            <MessageBody registry={cardRegistry} message={message}>
              Huddle started
            </MessageBody>
          </TargetOpenerProvider>
        ))}
        {chatTarget && (
          <aside
            aria-label="Saved Huddle conversation"
            style={{ height: 440, maxWidth: 420 }}
          >
            <Panel style={{ height: "100%" }}>
              <HuddlePanel
                target={chatTarget}
                close={() => setChatTarget(undefined)}
                relay={relay}
                channelContext={destination}
              />
            </Panel>
          </aside>
        )}
        <header
          style={{ display: "flex", alignItems: "center", gap: 4, padding: 12 }}
        >
          <h2 className="text-label text-primary" style={{ flex: 1 }}>
            {dm ? "Alex" : "Design"}
          </h2>
          <ChannelMembersButton
            session={session}
            channelId={dm ? dmId : destination.channelId}
            open={membersOpen}
            onOpenChange={setMembersOpen}
          />
          <HuddleLauncher
            relay={relay}
            context={{
              ...destination,
              channelId: dm ? dmId : destination.channelId,
              channelName: dm ? "Alex" : "Design",
            }}
            available={() => true}
            openMembers={() => setMembersOpen(true)}
            huddles={huddles}
            showWindow={companion.open}
          />
          <IconButton
            size="toolbar"
            aria-label="Channel settings"
            icon={<SlidersHorizontalIcon size={16} />}
          />
        </header>
        <p className="text-body text-secondary" style={{ padding: 12 }}>
          The conversation stays open while you talk.
        </p>
        <Button variant="ghost" onClick={() => window.huddleFixture.request()}>
          Simulate incoming DM Huddle
        </Button>
        <Button variant="ghost" onClick={() => setDm((value) => !value)}>
          Switch conversation
        </Button>
        {call.phase === "connected" && (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                let frames = 0;
                const speech = setInterval(() => {
                  if (
                    huddles.snapshot().phase !== "connected" ||
                    frames++ >= 30
                  ) {
                    clearInterval(speech);
                    return;
                  }
                  window.huddleFixture.speak(
                    peer,
                    0.035 + Math.abs(Math.sin(frames / 3)) * 0.08,
                  );
                }, 100);
              }}
            >
              Simulate Alex speaking
            </Button>
            <Button
              variant="ghost"
              disabled={guestKeys.every((key) =>
                call.participants.includes(key),
              )}
              onClick={() => {
                const next = guestKeys.find(
                  (key) => !call.participants.includes(key),
                );
                if (next)
                  window.huddleFixture.participants([
                    ...call.participants,
                    next,
                  ]);
              }}
            >
              Simulate someone joining
            </Button>
            <Button
              variant="ghost"
              disabled={call.participants.length <= 2}
              onClick={() =>
                window.huddleFixture.participants(
                  call.participants.slice(0, -1),
                )
              }
            >
              Simulate someone leaving
            </Button>
            <Button
              variant="ghost"
              onClick={() => window.huddleFixture.disconnect()}
            >
              Simulate connection failure
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <ToastProvider>
      <Fixture />
    </ToastProvider>,
  );
