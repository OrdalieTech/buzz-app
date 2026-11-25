import { afterEach, expect, it, vi } from "vitest";
import { AgentInbox } from "./inbox";
import type { AgentReads } from "./reads";
import { eventsDto, type ReadFilter } from "../relay/events";
import { keypair, metadata, message, roster } from "../relay/testing";

const relay = keypair();
const agent = keypair();
const sibling = keypair();
const owner = keypair();
const channel = "private-agent-dm";
const signal = () => new AbortController().signal;
const mention = message(sibling, channel, "Do the work", 100, [
  ["p", agent.pubkey],
]);
const filter: ReadFilter = { kinds: [9], "#p": [agent.pubkey], limit: 16 };

function fixture() {
  const controller = new AbortController();
  const owned = { name: "Owner channel", dm: false, members: [owner.pubkey] };
  const ownerReads = {
    connection: {},
    scope: "https://relay.example.org:owner",
    channel: vi.fn(async (id: string) =>
      id === "owner-channel" ? owned : undefined,
    ),
    read: vi.fn(async () => []),
    channelLabel: () => undefined,
    subscribeChannels: () => () => {},
  } as unknown as AgentReads;
  let members = [agent.pubkey, sibling.pubkey];
  let authority = relay;
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (filters[0]?.kinds?.includes(39000))
      return eventsDto([
        metadata(authority, channel, "Private DM", 1, [
          ["private"],
          ["hidden"],
          ["t", "dm"],
        ]),
        roster(authority, channel, members, 1),
      ]);
    return eventsDto([mention]);
  });
  const inbox = new AgentInbox(
    ownerReads,
    agent.pubkey,
    relay.pubkey,
    query,
    controller.signal,
  );
  return {
    inbox,
    ownerReads,
    query,
    controller,
    remove: () => {
      members = [sibling.pubkey];
    },
    forge: () => {
      authority = sibling;
    },
  };
}

afterEach(() => vi.useRealTimers());

it("resolves agent-only DM facts and reads its history as the agent, not the owner", async () => {
  const f = fixture();
  try {
    expect(await f.inbox.mentions(filter, signal())).toEqual(
      eventsDto([mention]),
    );
    expect(f.inbox.channel(channel)).toMatchObject({
      channelType: "dm",
      members: [agent.pubkey, sibling.pubkey].sort(),
    });
    expect(await f.inbox.reads.channel(channel)).toMatchObject({
      dm: true,
      name: "Private DM",
    });
    expect(
      await f.inbox.reads.read(
        [{ kinds: [9], "#h": [channel], limit: 50 }],
        signal(),
      ),
    ).toEqual(eventsDto([mention]));
    expect(f.ownerReads.read).not.toHaveBeenCalled();
    expect(f.query.mock.calls[1]?.[0]).toEqual([
      {
        kinds: [39000, 39002],
        authors: [relay.pubkey],
        "#d": [channel],
        limit: 2,
      },
    ]);
    await f.inbox.reads.read(
      [{ kinds: [9], "#h": ["owner-channel"], limit: 50 }],
      signal(),
    );
    expect(f.ownerReads.read).toHaveBeenCalledTimes(1);
  } finally {
    f.controller.abort();
  }
});

it("does not grant membership from another author's signed metadata or an old roster", async () => {
  const f = fixture();
  try {
    await f.inbox.mentions(filter, signal());
    f.remove();
    expect(await f.inbox.reads.channel(channel)).toBeUndefined();
    expect(f.inbox.channel(channel)).toBeUndefined();
    f.forge();
    await f.inbox.mentions(filter, signal());
    expect(f.inbox.channel(channel)).toBeUndefined();
  } finally {
    f.controller.abort();
  }
});

it("retires pending queries when the community binding closes", async () => {
  const f = fixture();
  let release!: (events: ReturnType<typeof eventsDto>) => void;
  f.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const read = f.inbox.mentions(filter, signal());
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
  f.controller.abort();
  release(eventsDto([mention]));
  await rejected;
  expect(f.inbox.channel(channel)).toBeUndefined();
  expect(f.query).toHaveBeenCalledTimes(1);
});

it("jitters startup and backs failed mention polls off without advancing delivery", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const f = fixture();
  try {
    expect(f.inbox.due()).toBe(false);
    vi.setSystemTime(Date.now() + 2_500);
    expect(f.inbox.due()).toBe(true);
    for (const wait of [33_750, 67_500, 135_000, 270_000, 270_000]) {
      f.query.mockRejectedValueOnce(new Error("Offline"));
      await expect(f.inbox.mentions(filter, signal())).rejects.toThrow(
        "Offline",
      );
      expect(f.inbox.due()).toBe(false);
      vi.setSystemTime(Date.now() + wait - 1);
      expect(f.inbox.due()).toBe(false);
      vi.setSystemTime(Date.now() + 1);
      expect(f.inbox.due()).toBe(true);
    }
    await f.inbox.mentions(filter, signal());
    vi.setSystemTime(Date.now() + 33_750);
    expect(f.inbox.due()).toBe(true);
  } finally {
    f.controller.abort();
    random.mockRestore();
  }
});

it("keeps the last verified channel facts when a turn-start refresh fails", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await f.inbox.mentions(filter, signal());
    f.query.mockRejectedValueOnce(new Error("Offline"));
    expect(await f.inbox.reads.channel(channel)).toMatchObject({
      dm: true,
      name: "Private DM",
    });
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    f.controller.abort();
    warn.mockRestore();
  }
});

