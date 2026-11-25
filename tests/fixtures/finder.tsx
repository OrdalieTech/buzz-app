// The finder on fake history, with no relay, identity or broker.
// ?extra=200000 adds unsigned synthetic messages to search (their previews
// show nearby signed messages); ?theme=dark switches theme.
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RelayEvent } from "../../src/features/relay/events";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  metadata,
  profile,
  roster,
  signed,
} from "../../src/features/relay/testing";
import {
  createCorpus,
  type FinderDoc,
} from "../../src/bundled/finder/corpus.ts";
import {
  FinderDialog,
  type FinderScope,
} from "../../src/bundled/finder/FinderDialog";
import { startFinderSync } from "../../src/bundled/finder/sync";
import { syntheticDocs } from "./finder-synthetic.ts";

import { queryEvents } from "./finder-data";

import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.colorMode = params.get("theme") ?? "light";

const viewer = keypair();
const relay = keypair();
const people = Array.from({ length: 20 }, () => keypair());
const channels = [
  "eng-infra",
  "release",
  "design-studio",
  "oncall",
  "payments",
  "relay-perf",
  "desktop",
  "growth",
  "help-search",
  "neovim-club",
  "team-mobile",
  "proj-finder",
].map((name, n) => ({ id: `c${n}`, name }));

const started = performance.now();
const sample = syntheticDocs(1500, 7);
const nameOf = new Map<string, string>();
const messages: RelayEvent[] = sample.map((doc, n) => {
  const author =
    n % 9 === 0 ? viewer : (people[n % people.length] as typeof viewer);
  nameOf.set(
    author.pubkey,
    author === viewer ? "Alex Morgan (you)" : doc.author,
  );
  const channel = channels[n % channels.length] as (typeof channels)[number];
  return signed(author, {
    kind: 9,
    content: doc.text,
    created_at: doc.createdAt,
    tags: [["h", channel.id]],
  });
});
// Only the newest 300 start in the index. Search "quartz" in c0 to read back.
const history = Array.from(
  { length: Number(params.get("history") ?? 3000) },
  (_, n) =>
    signed(people[0] as typeof viewer, {
      kind: 9,
      content:
        n >= 2500 ? `Quartz archive notes ${n}` : `Daily channel notes ${n}`,
      created_at: Math.floor(Date.now() / 1000) - n * 3600,
      tags: [["h", "c0"]],
    }),
);
const events: RelayEvent[] = [
  ...history,
  ...messages,
  ...[viewer, ...people].map((key) =>
    profile(key, { name: nameOf.get(key.pubkey) ?? "Someone" }),
  ),
  ...channels.flatMap((channel) => [
    metadata(relay, channel.id, channel.name, 1_700_000_000, [["t", "stream"]]),
    roster(relay, channel.id, [viewer.pubkey, ...people.map((p) => p.pubkey)]),
  ]),
];
console.log(
  `signed ${events.length} events in ${(performance.now() - started).toFixed(0)} ms`,
);

const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: () => undefined,
  async query(filters) {
    return queryEvents(events, filters);
  },
});
const session = owner.session;
void session.channels.ensureList?.();

const corpus = createCorpus();
const channelName = new Map(channels.map((c) => [c.id, `#${c.name}`]));
corpus.add(
  [...messages, ...history.slice(0, 300)].map((event) => ({
    id: event.id,
    channelId: event.tags[0]?.[1] ?? "",
    authorId: event.pubkey,
    createdAt: event.created_at,
    author: nameOf.get(event.pubkey) ?? "Someone",
    place: channelName.get(event.tags[0]?.[1] ?? "") ?? "Conversation",
    text: event.content,
  })),
);
const extra = Number(params.get("extra") ?? 0);
if (extra) {
  const at = performance.now();
  corpus.add(
    syntheticDocs(extra, 3).map((doc, n): FinderDoc => {
      const channel = channels[
        n % channels.length
      ] as (typeof channels)[number];
      return {
        ...doc,
        id: `x${n}`,
        channelId: channel.id,
        place: `#${channel.name}`,
      };
    }),
  );
  console.log(
    `indexed ${extra} extra messages in ${(performance.now() - at).toFixed(0)} ms`,
  );
}

function App() {
  useKeyboardFocusVisibility();
  const [open, setOpen] = useState(true);
  const [opened, setOpened] = useState<FinderDoc>();
  const currentChannelId = params.get("channel") ?? undefined;
  const [scope, setScope] = useState<FinderScope>(
    currentChannelId ? "channel" : "buzz",
  );
  const [revision, setRevision] = useState(0);
  const [sync, setSync] = useState<ReturnType<typeof startFinderSync>>();
  useEffect(() => {
    const running = startFinderSync({
      session,
      corpus,
      changed: () => setRevision((n) => n + 1),
    });
    setSync(running);
    return running.dispose;
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "p" && (event.metaKey || event.ctrlKey)) {
        // As in the app: ⌘P this channel, ⌘⇧P all of Buzz.
        event.preventDefault();
        setScope(event.shiftKey || !currentChannelId ? "buzz" : "channel");
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentChannelId]);
  return (
    <main style={{ padding: "var(--space-panel-inset)", minHeight: "100vh" }}>
      <h1>Finder fixture</h1>
      <p>
        {corpus.size.toLocaleString()} messages indexed. Press ⌘P (Ctrl+P) for
        this channel, ⌘⇧P (Ctrl+Shift+P) for all of Buzz.
      </p>
      {opened && (
        <p>
          Would open <strong>{opened.place}</strong> at “
          {opened.text.slice(0, 80)}”.
        </p>
      )}
      <FinderDialog
        open={open}
        onOpenChange={setOpen}
        corpus={corpus}
        revision={revision}
        session={session}
        sync={sync}
        currentChannelId={currentChannelId}
        scope={scope}
        onScopeChange={setScope}
        openMessage={setOpened}
      />
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
