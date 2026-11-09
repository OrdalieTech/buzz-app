import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, roster, scriptedTransport } from "./testing";
import type { LiveCallbacks } from "./live";
import { memorySlug } from "../agents/memory";
import type { MemoryListing, MemoryReader } from "../agents/memory";
const viewer = keypair(),
  relay = keypair(),
  agent = keypair();
const listing: MemoryListing = {
  entries: [
    { slug: "core", body: "private", eventId: "a".repeat(64), createdAt: 1 },
  ],
  partial: false,
};
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function harness(
  readAgentMemories?: MemoryReader,
  who = viewer.pubkey,
  scope = "https://one.example",
  options: Parameters<typeof createRelaySession>[1] = {},
) {
  const wire = scriptedTransport(who, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      scope,
      ...(readAgentMemories ? { readAgentMemories } : {}),
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    options,
  );
  owners.push(owner);
  live.state({ status: "connected", routes: [] });
  return { ...owner, live };
}
it("is lazy, exact-key, unsupported for self/malformed/unsupported hosts and independent of inventories", async () => {
  const read = vi.fn<MemoryReader>(async () => listing),
    h = harness(read);
  expect(read).not.toHaveBeenCalled();
  for (const key of [viewer.pubkey, "bad"]) {
    const view = h.session.agentMemories.open(key);
    await view.refresh();
    expect(view.snapshot().status).toBe("unavailable");
    view.dispose();
  }
  expect(read).not.toHaveBeenCalled();
  const view = h.session.agentMemories.open(agent.pubkey);
  await view.refresh();
  expect(read.mock.calls[0]?.[0]).toBe(agent.pubkey);
  expect(view.snapshot()).toEqual({ status: "ready", listing });
  expect(Object.isFrozen(view.snapshot().listing?.entries)).toBe(true);
  view.dispose();
  expect(view.snapshot().listing).toBeUndefined();
  const unsupported = harness().session.agentMemories.open(agent.pubkey);
  await unsupported.refresh();
  expect(unsupported.snapshot().status).toBe("unavailable");
});
it.each(["revoke", "disconnect", "cache", "dispose", "release"])(
  "%s clears plaintext and fences an in-flight completion through the actual session",
  async (mode) => {
    let resolve!: (listing: MemoryListing) => void;
    const read = vi
      .fn<MemoryReader>()
      .mockResolvedValueOnce(listing)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    const h = harness(read),
      view = h.session.agentMemories.open(agent.pubkey);
    h.live.receive([roster(relay, "a", [viewer.pubkey], 1)]);
    await view.refresh();
    expect(view.snapshot().listing).toEqual(listing);
    const pending = view.refresh();
    // The kept listing shows while the read goes on.
    expect(view.snapshot()).toEqual({ status: "loading", listing });
    if (mode === "revoke") h.live.receive([roster(relay, "a", [], 2)]);
    if (mode === "disconnect") h.live.state({ status: "error", routes: [] });
    if (mode === "cache") await h.clearCache();
    if (mode === "dispose") h.dispose();
    if (mode === "release") view.dispose();
    expect(read.mock.calls[1]?.[1].aborted).toBe(true);
    expect(view.snapshot().listing).toBeUndefined();
    resolve(listing);
    await pending;
    expect(view.snapshot().listing).toBeUndefined();
    // Every mode but closing one view also drops the listing kept for reopening.
    if (mode !== "release" && mode !== "dispose") {
      read.mockImplementationOnce(() => new Promise(() => {}));
      const reopened = h.session.agentMemories.open(agent.pubkey);
      void reopened.refresh();
      expect(reopened.snapshot().listing).toBeUndefined();
      reopened.dispose();
    }
  },
);
it("does not leak across relay/viewer sessions and does not refresh while disconnected", async () => {
  const read = vi.fn<MemoryReader>().mockResolvedValue(listing);
  const first = harness(read),
    second = harness(read, agent.pubkey, "https://two.example");
  const a = first.session.agentMemories.open(agent.pubkey),
    b = second.session.agentMemories.open(viewer.pubkey);
  await a.refresh();
  expect(b.snapshot().listing).toBeUndefined();
  second.live.state({ status: "error", routes: [] });
  await b.refresh();
  expect(b.snapshot().status).toBe("blocked");
  expect(read).toHaveBeenCalledTimes(1);
});
it("reports denied/error separately, retries, rejects malformed host output and bounds simultaneous views", async () => {
  const denied = new Error("secret");
  denied.name = "MemoryDenied";
  const read = vi
    .fn<MemoryReader>()
    .mockRejectedValueOnce(denied)
    .mockRejectedValueOnce(new Error("secret"))
    .mockResolvedValueOnce({ entries: [], partial: false })
    .mockResolvedValueOnce({
      entries: [null],
      partial: false,
    } as unknown as MemoryListing);
  const h = harness(read),
    view = h.session.agentMemories.open(agent.pubkey);
  await view.refresh();
  expect(view.snapshot()).toEqual({ status: "denied" });
  await view.refresh();
  expect(view.snapshot()).toEqual({ status: "error" });
  await view.refresh();
  expect(view.snapshot()).toEqual({
    status: "ready",
    listing: { entries: [], partial: false },
  });
  // A failed refresh keeps what the view showed.
  await view.refresh();
  expect(view.snapshot()).toEqual({
    status: "error",
    listing: { entries: [], partial: false },
  });
  for (let i = 0; i < 3; i++) h.session.agentMemories.open(agent.pubkey);
  expect(() => h.session.agentMemories.open(agent.pubkey)).toThrow();
  view.dispose();
  expect(() => h.session.agentMemories.open(agent.pubkey)).not.toThrow();
});

