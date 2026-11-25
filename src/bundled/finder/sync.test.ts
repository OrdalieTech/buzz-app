import { afterEach, expect, test, vi } from "vitest";
import { queryEvents } from "../../../tests/fixtures/finder-data";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { createCorpus } from "./corpus";
import {
  type ChannelSearchStatus,
  createFinderState,
  startFinderSync,
} from "./sync";

const viewer = keypair();
const author = keypair();
const relay = keypair();
// Ten real pages are necessary to prove the 5,000-message cap. Equal
// timestamps also prove that the cursor does not skip or repeat ties.
const history = Array.from({ length: 5001 }, (_, n) =>
  message(author, "crew", `Archive note ${n}`, 1_700_000_000),
);
const discovery = [
  metadata(relay, "crew", "crew"),
  roster(relay, "crew", [viewer.pubkey, author.pubkey]),
  metadata(relay, "lab", "lab"),
  roster(relay, "lab", [viewer.pubkey, author.pubkey]),
  // Readable but not joined: its messages stay out of the index.
  metadata(relay, "away", "away"),
  roster(relay, "away", [author.pubkey]),
];
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(
  messages = history,
  { warm, settle = true }: { warm?: () => string[]; settle?: boolean } = {},
) {
  const reads: Parameters<typeof queryEvents>[1][number][] = [];
  // Every channel-history read, by channel, never reset.
  const channelReads: Parameters<typeof queryEvents>[1][number][] = [];
  const control = { failures: 0, latency: 0 };
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    async query(filters) {
      for (const filter of filters) {
        if (filter["#h"]?.includes("crew") && filter.kinds?.includes(9))
          reads.push(filter);
        if (filter["#h"]?.length === 1 && filter.kinds?.includes(9))
          channelReads.push(filter);
      }
      if (
        filters.some(
          (filter) =>
            filter["#h"]?.includes("crew") && filter.kinds?.includes(9),
        ) &&
        control.failures > 0
      ) {
        control.failures--;
        throw new Error("History unavailable");
      }
      if (control.latency)
        await new Promise((resolve) => setTimeout(resolve, control.latency));
      return queryEvents([...discovery, ...messages], filters);
    },
  });
  dispose.push(owner.dispose);
  await owner.session.channels.ensureList();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  const sync = startFinderSync({
    session: owner.session,
    corpus,
    changed() {},
    ...(warm && { warm }),
  });
  dispose.push(sync.dispose);
  if (settle) {
    // Complete the separate initial account fill before counting scope reads.
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync.status().phase).toBe("ready");
    reads.length = 0;
  }
  return { corpus, sync, reads, channelReads, control, owner };
}

