import { lifecycleOffer } from "./channel-lifecycle-protocol";
import { createInboxReactions } from "./inbox-reactions";
import { matchesEvent } from "./projection";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import { createReadState } from "./read-state";
import { readJournal, type ReadJournal } from "./read-state-storage";
import {
  keypair,
  message,
  metadata,
  roster as rosterEvent,
  signed,
  type Key,
} from "./testing";
import { DiscoveryState } from "./discovery";
import { createUnread } from "./unread";

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert(value !== undefined, "Missing fixture entry");
  return value;
}

async function setup(
  count = 3,
  profiles?: ProfileQueries,
  project: (channel: ChannelSummary, viewer: string) => ChannelSummary = (
    channel,
  ) => channel,
) {
  const viewer = keypair(),
    peer = keypair();
  const roster: readonly ChannelSummary[] = Array.from(
    { length: count },
    (_, i) =>
      project(
        {
          id: `c${i}`,
          name: `Channel ${i}`,
          members: [viewer.pubkey],
        },
        viewer.pubkey,
      ),
  );
  const channels: ChannelQueries = {
    list: () => ({ status: "ready" as const, channels: roster }),
    subscribeList() {
      return () => {};
    },
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  let journal: ReadJournal | undefined;
  const reader = { read: vi.fn(async () => []) };
  const reads = createReadState({
    floor: () => 0,
    viewer: viewer.pubkey,
    reader,
    host: undefined,
    storage: {
      capture: async () => structuredClone(journal),
      async update(change) {
        journal = readJournal(change(journal), viewer.pubkey);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  const state = vi.spyOn(reads, "state");
  const owner = createUnread({
    reads,
    channels,
    reader,
    viewer: viewer.pubkey,
    ...(profiles && { profiles }),
  });
  owners.push(owner);
  const targets = roster.map(({ id }) => ({
    kind: "channel" as const,
    channelId: id,
  }));
  const rows = roster.map(({ id }) => message(peer, id, "seed", 11));
  owner.accept(rows);
  const listeners = targets.map(() => vi.fn());
  targets.forEach((target, i) => {
    owner.capability.subscribe(target, at(listeners, i));
  });
  const reset = () => state.mockClear();
  reset();
  return {
    owner,
    unread: owner.capability,
    viewer,
    peer,
    rows,
    targets,
    listeners,
    state,
    reads,
    reset,
  };
}

async function reactionItems(channel: ChannelSummary, viewer: Key) {
  const target = message(viewer, channel.id, "My message", 20);
  const reaction = signed(keypair(), {
    kind: 7,
    content: "+",
    created_at: 21,
    tags: [
      ["e", target.id],
      ["p", viewer.pubkey],
      ["h", channel.id],
    ],
  });
  const feed = createInboxReactions({
    viewer: viewer.pubkey,
    channels: {
      list: () => ({ status: "ready", channels: [channel] }),
      subscribeList: () => () => {},
      window: () => {
        throw new Error("Reaction feed must not read windows");
      },
      subscribeWindow: () => () => {},
      ensureList() {},
      ensure() {},
      loadOlder() {},
    },
    reader: {
      read: async (filters) =>
        [target, reaction].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    },
    notify: (listener) => listener(),
  });
  try {
    await feed.ensure();
    return feed.snapshot().items;
  } finally {
    feed.dispose();
  }
}

it("does not trust workflow-owner metadata without a configured relay identity", async () => {
  const h = await setup(1);
  const row = message(h.peer, "c0", "workflow-shaped output", 12, [
    ["p", h.viewer.pubkey],
    ["buzz:workflow", "true"],
    ["buzz:workflow-owner", h.viewer.pubkey],
  ]);
  h.owner.accept([row]);
  expect(h.unread.attention("c0", row.id)).toMatchObject({
    category: "mention",
    mentioned: true,
    unread: true,
  });
});

it("republishes activity folded before an owner answer changed", async () => {
  const agent = keypair(),
    controller = keypair();
  let verified: string | undefined;
  let notify = () => {};
  const profiles = {
    snapshot: () => new Map(),
    subscribe(listener: () => void) {
      notify = listener;
      return () => {};
    },
    ensure: async () => {},
    owner: (pubkey: string) => (pubkey === agent.pubkey ? verified : undefined),
  } satisfies ProfileQueries;
  const h = await setup(2, profiles);
  h.owner.accept(
    h.rows.flatMap((row, i) => {
      const reply = message(agent, `c${i}`, "Whole answer", 12, [
        ["e", row.id, "", "reply"],
        ["p", h.viewer.pubkey],
      ]);
      const edit = signed(controller, {
        kind: 40003,
        created_at: 13,
        content: "Spoken",
        tags: [
          ["h", `c${i}`],
          ["e", reply.id],
        ],
      });
      return [reply, edit];
    }),
  );
  const preview = (channelId: string) =>
    h.unread.activity(channelId).items?.[0]?.preview;
  expect(preview("c0")).toBe("Whole answer");
  // One owner resolves before the directory's batch notification.
  verified = controller.pubkey;
  expect(preview("c1")).toBe("Spoken");
  notify();
  expect(preview("c0")).toBe("Spoken");
});

it("keeps folded rows through a profile change that leaves owners alone", async () => {
  const agent = keypair(),
    controller = keypair();
  let notify = () => {};
  const owner = vi.fn((pubkey: string) =>
    pubkey === agent.pubkey ? controller.pubkey : undefined,
  );
  const profiles = {
    snapshot: () => new Map(),
    subscribe(listener: () => void) {
      notify = listener;
      return () => {};
    },
    ensure: async () => {},
    owner,
  } satisfies ProfileQueries;
  const h = await setup(2, profiles);
  h.owner.accept(
    h.rows.flatMap((row, i) => {
      const reply = message(agent, `c${i}`, "Whole answer", 12, [
        ["e", row.id, "", "reply"],
        ["p", h.viewer.pubkey],
      ]);
      const edit = signed(controller, {
        kind: 40003,
        created_at: 13,
        content: "Spoken",
        tags: [
          ["h", `c${i}`],
          ["e", reply.id],
        ],
      });
      return [reply, edit];
    }),
  );
  h.unread.subscribeActivity("c0", () => {});
  h.unread.subscribeActivity("c1", () => {});
  expect(owner).toHaveBeenCalled();
  owner.mockClear();
  // A display-only change reads the one recorded owner; the next projections
  // reuse their folded rows instead of asking again.
  notify();
  await h.reads.markLocalUnread("c0", () => true);
  expect(owner).toHaveBeenCalledTimes(1);
});

it("keeps read-state and freshness invalidation global", async () => {
  const h = await setup();
  const before = h.targets.map(h.unread.snapshot);
  const activity = h.unread.activity("c0");
  const activityChanges = vi.fn();
  h.unread.subscribeActivity("c0", activityChanges);
  expect(activity).toMatchObject({
    coverage: "observed",
    freshness: "observed",
    items: [],
  });
  h.reset();
  const readChanges = vi.fn();
  h.reads.subscribe(readChanges);
  await h.reads.markLocalUnread("c0", () => true);
  expect(readChanges).toHaveBeenCalled();
  expect(h.unread.snapshot(at(h.targets, 0)).manual).toBe("local-only");
  expect(h.unread.snapshot(at(h.targets, 1))).toBe(before[1]);
  expect(h.unread.activity("c0")).toBe(activity);
  expect(activityChanges).not.toHaveBeenCalled();
  h.owner.stale();
  expect(
    h.targets.map((target) => h.unread.snapshot(target).freshness),
  ).toEqual(["stale", "stale", "stale"]);
  expect(h.unread.activity("c0")).toMatchObject({
    freshness: "stale",
    items: [],
  });
  expect(activityChanges).toHaveBeenCalledOnce();
  const beforeFreshnessRecovery = h.listeners.map(
    (listener) => listener.mock.calls.length,
  );
  h.reset();
  h.owner.accept([message(h.peer, "c0", "fresh evidence", 12)]);
  expect(h.listeners.map((listener) => listener.mock.calls.length)).toEqual(
    beforeFreshnessRecovery.map((count) => count + 1),
  );
  expect(activityChanges).toHaveBeenCalledTimes(2);
  expect(
    h.targets.map((target) => h.unread.snapshot(target).freshness),
  ).toEqual(["observed", "observed", "observed"]);
});

it.each([5, 9005])(
  "kind-%s deletion invalidates every target channel before reentrant snapshot reads",
  async (kind) => {
    const h = await setup();
    const dormant = {
      kind: "message" as const,
      channelId: "c1",
      messageId: at(h.rows, 1).id,
    };
    expect(h.unread.snapshot(dormant).observedCount).toBe(1);
    const seen: (number | null)[][] = [];
    h.unread.subscribe(at(h.targets, 0), () =>
      seen.push([
        h.unread.snapshot(at(h.targets, 1)).observedCount,
        h.unread.snapshot(dormant).observedCount,
      ]),
    );
    h.reset();
    h.owner.accept([
      signed(h.peer, {
        kind,
        content: "",
        tags: [
          ["h", "c0"],
          ["e", at(h.rows, 0).id],
          ["e", at(h.rows, 1).id],
        ],
      }),
    ]);
    expect(seen).toEqual([[0, 0]]);
    expect(h.state).toHaveBeenCalledTimes(3); // two subscribed + one lazy reentrant read
    expect(h.listeners[2]).not.toHaveBeenCalled();
  },
);

it("counts unread for a joined Guest with unloaded peers, while stale and foreign authority cannot admit it", async () => {
  const h = await setup(1, undefined, (channel, viewer) => {
    const { members: _peers, ...rest } = channel;
    return {
      ...rest,
      viewerMembership: { pubkey: viewer, joined: true },
      viewerRole: "guest",
      readOnly: true,
    };
  });
  expect(h.unread.snapshot(at(h.targets, 0)).observedCount).toBe(1);
  const guest: ChannelSummary = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Guest",
    channelType: "stream",
    owners: [],
    viewerRole: "guest",
    readOnly: true,
    viewerMembership: { pubkey: h.viewer.pubkey, joined: true },
  };
  expect(lifecycleOffer(guest, h.viewer.pubkey, false)?.canLeave).toBe(true);
  expect(await reactionItems(guest, h.viewer)).toHaveLength(1);
  for (const state of ["denied", "cached", "foreign"] as const) {
    const h = await setup(1, undefined, (channel, viewer) => ({
      ...channel,
      viewerMembership: {
        pubkey: state === "foreign" ? "another-viewer" : viewer,
        joined: state !== "denied",
      },
      ...(state === "cached" ? { cached: true as const } : {}),
    }));
    expect(h.unread.snapshot(at(h.targets, 0)).observedCount).toBeNull();
  }
});

it.each(["deny", "omit", "all"] as const)(
  "keeps a restored public preview out of unread after %s despite its retained roster",
  async (loss) => {
    const relay = keypair();
    let projected: ChannelSummary | undefined;
    const h = await setup(1, undefined, (channel, viewer) => {
      const discovery = new DiscoveryState(viewer, relay.pubkey);
      const details = metadata(relay, channel.id, channel.name, 10, [
        ["public"],
        ["t", "stream"],
      ]);
      discovery.accept(details);
      discovery.accept(rosterEvent(relay, channel.id, [viewer], 10));
      expect(discovery.get(channel.id)?.viewerMembership?.joined).toBe(true);
      if (loss === "deny") discovery.deny(channel.id);
      else if (loss === "omit")
        discovery.retain(new Set(), discovery.rosterVersions());
      else discovery.denyAll();
      expect(discovery.canAccess(channel.id)).toBe(false);
      discovery.resume(channel.id, details);
      const preview = discovery.get(channel.id);
      assert(preview);
      expect(preview.members).toContain(viewer);
      projected = preview;
      expect(discovery.canAccess(channel.id)).toBe(true);
      expect(discovery.canParticipate(channel.id)).toBe(false);
      return preview;
    });
    expect(h.unread.snapshot(at(h.targets, 0)).observedCount).toBeNull();
    expect(h.unread.inbox().items).toEqual([]);
    assert(projected);
    expect(
      lifecycleOffer(
        {
          ...projected,
          id: "11111111-1111-4111-8111-111111111111",
          channelType: "stream",
          owners: [],
          viewerRole: "guest",
          readOnly: true,
        },
        h.viewer.pubkey,
        false,
      ),
    ).toBeUndefined();
    expect(await reactionItems(projected, h.viewer)).toEqual([]);
    expect(projected?.viewerMembership).toEqual({
      pubkey: h.viewer.pubkey,
      joined: false,
    });
  },
);