it("passes deleted entries' tombstones through a runtime read and rejects malformed ones", async () => {
  const deleted = { slug: "mem/gone", createdAt: 4_000_000_001 };
  const read = vi
    .fn<MemoryReader>()
    .mockResolvedValueOnce({ ...listing, deleted: [deleted] });
  const h = harness(read);
  const signal = new AbortController().signal;
  await expect(
    h.session.agentMemories.read(agent.pubkey, signal),
  ).resolves.toEqual({ ...listing, deleted: [deleted] });
  for (const bad of [
    { slug: "gone", createdAt: 1 },
    { slug: "core", createdAt: 1 },
    { slug: "mem/gone", createdAt: -1 },
    { slug: "mem/gone" },
  ]) {
    read.mockResolvedValueOnce({
      ...listing,
      deleted: [bad],
    } as unknown as MemoryListing);
    await expect(
      h.session.agentMemories.read(agent.pubkey, signal),
    ).rejects.toThrow("Invalid memory entry");
  }
});

it("serializes runtime reads outside the mounted-view budget", async () => {
  const next = keypair();
  const releases: ((value: MemoryListing) => void)[] = [];
  const read = vi.fn<MemoryReader>(
    () => new Promise((resolve) => releases.push(resolve)),
  );
  const h = harness(read);
  for (let i = 0; i < 4; i++) h.session.agentMemories.open(agent.pubkey);

  const first = h.session.agentMemories.read(
    agent.pubkey,
    new AbortController().signal,
  );
  const second = h.session.agentMemories.read(
    next.pubkey,
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  releases[0]?.(listing);
  await expect(first).resolves.toEqual(listing);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  releases[1]?.(listing);
  await expect(second).resolves.toEqual(listing);
});

it("disconnect subscribers cannot reenter with stale connected authority", async () => {
  const read = vi.fn<MemoryReader>().mockResolvedValue(listing);
  const h = harness(read),
    view = h.session.agentMemories.open(agent.pubkey);
  await view.refresh();
  const stop = view.subscribe(() => {
    if (view.snapshot().status === "idle") void view.refresh();
  });
  h.live.state({ status: "error", routes: [] });
  stop();
  expect(view.snapshot()).toEqual({ status: "blocked" });
  expect(read).toHaveBeenCalledTimes(1);
});

it("cache clear blocks subscriber reentry and new views until all purges settle", async () => {
  const releases: (() => void)[] = [];
  let finishRead!: (value: MemoryListing) => void;
  const read = vi
    .fn<MemoryReader>()
    .mockResolvedValueOnce(listing)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    )
    .mockResolvedValue(listing);
  const h = harness(read, viewer.pubkey, "https://one.example", {
    persistence: {
      async read() {
        return [];
      },
      async write() {},
      async remove() {},
      async retain() {},
      close() {},
      clear: () => new Promise<void>((resolve) => releases.push(resolve)),
    },
  });
  const view = h.session.agentMemories.open(agent.pubkey);
  await view.refresh();
  const pending = view.refresh();
  const stop = view.subscribe(() => {
    if (view.snapshot().status === "idle") void view.refresh();
  });
  const first = h.clearCache();
  const second = h.clearCache();
  try {
    expect(releases).toHaveLength(2);
    expect(read.mock.calls[1]?.[1].aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    finishRead(listing);
    await pending;
    expect(view.snapshot().listing).toBeUndefined();
    releases[0]?.();
    await first;
    const other = h.session.agentMemories.open(agent.pubkey);
    await other.refresh();
    await view.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    expect(other.snapshot().listing).toBeUndefined();
    releases[1]?.();
    await second;
    stop();
    await view.refresh();
    expect(read).toHaveBeenCalledTimes(3);
    expect(view.snapshot()).toEqual({ status: "ready", listing });
  } finally {
    stop();
    finishRead(listing);
    for (const release of releases) release();
    await Promise.all([first, second, pending]);
  }
});

it("shares the bounded NIP-AE slug grammar", () => {
  const segment = "a".repeat(63);
  const max = `mem/${[segment, segment, segment, "a".repeat(59)].join("/")}`;
  expect(max.length).toBe(255);
  for (const slug of ["core", "mem/a", "mem/a-b/c_d", max])
    expect(memorySlug(slug)).toBe(true);
  for (const slug of [
    null,
    "",
    "Core",
    "mem/",
    "mem/A",
    "mem/a/",
    "mem//a",
    `mem/${"a".repeat(65)}`,
    `${max}a`,
  ])
    expect(memorySlug(slug)).toBe(false);
});
