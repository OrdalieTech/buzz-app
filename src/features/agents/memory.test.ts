import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentMemories,
  forgetMemoryListingsOnSelection,
  MEMORY_CACHE_MS,
  type MemoryListing,
  type MemoryReader,
} from "./memory";

afterEach(() => {
  vi.useRealTimers();
});

const agent = "a".repeat(64);
const viewer = "c".repeat(64);
const listing = (...bodies: string[]): MemoryListing => ({
  entries: bodies.map((body, i) => ({
    slug: `mem/${body}`,
    body,
    eventId: i.toString(16).padStart(64, "0"),
    createdAt: 1,
  })),
  partial: false,
});

/** A reader whose every read waits until `answer` is called. */
function pending() {
  const answers: ((listing: MemoryListing) => void)[] = [];
  const pages: ((page: MemoryListing) => void)[] = [];
  const read = vi.fn<MemoryReader>(
    (_agent, _signal, _slug, onPage) =>
      new Promise((resolve) => {
        answers.push(resolve);
        if (onPage) pages.push(onPage);
      }),
  );
  const answer = (value: MemoryListing) => answers.shift()?.(value);
  return { read, answer, pages };
}

const slugs = (snapshot: { listing?: MemoryListing }) =>
  snapshot.listing?.entries.map((entry) => entry.body);

async function readOnce(
  owner: ReturnType<typeof createAgentMemories>,
  answer: (value: MemoryListing) => void,
  value: MemoryListing,
) {
  const view = owner.capability.open(agent);
  const done = view.refresh();
  answer(value);
  await done;
  expect(view.snapshot().status).toBe("ready");
  view.dispose();
}

it("shows a kept listing before the relay answers, then replaces it with streamed and final entries", async () => {
  const { read, answer, pages } = pending();
  const owner = createAgentMemories(read, viewer, () => true);
  await readOnce(owner, answer, listing("stale", "kept"));
  const view = owner.capability.open(agent);
  const done = view.refresh();
  // The cache hit renders at once, while the read goes on.
  expect(view.snapshot().status).toBe("loading");
  expect(slugs(view.snapshot())).toEqual(["kept", "stale"]);
  expect(read).toHaveBeenCalledTimes(2);
  // A streamed page replaces the cached entry with the same slug.
  pages.at(-1)?.({
    entries: [
      {
        slug: "mem/stale",
        body: "fresh",
        eventId: "f".repeat(64),
        createdAt: 2,
      },
    ],
    partial: false,
  });
  expect(slugs(view.snapshot())).toEqual(["kept", "fresh"]);
  // The completed read replaces the whole listing: a removed memory goes.
  answer(listing("fresh"));
  await done;
  expect(view.snapshot().status).toBe("ready");
  expect(slugs(view.snapshot())).toEqual(["fresh"]);
  view.dispose();
});

it("releases a kept listing 30 seconds after its view closes", async () => {
  vi.useFakeTimers();
  const { read, answer } = pending();
  const owner = createAgentMemories(read, viewer, () => true);
  await readOnce(owner, answer, listing("kept"));
  vi.advanceTimersByTime(MEMORY_CACHE_MS - 1);
  let view = owner.capability.open(agent);
  void view.refresh();
  expect(slugs(view.snapshot())).toEqual(["kept"]);
  answer(listing("kept"));
  await vi.waitFor(() => expect(view.snapshot().status).toBe("ready"));
  view.dispose();
  vi.advanceTimersByTime(MEMORY_CACHE_MS);
  view = owner.capability.open(agent);
  void view.refresh();
  expect(view.snapshot()).toEqual({ status: "loading" });
  view.dispose();
});

it.each(["clear", "dispose"] as const)(
  "drops kept listings at once when the session is %sed",
  async (end) => {
    const { read, answer } = pending();
    const owner = createAgentMemories(read, viewer, () => true);
    await readOnce(owner, answer, listing("kept"));
    owner[end]();
    if (end === "dispose") {
      expect(() => owner.capability.open(agent)).toThrow();
      return;
    }
    const view = owner.capability.open(agent);
    void view.refresh();
    expect(view.snapshot()).toEqual({ status: "loading" });
    view.dispose();
  },
);