test("reads ten pages, keeps its cursor and budget across edits and scope switches, and resumes on Keep going", async () => {
  const { corpus, sync, reads } = await fixture();
  let progress: ChannelSearchStatus | undefined;
  let query = "quartz";
  const opening = {};
  let reader = sync.searchChannel(
    "crew",
    () => corpus.search(query, 20, "crew").total < 20,
    (status) => {
      progress = status;
    },
    opening,
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(300);
  expect(reads).toHaveLength(2);
  query = "missing";
  reader.wake();
  await vi.advanceTimersByTimeAsync(3000);
  expect(reads).toHaveLength(10);
  expect(corpus.size).toBe(5000);
  expect(progress).toMatchObject({
    capped: true,
    complete: false,
    loading: false,
    oldest: 1_700_000_000,
  });
  reader.dispose();
  reader = sync.searchChannel(
    "crew",
    () => true,
    (status) => {
      progress = status;
    },
    opening,
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(10);
  expect(progress?.capped).toBe(true);
  reader.keepGoing();
  await vi.advanceTimersByTimeAsync(300);
  expect(reads).toHaveLength(11);
  expect(corpus.size).toBe(5001);
  expect(progress).toMatchObject({ complete: true, loading: false });
  reader.dispose();
  const reopened = sync.searchChannel(
    "crew",
    () => true,
    () => {},
  );
  dispose.push(reopened.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(11);
});

test("stops when enough match, cancels on close, and reopens at the next page", async () => {
  const { corpus, sync, reads } = await fixture(history.slice(0, 1001));
  let query = "archive";
  const reader = sync.searchChannel(
    "crew",
    () => corpus.search(query, 20, "crew").total < 20,
    () => {},
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toHaveLength(1);
  expect(corpus.size).toBe(500);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(1);
  query = "quartz";
  reader.wake();
  reader.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(1);
  let progress: ChannelSearchStatus | undefined;
  const reopened = sync.searchChannel(
    "crew",
    () => true,
    (status) => {
      progress = status;
    },
  );
  dispose.push(reopened.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(3);
  expect(corpus.size).toBe(1001);
  expect(progress?.complete).toBe(true);
});

test("retries the same older page with capped backoff and recovers without losing messages", async () => {
  const { corpus, sync, reads, control } = await fixture(history.slice(0, 501));
  let progress: ChannelSearchStatus | undefined;
  const reader = sync.searchChannel(
    "crew",
    () => true,
    (status) => {
      progress = status;
    },
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(0);
  expect(corpus.size).toBe(500);
  control.failures = 7;
  await vi.advanceTimersByTimeAsync(300);
  expect(progress?.error).toBe(true);
  expect(reads).toHaveLength(2);
  const cursor = reads[1]?.before_id;
  for (const [index, delay] of [
    2000, 4000, 8000, 16000, 32000, 60000, 60000,
  ].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(reads).toHaveLength(index + 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveLength(index + 3);
    expect(reads.at(-1)?.before_id).toBe(cursor);
  }
  expect(progress).toMatchObject({
    complete: true,
    error: false,
    loading: false,
  });
  expect(corpus.size).toBe(501);
});

test("reads ahead the newest pages of wanted channels and shares the cursor with This channel", async () => {
  const lab = Array.from({ length: 600 }, (_, n) =>
    message(author, "lab", `Lab note ${n}`, 1_700_000_000),
  );
  const away = [message(author, "away", "Away note", 1_700_000_000)];
  const crew = history.slice(0, 1400);
  const { corpus, sync, channelReads, control } = await fixture(
    [...crew, ...lab, ...away],
    { warm: () => ["away", "crew", "lab"], settle: false },
  );
  const of = (id: string) => channelReads.filter((f) => f["#h"]?.[0] === id);
  // The fill is done and the first read-ahead page is waiting on its pace.
  await vi.advanceTimersByTimeAsync(300);
  expect(sync.status().phase).toBe("ready");
  expect(channelReads).toHaveLength(0);
  // Slow pages keep This channel's first read open while the read-ahead
  // reaches the same channel.
  control.latency = 400;
  const reader = sync.searchChannel(
    "crew",
    () => true,
    () => {},
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(20_000);
  // Three pages cover crew; no page was read twice or skipped.
  expect(of("crew")).toHaveLength(3);
  expect(new Set(of("crew").map((f) => f.before_id)).size).toBe(3);
  expect(corpus.search("note", 1, "crew").total).toBe(1400);
  // Lab gets its newest page only; away was never read.
  expect(of("lab")).toHaveLength(1);
  expect(of("away")).toHaveLength(0);
  expect(corpus.size).toBe(1900);
});

test("reads ahead one page in each of at most 16 channels", async () => {
  const ids = Array.from({ length: 18 }, (_, n) => `room${n}`);
  const rooms = ids.flatMap((id) => [
    metadata(relay, id, id),
    roster(relay, id, [viewer.pubkey, author.pubkey]),
    message(author, id, `${id} note`, 1_700_000_000),
  ]);
  const { channelReads } = await fixture(rooms, {
    warm: () => ids,
    settle: false,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(channelReads.map((filter) => filter["#h"]?.[0])).toEqual(
    ids.slice(0, 16),
  );
});

test("a deletion removes its message, now and from pages read later, only by deletions that apply", async () => {
  const now = Math.floor(Date.now() / 1000);
  const live = message(author, "crew", "Live quartz", now - 10);
  const kept = message(author, "lab", "Kept quartz", now - 10);
  const older = message(author, "crew", "Older quartz", 1_700_000_000);
  const stranger = keypair();
  const deletions = [
    signed(author, {
      kind: 5,
      content: "",
      created_at: now,
      tags: [
        ["h", "crew"],
        ["e", live.id],
        ["k", "9"],
      ],
    }),
    signed(author, {
      kind: 5,
      content: "",
      created_at: now,
      tags: [
        ["h", "crew"],
        ["e", older.id],
        ["k", "9"],
      ],
    }),
    // Neither the author's nor naming a message kind: it removes nothing.
    signed(stranger, {
      kind: 5,
      content: "",
      created_at: now,
      tags: [
        ["h", "lab"],
        ["e", kept.id],
      ],
    }),
  ];
  const { corpus, sync, owner } = await fixture([
    live,
    kept,
    older,
    ...deletions,
  ]);
  const found = () =>
    corpus
      .search("quartz")
      .hits.map(({ doc }) => doc.text)
      .sort();
  await owner.session.read([{ ids: [live.id, kept.id], limit: 2 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Kept quartz", "Live quartz"]);
  await owner.session.read([{ kinds: [5], limit: 10 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Kept quartz"]);
  // The app received the older message with its deletion, then a page of
  // history brings it again.
  await owner.session.read([
    { ids: [older.id], limit: 1 },
    { kinds: [5], "#e": [older.id], limit: 1 },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(found()).toEqual(["Kept quartz"]);
  const reader = sync.searchChannel(
    "crew",
    () => true,
    () => {},
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(found()).toEqual(["Kept quartz"]);
  // Nor can a relay search hit held by Finder.
  sync.remember([
    {
      id: older.id,
      channelId: "crew",
      authorId: author.pubkey,
      createdAt: older.created_at,
      author: "Sam",
      place: "#crew",
      text: older.content,
    },
  ]);
  expect(found()).toEqual(["Kept quartz"]);
});

test("a reconnect keeps the index and reads only what is newer, then the pages it hadn't reached", async () => {
  const now = Math.floor(Date.now() / 1000);
  const mine = Array.from({ length: 1200 }, (_, n) =>
    message(viewer, "crew", `Mine ${n}`, now - 3600 - n),
  );
  const events = [...discovery, ...mine];
  const reads: { since?: number; before_id?: string }[] = [];
  const connect = async () => {
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      async query(filters) {
        for (const filter of filters)
          if (
            filter.authors?.includes(viewer.pubkey) &&
            filter.kinds?.includes(9)
          )
            reads.push(filter);
        return queryEvents(events, filters);
      },
    });
    dispose.push(owner.dispose);
    await owner.session.channels.ensureList();
    return owner;
  };
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  const state = createFinderState();
  let owner = await connect();
  let sync = startFinderSync({
    session: owner.session,
    corpus,
    state,
    changed() {},
  });
  // Only the newest page before the connection drops.
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toHaveLength(1);
  sync.dispose();
  owner.dispose();
  expect(corpus.size).toBe(500);
  events.push(message(viewer, "crew", "Mine while away", now + 60));
  reads.length = 0;
  owner = await connect();
  sync = startFinderSync({
    session: owner.session,
    corpus,
    state,
    changed() {},
  });
  dispose.push(sync.dispose);
  await vi.advanceTimersByTimeAsync(5000);
  expect(sync.status().phase).toBe("ready");
  // One page newer than the first read, then the two older ones it hadn't
  // reached, from its cursor.
  expect(reads).toHaveLength(3);
  expect(reads[0]?.since).toBeGreaterThanOrEqual(now - 300);
  expect(reads[0]?.before_id).toBeUndefined();
  expect(reads[1]?.before_id).toBe(mine[499]?.id);
  expect(corpus.size).toBe(1201);
  // A later reconnect reads only the newer page.
  sync.dispose();
  owner.dispose();
  reads.length = 0;
  owner = await connect();
  sync = startFinderSync({
    session: owner.session,
    corpus,
    state,
    changed() {},
  });
  dispose.push(sync.dispose);
  await vi.advanceTimersByTimeAsync(5000);
  expect(reads).toHaveLength(1);
  expect(corpus.size).toBe(1201);
});

test("a reconnect catches read-ahead channels up on what was posted while away", async () => {
  const now = Math.floor(Date.now() / 1000);
  const events = [
    ...discovery,
    ...Array.from({ length: 600 }, (_, n) =>
      message(author, "crew", `Crew note ${n}`, now - 3600 - n),
    ),
  ];
  const reads: { since?: number; before_id?: string }[] = [];
  const connect = async () => {
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      async query(filters) {
        for (const filter of filters)
          if (filter["#h"]?.[0] === "crew" && filter.kinds?.includes(9))
            reads.push(filter);
        return queryEvents(events, filters);
      },
    });
    dispose.push(owner.dispose);
    await owner.session.channels.ensureList();
    return owner;
  };
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  const state = createFinderState();
  const run = async () => {
    const owner = await connect();
    const sync = startFinderSync({
      session: owner.session,
      corpus,
      state,
      changed() {},
      warm: () => ["crew"],
    });
    await vi.advanceTimersByTimeAsync(5000);
    sync.dispose();
    owner.dispose();
  };
  await run();
  expect(reads).toHaveLength(1);
  expect(corpus.search("away", 50, "crew").total).toBe(0);
  // This fixture has no live replay, so only Finder's own read finds them.
  events.push(
    ...Array.from({ length: 3 }, (_, n) =>
      message(author, "crew", `Posted while away ${n}`, now + 60),
    ),
  );
  reads.length = 0;
  await run();
  expect(reads).toHaveLength(1);
  expect(reads[0]?.since).toBeGreaterThanOrEqual(now - 300);
  expect(reads[0]?.before_id).toBeUndefined();
  expect(corpus.search("away", 50, "crew").total).toBe(3);
});

test("keeps old messages the app receives; the fill reads only 90 days", async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = message(author, "crew", "Old quartz", now - 120 * 86_400);
  const mine = message(viewer, "crew", "My old quartz", now - 120 * 86_400);
  const { corpus, owner } = await fixture([old, mine]);
  expect(corpus.search("quartz").total).toBe(0);
  await owner.session.read([{ ids: [old.id], limit: 1 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(corpus.search("quartz").hits.map(({ doc }) => doc.text)).toEqual([
    "Old quartz",
  ]);
});

test("paces every history read, across filters and after a reconnect", async () => {
  // Three chunks of direct messages, each one short page.
  const dms = Array.from({ length: 120 }, (_, n) => `dm${n}`).flatMap((id) => [
    metadata(relay, id, "", 1_700_000_000, [["t", "dm"]]),
    roster(relay, id, [viewer.pubkey, author.pubkey]),
  ]);
  const times: number[] = [];
  const connect = async () => {
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      async query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(9)))
          times.push(Date.now());
        return queryEvents([...discovery, ...dms], filters);
      },
    });
    dispose.push(owner.dispose);
    await owner.session.channels.ensureList();
    return owner;
  };
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  const state = createFinderState();
  const run = async () => {
    times.length = 0;
    const owner = await connect();
    const sync = startFinderSync({
      session: owner.session,
      corpus,
      state,
      changed() {},
    });
    dispose.push(sync.dispose);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync.status().phase).toBe("ready");
    sync.dispose();
    owner.dispose();
    // Your messages, mentions and three chunks of direct messages.
    expect(times).toHaveLength(5);
    for (let n = 1; n < times.length; n++)
      expect(
        (times[n] as number) - (times[n - 1] as number),
      ).toBeGreaterThanOrEqual(300);
  };
  await run();
  // A reconnect resumes every filter.
  await run();
});

test.each([
  ["after", false],
  ["with", true],
])(
  "a deletion the app received %s its message, before Finder started, keeps it out",
  async (_, together) => {
    const now = Math.floor(Date.now() / 1000);
    const gone = message(author, "crew", "Gone quartz", now - 10);
    const kept = message(author, "crew", "Kept quartz", now - 10);
    const deletion = signed(author, {
      kind: 5,
      content: "",
      created_at: now,
      tags: [
        ["h", "crew"],
        ["e", gone.id],
        ["k", "9"],
      ],
    });
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async (filters) =>
        queryEvents([...discovery, gone, kept, deletion], filters),
    });
    dispose.push(owner.dispose);
    await owner.session.channels.ensureList();
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    // Let the channel list settle, as the app does before you search.
    await vi.advanceTimersByTimeAsync(1000);
    const messages = { ids: [gone.id, kept.id], limit: 2 };
    const deletions = { kinds: [5], limit: 10 };
    if (together) await owner.session.read([messages, deletions]);
    else {
      await owner.session.read([messages]);
      await owner.session.read([deletions]);
    }
    const corpus = createCorpus();
    const sync = startFinderSync({
      session: owner.session,
      corpus,
      changed() {},
    });
    dispose.push(sync.dispose);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync.status().phase).toBe("ready");
    expect(corpus.search("quartz").hits.map(({ doc }) => doc.text)).toEqual([
      "Kept quartz",
    ]);
  },
);

test("losing a channel drops its messages; rejoining reads its history again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = message(viewer, "lab", "Old lab quartz", now - 86_400);
  const other = message(viewer, "crew", "Crew quartz", now - 86_400);
  const reads: { "#h"?: readonly string[] }[] = [];
  const connect = async (member: boolean) => {
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      async query(filters) {
        for (const filter of filters)
          if (
            filter.authors?.includes(viewer.pubkey) &&
            filter.kinds?.includes(9)
          )
            reads.push(filter);
        const lab = [
          metadata(relay, "lab", "lab"),
          roster(relay, "lab", member ? [viewer.pubkey] : [author.pubkey]),
        ];
        // The relay withholds the channel's messages while access is gone.
        const events = [other, ...lab, ...(member ? [old] : [])];
        return queryEvents([...discovery.slice(0, 2), ...events], filters);
      },
    });
    dispose.push(owner.dispose);
    await owner.session.channels.ensureList();
    return owner;
  };
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  const state = createFinderState();
  const found = () =>
    corpus
      .search("quartz")
      .hits.map(({ doc }) => doc.text)
      .sort();
  const run = async (member: boolean) => {
    const owner = await connect(member);
    const sync = startFinderSync({
      session: owner.session,
      corpus,
      state,
      changed() {},
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync.status().phase).toBe("ready");
    sync.dispose();
    owner.dispose();
  };
  await run(true);
  expect(found()).toEqual(["Crew quartz", "Old lab quartz"]);
  await run(false);
  expect(found()).toEqual(["Crew quartz"]);
  reads.length = 0;
  await run(true);
  expect(found()).toEqual(["Crew quartz", "Old lab quartz"]);
  // Only the rejoined channel is read from the start.
  expect(reads.filter((filter) => !filter["#h"])).toHaveLength(1);
  expect(reads.filter((filter) => filter["#h"]?.[0] === "lab")).toHaveLength(1);
});

test("losing one direct message of a 50-message chunk resets that chunk's fill", async () => {
  const now = Math.floor(Date.now() / 1000);
  const ids = Array.from(
    { length: 60 },
    (_, n) => `dm${String(n).padStart(2, "0")}`,
  );
  const said = message(author, "dm07", "Direct quartz", now - 86_400);
  const rooms = (member: boolean) =>
    ids.flatMap((id) => [
      metadata(relay, id, "", 1_700_000_000, [["t", "dm"]]),
      roster(
        relay,
        id,
        member || id !== "dm07"
          ? [viewer.pubkey, author.pubkey]
          : [author.pubkey],
      ),
    ]);
  const joined = rooms(true);
  const left = rooms(false);
  const reads: { "#h"?: readonly string[]; since?: number }[] = [];
  const connect = async (member: boolean) => {
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      async query(filters) {
        for (const filter of filters)
          if ((filter["#h"]?.length ?? 0) > 1) reads.push(filter);
        // The relay withholds the channel's messages while access is gone.
        const events = [...discovery, ...(member ? [...joined, said] : left)];
        return queryEvents(events, filters);
      },
    });
    dispose.push(owner.dispose);
    await owner.session.channels.ensureList();
    return owner;
  };
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  const state = createFinderState();
  const run = async (member: boolean) => {
    reads.length = 0;
    const owner = await connect(member);
    const sync = startFinderSync({
      session: owner.session,
      corpus,
      state,
      changed() {},
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync.status().phase).toBe("ready");
    sync.dispose();
    owner.dispose();
  };
  await run(true);
  expect(corpus.search("quartz").total).toBe(1);
  await run(false);
  expect(corpus.search("quartz").total).toBe(0);
  await run(true);
  expect(corpus.search("quartz").total).toBe(1);
  const chunk = reads.find((filter) => filter["#h"]?.includes("dm07"));
  // Read from the horizon again, not resumed from its last read.
  expect(chunk?.since).toBeLessThan(now - 86_400);
  // The other chunk only resumes.
  const other = reads.find((filter) => filter["#h"]?.includes("dm55"));
  expect(other?.since).toBeGreaterThanOrEqual(now - 300);
});