it("does not back off mention polls that were cancelled", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fixture();
  try {
    vi.setSystemTime(Date.now() + 5_000);
    const cancelled = new AbortController();
    f.query.mockImplementationOnce(async () => {
      cancelled.abort();
      return eventsDto([mention]);
    });
    await expect(f.inbox.mentions(filter, cancelled.signal)).rejects.toThrow();
    expect(f.inbox.due()).toBe(true);
    f.query.mockRejectedValueOnce(new Error("Offline"));
    await expect(f.inbox.mentions(filter, signal())).rejects.toThrow("Offline");
    vi.setSystemTime(Date.now() + 37_500);
    expect(f.inbox.due()).toBe(true);
  } finally {
    f.controller.abort();
  }
});

it("only resolves owner-invisible channels that are DMs", async () => {
  const f = fixture();
  f.query.mockImplementation(async (filters: readonly ReadFilter[]) =>
    filters[0]?.kinds?.includes(39000)
      ? eventsDto([
          metadata(relay, channel, "Private stream", 1, [
            ["private"],
            ["t", "stream"],
          ]),
          roster(relay, channel, [agent.pubkey, sibling.pubkey], 1),
        ])
      : eventsDto([mention]),
  );
  try {
    await f.inbox.mentions(filter, signal());
    expect(f.inbox.channel(channel)).toBeUndefined();
  } finally {
    f.controller.abort();
  }
});

it("keeps backing off until a whole catch-up window reads", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const f = fixture();
  try {
    f.query.mockRejectedValueOnce(new Error("Offline"));
    await expect(f.inbox.mentions(filter, signal())).rejects.toThrow();
    f.query.mockRejectedValueOnce(new Error("Offline"));
    await expect(f.inbox.mentions(filter, signal())).rejects.toThrow();
    await f.inbox.mentions({ ...filter, limit: 1 }, signal());
    f.query.mockRejectedValueOnce(new Error("Offline"));
    await expect(f.inbox.mentions(filter, signal())).rejects.toThrow();
    vi.setSystemTime(Date.now() + 120_000 - 1);
    expect(f.inbox.due()).toBe(false);
    vi.setSystemTime(Date.now() + 1);
    expect(f.inbox.due()).toBe(true);
  } finally {
    f.controller.abort();
    random.mockRestore();
  }
});

it("keeps verified DM facts when a refresh returns only part of them", async () => {
  const f = fixture();
  try {
    await f.inbox.mentions(filter, signal());
    expect(f.inbox.channel(channel)).toBeDefined();
    f.query.mockImplementation(async (filters: readonly ReadFilter[]) =>
      filters[0]?.kinds?.includes(39000)
        ? eventsDto([roster(relay, channel, [agent.pubkey, sibling.pubkey], 1)])
        : eventsDto([mention]),
    );
    expect(await f.inbox.reads.channel(channel)).toMatchObject({ dm: true });
    await expect(f.inbox.readAsAgent(filter, signal())).rejects.toThrow(
      "all of a DM",
    );
    expect(f.inbox.channel(channel)).toBeDefined();
  } finally {
    f.controller.abort();
  }
});

it("reads past the owner only into confirmed DMs", async () => {
  const f = fixture();
  f.query.mockImplementation(async (filters: readonly ReadFilter[]) =>
    filters[0]?.kinds?.includes(39000)
      ? eventsDto([
          metadata(relay, channel, "Private stream", 1, [
            ["private"],
            ["t", "stream"],
          ]),
          roster(relay, channel, [agent.pubkey, sibling.pubkey], 1),
        ])
      : eventsDto([mention]),
  );
  try {
    expect(await f.inbox.readAsAgent(filter, signal())).toEqual([]);
    expect(await f.inbox.mentions(filter, signal())).toEqual(
      eventsDto([mention]),
    );
  } finally {
    f.controller.abort();
  }
});

it("applies a signed roster that removes the agent even when metadata is missing", async () => {
  const f = fixture();
  try {
    await f.inbox.mentions(filter, signal());
    expect(f.inbox.channel(channel)).toBeDefined();
    f.query.mockImplementation(async (filters: readonly ReadFilter[]) =>
      filters[0]?.kinds?.includes(39000)
        ? eventsDto([roster(relay, channel, [sibling.pubkey], 2)])
        : eventsDto([mention]),
    );
    expect(await f.inbox.reads.channel(channel)).toBeUndefined();
    expect(f.inbox.channel(channel)).toBeUndefined();
  } finally {
    f.controller.abort();
  }
});

it.each([130, 260])(
  "judges a read's %i DMs by that read, within the relay read limit",
  async (count) => {
    const f = fixture();
    const dms = Array.from({ length: count }, (_, i) => `dm-${i}`);
    const mentions = dms.map((id, i) =>
      message(sibling, id, `ask ${i}`, 100 + i, [["p", agent.pubkey]]),
    );
    f.query.mockImplementation(async (filters: readonly ReadFilter[]) =>
      filters[0]?.kinds?.includes(39000)
        ? eventsDto(
            dms
              .filter((id) => filters[0]?.["#d"]?.includes(id))
              .flatMap((id) => [
                metadata(relay, id, id, 1, [["private"], ["t", "dm"]]),
                roster(relay, id, [agent.pubkey, sibling.pubkey], 1),
              ]),
          )
        : eventsDto(mentions),
    );
    try {
      const read = await f.inbox.readAsAgent(
        { ids: mentions.map(({ id }) => id), limit: mentions.length },
        signal(),
      );
      expect(read).toHaveLength(count);
      for (const [filters] of f.query.mock.calls)
        for (const filter of filters as readonly ReadFilter[])
          expect(filter.limit).toBeLessThanOrEqual(500);
    } finally {
      f.controller.abort();
    }
  },
);