/** A community selection that tests move by hand. */
function selection(selected: string | null) {
  const listeners = new Set<() => void>();
  return {
    snapshot: () => ({ selected }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(next: string | null) {
      selected = next;
      for (const listener of listeners) listener();
    },
  };
}

it.each([
  ["another community and back", ["b", "a"]],
  ["Personal space and back", [null, "a"]],
])(
  "forgets kept listings on switching to %s, while the session stays retained",
  async (_name, moves) => {
    const communities = selection("a");
    const stop = forgetMemoryListingsOnSelection(communities);
    const { read, answer } = pending();
    const owner = createAgentMemories(read, viewer, () => true);
    await readOnce(owner, answer, listing("from-a"));
    // A refresh still in flight across the switch cannot keep its listing.
    const view = owner.capability.open(agent);
    const done = view.refresh();
    for (const next of moves) communities.select(next);
    answer(listing("late"));
    await done;
    view.dispose();
    const back = owner.capability.open(agent);
    void back.refresh();
    expect(back.snapshot()).toEqual({ status: "loading" });
    back.dispose();
    stop();
  },
);

const sized = (slug: string, bytes: number, createdAt = 1) => ({
  slug: `mem/${slug}`,
  body: "x".repeat(bytes),
  eventId: "e".repeat(64),
  createdAt,
});

it("evicts cached-only entries so cached and fresh pages stay within the byte budget", async () => {
  const { read, answer, pages } = pending();
  const owner = createAgentMemories(read, viewer, () => true);
  const big = 60 * 1024;
  await readOnce(owner, answer, {
    entries: Array.from({ length: 90 }, (_, i) =>
      sized(`old-${i}`, big, i + 1),
    ),
    partial: false,
  });
  const view = owner.capability.open(agent);
  const done = view.refresh();
  pages.at(-1)?.({
    entries: Array.from({ length: 90 }, (_, i) => sized(`new-${i}`, big)),
    partial: false,
  });
  const entries = view.snapshot().listing?.entries ?? [];
  const bytes = entries.reduce((sum, entry) => sum + entry.body.length, 0);
  expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  // Every fresh entry stays; the oldest cached ones gave way.
  expect(entries.filter((e) => e.slug.startsWith("mem/new-"))).toHaveLength(90);
  expect(entries.some((e) => e.slug === "mem/old-0")).toBe(false);
  expect(entries.some((e) => e.slug === "mem/old-89")).toBe(true);
  answer({ entries: [], partial: false });
  await done;
  view.dispose();
});

it("evicts cached-only entries so cached and fresh pages stay within the entry budget", async () => {
  const { read, answer, pages } = pending();
  const owner = createAgentMemories(read, viewer, () => true);
  await readOnce(owner, answer, {
    entries: Array.from({ length: 4000 }, (_, i) => sized(`old-${i}`, 1)),
    partial: false,
  });
  const view = owner.capability.open(agent);
  const done = view.refresh();
  pages.at(-1)?.({
    entries: Array.from({ length: 200 }, (_, i) => sized(`new-${i}`, 1)),
    partial: false,
  });
  const entries = view.snapshot().listing?.entries ?? [];
  expect(entries).toHaveLength(4096);
  expect(entries.filter((e) => e.slug.startsWith("mem/new-"))).toHaveLength(
    200,
  );
  answer({ entries: [], partial: false });
  await done;
  view.dispose();
});

it("still forgets a live owner's listings on a switch after garbage collection", async () => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  const communities = selection("a");
  const stop = forgetMemoryListingsOnSelection(communities);
  const { read, answer } = pending();
  const owner = createAgentMemories(read, viewer, () => true);
  await readOnce(owner, answer, listing("from-a"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  collect();
  communities.select("b");
  communities.select("a");
  const back = owner.capability.open(agent);
  void back.refresh();
  expect(back.snapshot()).toEqual({ status: "loading" });
  back.dispose();
  owner.dispose();
  stop();
});

/** A reader whose reads each wait for `settle` with an answer or a failure. */
function settled() {
  const reads: {
    page?: ((page: MemoryListing) => void) | undefined;
    resolve: (listing: MemoryListing) => void;
    reject: (error: Error) => void;
  }[] = [];
  const read = vi.fn<MemoryReader>(
    (_agent, _signal, _slug, onPage) =>
      new Promise((resolve, reject) => {
        reads.push({ page: onPage, resolve, reject });
      }),
  );
  return { read, reads };
}

it("keeps a streamed page beside Retry when a later page fails, then recovers", async () => {
  const { read, reads } = settled();
  const owner = createAgentMemories(read, viewer, () => true);
  const view = owner.capability.open(agent);
  let done = view.refresh();
  reads[0]?.page?.(listing("first"));
  expect(slugs(view.snapshot())).toEqual(["first"]);
  reads[0]?.reject(new Error("Memory read failed"));
  await done;
  expect(view.snapshot().status).toBe("error");
  expect(slugs(view.snapshot())).toEqual(["first"]);
  done = view.refresh();
  expect(slugs(view.snapshot())).toEqual(["first"]);
  reads[1]?.resolve(listing("first", "second"));
  await done;
  expect(view.snapshot().status).toBe("ready");
  expect(slugs(view.snapshot())).toEqual(["first", "second"]);
  view.dispose();
});

it("keeps a partial listing when its Retry fails, then recovers", async () => {
  const { read, reads } = settled();
  const owner = createAgentMemories(read, viewer, () => true);
  const view = owner.capability.open(agent);
  let done = view.refresh();
  reads[0]?.resolve({ ...listing("first"), partial: true });
  await done;
  expect(view.snapshot().listing?.partial).toBe(true);
  done = view.refresh();
  reads[1]?.reject(new Error("Memory read failed"));
  await done;
  expect(view.snapshot().status).toBe("error");
  expect(slugs(view.snapshot())).toEqual(["first"]);
  done = view.refresh();
  reads[2]?.resolve(listing("first", "second"));
  await done;
  expect(view.snapshot()).toMatchObject({ status: "ready" });
  expect(view.snapshot().listing?.partial).toBe(false);
  expect(slugs(view.snapshot())).toEqual(["first", "second"]);
  view.dispose();
});

it("still clears shown entries when the read is denied or the session clears", async () => {
  const { read, reads } = settled();
  const owner = createAgentMemories(read, viewer, () => true);
  const view = owner.capability.open(agent);
  let done = view.refresh();
  reads[0]?.page?.(listing("first"));
  const denied = new Error("Memory read failed");
  denied.name = "MemoryDenied";
  reads[0]?.reject(denied);
  await done;
  expect(view.snapshot()).toEqual({ status: "denied" });
  done = view.refresh();
  reads[1]?.page?.(listing("first"));
  owner.clear();
  reads[1]?.reject(new Error("Memory read failed"));
  await done;
  expect(view.snapshot()).toEqual({ status: "idle" });
  view.dispose();
});

it("drops the kept listing on denial, and a read still in flight can't keep it again", async () => {
  const { read, reads } = settled();
  const owner = createAgentMemories(read, viewer, () => true);
  const first = owner.capability.open(agent);
  let done = first.refresh();
  reads[0]?.resolve(listing("kept"));
  await done;
  first.dispose();
  const older = owner.capability.open(agent);
  const olderDone = older.refresh();
  const view = owner.capability.open(agent);
  done = view.refresh();
  expect(slugs(view.snapshot())).toEqual(["kept"]);
  const denied = new Error("Memory read failed");
  denied.name = "MemoryDenied";
  reads[2]?.reject(denied);
  await done;
  expect(view.snapshot()).toEqual({ status: "denied" });
  view.dispose();
  // The older read was admitted before the denial: it may not cache.
  reads[1]?.resolve(listing("late"));
  await olderDone;
  older.dispose();
  const reopened = owner.capability.open(agent);
  void reopened.refresh();
  expect(reopened.snapshot()).toEqual({ status: "loading" });
  reopened.dispose();
});
