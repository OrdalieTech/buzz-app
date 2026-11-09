import { assert, describe, expect, it, vi } from "vitest";
import { SOLO_LABEL } from "../solo/labels";
import { createChannelWrites } from "./channel-writes";
import type { Outbox, OutgoingEvent } from "./outbox";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import {
  keypair,
  message,
  metadata,
  roster,
  flush,
  scriptedTransport,
  signed,
} from "./testing";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { canAddMembers } from "../channel-members/members";
import type { ReadFilter, RelayEvent } from "./events";
const event = message(keypair(), "chat", "Work", 1);

it("keeps verified Solo chat roster reads available for sends without member-add capability", async () => {
  const viewer = keypair(),
    relay = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const current = roster(relay, id, [viewer.pubkey]);
  const query = vi.fn(
    async (filters: readonly { kinds?: readonly number[] }[]) =>
      filters.some((filter) => filter.kinds?.includes(39000))
        ? [
            current,
            signed(relay, {
              kind: 39000,
              content: "",
              tags: [
                ["d", id],
                ["t", "stream"],
                ["private"],
                ["t", SOLO_LABEL],
              ],
            }),
          ]
        : [current],
  );
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
    writer: {
      kinds: [9, 9007],
      sign: async (template) => signed(viewer, template),
      publish: async () => {},
    },
  });
  try {
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    expect(owner.session.outbox?.supports(9000)).toBe(false);
    await expect(
      owner.session.channelWrites.refreshMembership(id),
    ).resolves.toMatchObject({
      id,
      members: [viewer.pubkey],
    });
    expect(
      canAddMembers(owner.session, owner.session.channels.list().channels[0]),
    ).toBe(false);
    expect(
      query.mock.calls.some(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(39002)),
      ),
    ).toBe(true);
  } finally {
    owner.dispose();
  }
});

it("retries an identical create with its signed event, replaces a changed one and restores nothing", async () => {
  const viewer = keypair(),
    relay = keypair();
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new Error("connection lost");
  });
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async () => [],
    writer: { kinds: [9007], sign, publish },
  };
  const input = { name: "Release notes", visibility: "open" as const };
  const owner = createRelaySession(transport, { outboxStorage: storage });
  try {
    await expect(owner.session.channelCreation.create(input)).rejects.toThrow(
      /connection lost/,
    );
    await expect(owner.session.channelCreation.create(input)).rejects.toThrow(
      /connection lost/,
    );
    expect(sign).toHaveBeenCalledOnce();
    const [first, again] = publish.mock.calls.map(([event]) => event);
    expect(again).toEqual(first);

    await expect(
      owner.session.channelCreation.create({ ...input, name: "Changelog" }),
    ).rejects.toThrow(/connection lost/);
    expect(sign).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(records.map(({ event }) => event.tags[1])).toEqual([
        ["name", "Changelog"],
      ]),
    );
  } finally {
    owner.dispose();
  }

  // A later session never returns to the saved attempt.
  const restored = createRelaySession(transport, { outboxStorage: storage });
  try {
    await restored.session.outbox?.ready();
    await expect(
      restored.session.channelCreation.create({ ...input, name: "Changelog" }),
    ).rejects.toThrow(/connection lost/);
    expect(sign).toHaveBeenCalledTimes(3);
    const [saved, fresh] = publish.mock.calls.slice(-2).map(([event]) => event);
    expect(fresh?.tags[0]).not.toEqual(saved?.tags[0]);
  } finally {
    restored.dispose();
  }
});

it("forgets an unconfirmed create when its form closes", async () => {
  const viewer = keypair(),
    relay = keypair();
  let records: readonly OutgoingEvent[] = [];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      writer: {
        kinds: [9007],
        sign: async (template) => signed(viewer, template),
        publish: async () => {
          throw new Error("connection lost");
        },
      },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  try {
    await expect(
      owner.session.channelCreation.create({
        name: "Release notes",
        visibility: "open",
      }),
    ).rejects.toThrow(/connection lost/);
    expect(records).toHaveLength(1);
    owner.session.channelCreation.forget();
    await vi.waitFor(() => expect(records).toHaveLength(0));
  } finally {
    owner.dispose();
  }
});

it("removes a successfully refreshed channel creation from durable recovery", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let records: readonly OutgoingEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  try {
    const creating = owner.session.channelCreation.create({
      name: "Release notes",
      visibility: "open",
    });
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.kind === 9007)).toBe(true),
    );
    const id = records
      .find(({ event }) => event.kind === 9007)
      ?.event.tags.find(([name]) => name === "h")?.[1];
    expect(id).toBeTypeOf("string");
    const publicMetadata = signed(relay, {
      kind: 39000,
      content: JSON.stringify({ name: "Release notes" }),
      tags: [["d", id ?? ""], ["name", "Release notes"], ["public"]],
    });
    await vi.waitFor(() => expect(wire.pending).toHaveLength(2));
    for (const request of [wire.next(), wire.next()])
      request.respond([publicMetadata]);
    await vi.waitFor(() =>
      expect(owner.session.channels.get?.(id ?? "")?.readOnly).toBe(true),
    );
    let resolved = false;
    void creating.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);
    expect(records.some(({ event }) => event.kind === 9007)).toBe(true);

    owner.session.channels.refreshList?.();
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    wire
      .next()
      .respond([roster(relay, id ?? "", [viewer.pubkey]), publicMetadata]);
    await expect(creating).resolves.toBe(id);
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.kind === 9007)).toBe(false),
    );
  } finally {
    owner.dispose();
  }
});

it.each<["open" | "private", string[][]]>([
  ["open", [["public"]]],
  ["private", [["private"]]],
])(
  "admits a created %s channel through the store's exact read without rediscovering the roster",
  async (visibility, tags) => {
    const viewer = keypair(),
      relay = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let records: readonly OutgoingEvent[] = [];
    const owner = createRelaySession(
      {
        ...wire.transport,
        writer: {
          kinds: [9, 9000, 9007],
          sign: async (template) => signed(viewer, template),
          publish: async () => {},
        },
      },
      {
        outboxStorage: {
          load: () => structuredClone(records),
          save: (next) => {
            records = structuredClone(next);
          },
        },
      },
    );
    try {
      // A loaded sidebar whose complete viewer roster is still empty.
      owner.session.channels.ensureList();
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      wire.next().respond([]);
      await vi.waitFor(() =>
        expect(owner.session.channels.list()).toMatchObject({
          status: "ready",
          channels: [],
        }),
      );
      const notified = vi.fn();
      const unsubscribe = owner.session.channels.subscribeList(notified);
      const creating = owner.session.channelCreation.create({
        name: "Release notes",
        visibility,
      });
      await vi.waitFor(() =>
        expect(records.some(({ event }) => event.kind === 9007)).toBe(true),
      );
      const id =
        records
          .find(({ event }) => event.kind === 9007)
          ?.event.tags.find(([name]) => name === "h")?.[1] ?? "";
      // After publish: the outbox's receipt readback and the one exact lookup.
      await vi.waitFor(() => expect(wire.pending).toHaveLength(2));
      const exact = wire.pending.find((request) =>
        request.filters.some((filter) => filter["#d"]),
      );
      expect(exact?.filters).toEqual([
        {
          kinds: [39000],
          authors: [relay.pubkey],
          "#d": [id],
          limit: 2,
          consistency: "strong",
        },
        {
          kinds: [39002],
          authors: [relay.pubkey],
          "#d": [id],
          "#p": [viewer.pubkey],
          limit: 2,
          consistency: "strong",
        },
      ]);
      for (const request of wire.pending.splice(0))
        request.respond(
          request === exact &&
            request.filters.every((filter) => filter.consistency === "strong")
            ? [
                metadata(relay, id, "Release notes", undefined, tags),
                roster(relay, id, [viewer.pubkey]),
              ]
            : [],
        );
      await expect(creating).resolves.toBe(id);
      expect(owner.session.channels.list()).toMatchObject({
        status: "ready",
        channels: [{ id, name: "Release notes", members: [viewer.pubkey] }],
      });
      expect(notified).toHaveBeenCalledOnce();
      await flush();
      // No viewer-wide roster page followed the exact read.
      expect(wire.pending).toHaveLength(0);
      unsubscribe();
    } finally {
      owner.dispose();
    }
  },
);

it("creates a channel during initial discovery without committing a list of only that channel", async () => {
  const viewer = keypair(),
    relay = keypair();
  const other = "22222222-2222-4222-8222-222222222222";
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let records: readonly OutgoingEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    {
      outboxStorage: {
        load: () => structuredClone(records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  try {
    owner.session.channels.ensureList();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    expect(owner.session.channels.list().status).toBe("loading");
    const snapshots: ReturnType<ChannelQueries["list"]>[] = [];
    const unsubscribe = owner.session.channels.subscribeList(() =>
      snapshots.push(owner.session.channels.list()),
    );
    const creating = owner.session.channelCreation.create({
      name: "Release notes",
      visibility: "open",
    });
    await vi.waitFor(() =>
      expect(records.some(({ event }) => event.kind === 9007)).toBe(true),
    );
    const id =
      records
        .find(({ event }) => event.kind === 9007)
        ?.event.tags.find(([name]) => name === "h")?.[1] ?? "";
    // Ordinary reads remain frozen before creation; only writer reads see it.
    // Metadata answers the IDs requested by each discovery pass.
    const serve = () => {
      for (const request of wire.pending.splice(0)) {
        const [filter] = request.filters;
        request.respond(
          filter?.kinds?.includes(39002) && filter["#p"]
            ? (filter.consistency === "strong" ? [other, id] : [other]).map(
                (channel) => roster(relay, channel, [viewer.pubkey]),
              )
            : filter?.kinds?.includes(39000)
              ? (filter["#d"] ?? []).map((channel) =>
                  metadata(
                    relay,
                    channel,
                    channel === id ? "Release notes" : "Existing",
                    undefined,
                    [["public"]],
                  ),
                )
              : [],
        );
      }
    };
    await flush();
    // Only the in-flight discovery page and the outbox receipt readback; the
    // exact read would commit a ready list holding just the new channel.
    expect(wire.pending).toHaveLength(2);
    expect(
      wire.pending.some((request) =>
        request.filters.some((filter) => filter["#d"]),
      ),
    ).toBe(false);
    // The in-flight page was served before the relay accepted the create.
    serve();
    await vi.waitFor(() =>
      expect(
        snapshots.find((snapshot) => snapshot.status === "ready")?.channels,
      ).toEqual([expect.objectContaining({ id: other })]),
    );
    // The first pass finishes with its metadata read before the forced second
    // pass starts; that pass carries the new channel's roster.
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    serve();
    await vi.waitFor(() =>
      expect(
        wire.pending.some((request) =>
          request.filters.some((filter) => filter["#p"]),
        ),
      ).toBe(true),
    );
    expect(wire.pending[0]?.filters[0]?.consistency).toBe("strong");
    serve();
    await expect(creating).resolves.toBe(id);
    expect(owner.session.channels.list()).toMatchObject({
      status: "ready",
      channels: expect.arrayContaining([
        expect.objectContaining({ id: other }),
        expect.objectContaining({ id, members: [viewer.pubkey] }),
      ]),
    });
    // Finish metadata and prove the one-shot writer selection does not stick.
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    expect(wire.pending[0]?.filters[0]?.consistency).toBe("strong");
    serve();
    await vi.waitFor(() =>
      expect(owner.session.live.snapshot().roster.state).toBe("verified"),
    );
    owner.session.channels.refreshList?.();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    expect(wire.pending[0]?.filters[0]).not.toHaveProperty("consistency");
    // Canonical check, cited from the store's `resolve` docstring: no ready
    // snapshot ever held only the new channel.
    expect(
      snapshots
        .filter((snapshot) => snapshot.status === "ready")
        .every((snapshot) =>
          snapshot.channels.some((channel) => channel.id === other),
        ),
    ).toBe(true);
    unsubscribe();
  } finally {
    owner.dispose();
  }
});

it.each(["held", "failed"] as const)(
  "creates a system channel while initial discovery is %s without certifying the list",
  async (initial) => {
    const viewer = keypair(),
      relay = keypair();
    const other = "22222222-2222-4222-8222-222222222222";
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let records: readonly OutgoingEvent[] = [];
    const owner = createRelaySession(
      {
        ...wire.transport,
        channelIdentity: true,
        writer: {
          kinds: [9, 9000, 9007],
          sign: async (template) => signed(viewer, template),
          publish: async () => {},
        },
      },
      {
        outboxStorage: {
          load: () => structuredClone(records),
          save: (next) => {
            records = structuredClone(next);
          },
        },
      },
    );
    try {
      owner.session.channels.ensureList();
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      // A NIP-CL pass reads the viewer's system channels first.
      expect(wire.pending[0]?.filters[0]?.["#t"]).toEqual(["system"]);
      if (initial === "failed") {
        wire.next().fail(new Error("relay unavailable"));
        await vi.waitFor(() =>
          expect(owner.session.channels.list().status).toBe("error"),
        );
      }
      expect(owner.session.channels.list().status).toBe(
        initial === "held" ? "loading" : "error",
      );
      const snapshots: ReturnType<ChannelQueries["list"]>[] = [];
      const unsubscribe = owner.session.channels.subscribeList(() =>
        snapshots.push(owner.session.channels.list()),
      );
      const creating = owner.session.channelCreation.create({
        name: "For You records",
        visibility: "private",
        labels: ["for-you"],
        system: true,
      });
      await vi.waitFor(() =>
        expect(records.some(({ event }) => event.kind === 9007)).toBe(true),
      );
      const id =
        records
          .find(({ event }) => event.kind === 9007)
          ?.event.tags.find(([name]) => name === "h")?.[1] ?? "";
      // The relay lists the new system channel only to writer reads.
      const respond = (filter: ReadFilter): RelayEvent[] => {
        const strong = filter.consistency === "strong";
        if (filter.kinds?.includes(39000))
          return (filter["#d"] ?? []).flatMap((channel) =>
            channel === id
              ? strong
                ? [
                    metadata(relay, id, "For You records", undefined, [
                      ["private"],
                      ["hidden"],
                      ["t", "system"],
                      ["t", "for-you"],
                    ]),
                  ]
                : []
              : [metadata(relay, channel, "Existing", undefined, [["public"]])],
          );
        if (!filter.kinds?.includes(39002) || !filter["#p"]) return [];
        if (filter["#t"]?.includes("system"))
          return strong
            ? [
                signed(relay, {
                  kind: 39002,
                  content: "",
                  tags: [
                    ["d", id],
                    ["t", "system"],
                    ["p", viewer.pubkey],
                  ],
                }),
              ]
            : [];
        return filter["#d"] ? [] : [roster(relay, other, [viewer.pubkey])];
      };
      const serve = () => {
        for (const request of wire.pending.splice(0))
          request.respond(request.filters.flatMap(respond));
      };
      await flush();
      // No exact read: it would certify a list discovery has not made ready.
      expect(
        wire.pending.some((request) =>
          request.filters.some((filter) => filter["#d"]),
        ),
      ).toBe(false);
      for (let round = 0; round < 20; round++) {
        serve();
        const done = await Promise.race([
          creating.then(() => true),
          flush().then(() => false),
        ]);
        if (done) break;
      }
      await expect(creating).resolves.toBe(id);
      expect(owner.session.channels.get?.(id)).toMatchObject({
        id,
        channelType: "system",
        members: [viewer.pubkey],
      });
      // Every ready list came from a full pass: it carries the ordinary
      // channel and never the system one.
      const ready = snapshots.filter((snapshot) => snapshot.status === "ready");
      expect(ready.length).toBeGreaterThan(0);
      for (const snapshot of ready)
        expect(snapshot.channels.map((channel) => channel.id)).toEqual([other]);
      unsubscribe();
    } finally {
      owner.dispose();
    }
  },
);

it.each([true, false])(
  "confirms an exact own creation without admitting a channel missing its roster (receipt: %s)",
  async (found) => {
    const viewer = keypair(),
      relay = keypair();
    const channelId = "11111111-1111-4111-8111-111111111111";
    const creation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [["h", channelId]],
    });
    const publish = vi.fn(async () => {
      throw new PublishRejected("duplicate: channel already exists");
    });
    const query = vi.fn(async (filters: Parameters<RelaySessionRead>[0]) =>
      found && filters.some((filter) => filter.ids?.includes(creation.id))
        ? [creation]
        : [],
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        writer: {
          kinds: [9, 9000, 9007],
          sign: async (template) => signed(viewer, template),
          publish,
        },
      },
      {
        outboxStorage: {
          load: () => [
            { event: creation, signed: creation, delivery: "unknown" },
          ],
          save: () => {},
        },
      },
    );
    try {
      owner.session.channels.ensureList?.();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      if (found) {
        await owner.session.channelWrites.delivered(creation.id);
        expect(publish).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledWith(
          [
            {
              kinds: [9007],
              consistency: "strong",
              ids: [creation.id],
              authors: [viewer.pubkey],
              limit: 1,
            },
          ],
          expect.anything(),
          expect.anything(),
          expect.anything(),
        );
      } else {
        await expect(
          owner.session.channelWrites.delivered(creation.id),
        ).rejects.toThrow(/duplicate/);
      }
      expect(owner.session.channels.list().channels).toHaveLength(0);
      expect(() =>
        owner.session.messages.send(channelId, "Work", [viewer.pubkey]),
      ).toThrow();
    } finally {
      owner.dispose();
    }
  },
);
type RelaySessionRead = ReturnType<
  typeof createRelaySession
>["session"]["read"];
function setup(
  channelCreation = true,
  initialList: ReturnType<ChannelQueries["list"]> = {
    status: "ready",
    channels: [],
  },
  agents?: Parameters<typeof createChannelWrites>[6],
  relayAuthor?: string,
) {
  let items: readonly OutgoingEvent[] = [{ event, delivery: "accepted" }];
  let channelList = initialList;
  const listeners = new Set<() => void>();
  const listListeners = new Set<() => void>();
  const receipts = {
    snapshot: () => items,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const outbox: Outbox = {
    observeDismiss: () => () => {},
    observeSend: () => () => {},
    ready: async () => {},
    recovery: async () => undefined,
    recover: async () => {},
    acknowledge: async () => {},
    snapshot: () => [],
    subscribe: receipts.subscribe,
    supports: (kind) => channelCreation && [9, 9000, 9007].includes(kind),
    send: vi.fn(() => event.id),
    retry: vi.fn(() => {
      items = [{ event, delivery: "accepted" }];
      for (const fn of listeners) fn();
    }),
    dismiss: vi.fn(async () => {}),
  };
  // The store's exact lookup applies through discovery and notifies the list;
  // tests script that by changing the list from inside `resolve`. The real
  // store path is exercised by "admits a created ... through the store's exact
  // read without rediscovering the roster".
  const resolve = vi.fn<NonNullable<ChannelQueries["resolve"]>>(async () => {});
  // An agent addition confirms through the store's re-read of one roster the
  // list already carries. The real store path is exercised by "confirms an
  // agent added to a listed channel from one exact roster read without a full
  // discovery".
  const refreshRoster = vi.fn<NonNullable<ChannelQueries["refreshRoster"]>>(
    async () => true,
  );
  const refreshList = vi.fn();
  // The store's channel by id; system channels never join the list.
  let known: ChannelSummary | undefined;
  const channels = {
    list: () => channelList,
    get: (id: string) => (known?.id === id ? known : undefined),
    subscribeList: (fn: () => void) => {
      listListeners.add(fn);
      return () => {
        listListeners.delete(fn);
      };
    },
    resolve,
    refreshRoster,
    refreshList,
    start: vi.fn(),
    abandon: vi.fn(),
  } as unknown as ChannelQueries;
  const reader = { read: vi.fn(async () => [event]) };
  const controller = new AbortController();
  return {
    service: createChannelWrites(
      outbox,
      channels,
      reader,
      controller.signal,
      receipts,
      undefined,
      agents,
      relayAuthor,
      reader,
      channelCreation,
    ),
    outbox,
    channels,
    resolve,
    refreshRoster,
    refreshList,
    reader,
    listeners,
    listListeners,
    controller,
    setItems: (next: readonly OutgoingEvent[]) => {
      items = next;
    },
    setList: (next: ReturnType<ChannelQueries["list"]>) => {
      channelList = next;
      for (const fn of listListeners) fn();
    },
    setKnown: (next: ChannelSummary | undefined) => {
      known = next;
      for (const fn of listListeners) fn();
    },
  };
}
/** The signal `refresh` handed its exact lookup, released once the gate decides. */
function lookupSignal(
  test: ReturnType<typeof setup>,
  lookup:
    | ReturnType<typeof setup>["resolve"]
    | ReturnType<typeof setup>["refreshRoster"] = test.resolve,
) {
  const signal = lookup.mock.lastCall?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  return signal as AbortSignal;
}
it("confirms completed journal receipts after they leave the pending outbox", async () => {
  const test = setup();
  await test.service.delivered(event.id);
  expect(test.reader.read).not.toHaveBeenCalled();
  expect(test.listeners.size).toBe(0);
});
it("accepts already-applied creator membership without a refresh notification", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const member = "a".repeat(64);
  const test = setup(true, {
    status: "ready",
    channels: [{ id, name: "Release notes", members: [member] }],
  });
  await expect(
    test.service.refresh(id, { member }, false),
  ).resolves.toBeUndefined();
  // A list that already carries the signed membership needs no further read.
  expect(test.resolve).not.toHaveBeenCalled();
  expect(test.refreshList).not.toHaveBeenCalled();
  expect(test.listListeners.size).toBe(0);
});
it("admits a new channel from its exact lookup without a full discovery", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const member = "a".repeat(64);
  const test = setup();
  test.resolve.mockImplementation(async (ids) => {
    expect(ids).toEqual([id]);
    test.setList({
      status: "ready",
      channels: [{ id, name: "Release notes", members: [member] }],
    });
  });
  await expect(
    test.service.refresh(id, { member }, false),
  ).resolves.toBeUndefined();
  expect(test.resolve).toHaveBeenCalledExactlyOnceWith([id], {
    signal: expect.any(AbortSignal),
    consistency: "strong",
  });
  expect(lookupSignal(test).aborted).toBe(true);
  expect(test.refreshList).not.toHaveBeenCalled();
  expect(test.listListeners.size).toBe(0);
});
it("admits a channel the live roster lists while its exact lookup is still in flight", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const member = "a".repeat(64);
  const test = setup();
  test.resolve.mockImplementation(() => new Promise<void>(() => {}));
  const refreshing = test.service.refresh(id, { member }, false);
  await vi.waitFor(() => expect(test.resolve).toHaveBeenCalledOnce());
  const lookup = lookupSignal(test);
  expect(lookup.aborted).toBe(false);
  test.setList({
    status: "ready",
    channels: [{ id, name: "Release notes", members: [member] }],
  });
  await expect(refreshing).resolves.toBeUndefined();
  // The live roster decided, so the in-flight exact read is released rather
  // than left holding a reader slot until the connection closes.
  expect(lookup.aborted).toBe(true);
  expect(test.controller.signal.aborted).toBe(false);
  expect(test.refreshList).not.toHaveBeenCalled();
});
it.each(["idle", "loading", "error"] as const)(
  "waits for the full discovery instead of an exact lookup while the list is %s",
  async (status) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const member = "a".repeat(64);
    const test = setup(true, {
      status,
      channels: [],
      ...(status === "error" ? { error: "offline" } : {}),
    });
    let settled = false;
    const refreshing = test.service
      .refresh(id, { member }, false)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(test.refreshList).toHaveBeenCalledOnce());
    expect(test.resolve).not.toHaveBeenCalled();
    await flush();
    expect(settled).toBe(false);
    test.setList({
      status: "ready",
      channels: [{ id, name: "Release notes", members: [member] }],
    });
    await expect(refreshing).resolves.toBeUndefined();
    expect(test.resolve).not.toHaveBeenCalled();
    expect(test.listListeners.size).toBe(0);
  },
);
it.each([
  ["without the viewer", async () => {}],
  [
    "as stale",
    async () => {
      throw new DOMException("Stale channel resolution", "AbortError");
    },
  ],
])(
  "falls back to the full discovery when the exact lookup returns %s",
  async (_outcome, lookup) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const member = "a".repeat(64);
    const test = setup();
    test.resolve.mockImplementation(lookup);
    let settled = false;
    const refreshing = test.service
      .refresh(id, { member }, false)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(test.refreshList).toHaveBeenCalledOnce());
    expect(test.resolve).toHaveBeenCalledExactlyOnceWith([id], {
      signal: expect.any(AbortSignal),
      consistency: "strong",
    });
    expect(test.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      test.refreshList.mock.invocationCallOrder[0] ?? 0,
    );
    await flush();
    expect(settled).toBe(false);
    test.setList({
      status: "ready",
      channels: [{ id, name: "Release notes", members: [member] }],
    });
    await expect(refreshing).resolves.toBeUndefined();
    expect(test.refreshList).toHaveBeenCalledOnce();
    expect(test.listListeners.size).toBe(0);
  },
);
/** A ready list already carrying the channel, before and after an agent joins. */
function listedChannel() {
  const id = "11111111-1111-4111-8111-111111111111";
  const viewer = "b".repeat(64);
  const member = "a".repeat(64);
  const before = {
    status: "ready" as const,
    channels: [{ id, name: "Release notes", members: [viewer] }],
  };
  const after = {
    status: "ready" as const,
    channels: [{ id, name: "Release notes", members: [member, viewer] }],
  };
  return { id, viewer, member, before, after };
}
it("confirms an agent added to a listed channel from one exact roster read without a full discovery", async () => {
  const { id, member, before, after } = listedChannel();
  const test = setup(true, before);
  test.refreshRoster.mockImplementation(async (channelId) => {
    expect(channelId).toBe(id);
    test.setList(after);
    return true;
  });
  await expect(
    test.service.refresh(id, { member }, false),
  ).resolves.toBeUndefined();
  // The store's `resolve` skips an id it already authorizes, so the gate never
  // asked it; the roster re-read carried the signed evidence instead.
  expect(test.resolve).not.toHaveBeenCalled();
  expect(test.refreshRoster).toHaveBeenCalledExactlyOnceWith(id, {
    signal: expect.any(AbortSignal),
    consistency: "strong",
  });
  expect(lookupSignal(test, test.refreshRoster).aborted).toBe(true);
  expect(test.refreshList).not.toHaveBeenCalled();
  expect(test.listListeners.size).toBe(0);
});
describe("system channel membership", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const viewer = "b".repeat(64);
  const agent = "a".repeat(64);
  const system = (members: string[]): ChannelSummary => ({
    id,
    name: "For You records",
    channelType: "system",
    members,
  });
  it("admits a created system channel through the store's exact read", async () => {
    const test = setup();
    test.resolve.mockImplementation(async (ids) => {
      expect(ids).toEqual([id]);
      test.setKnown(system([viewer]));
    });
    await expect(
      test.service.refresh(id, { member: viewer, system: true }, false),
    ).resolves.toBeUndefined();
    expect(test.resolve).toHaveBeenCalledOnce();
    expect(test.refreshRoster).not.toHaveBeenCalled();
    expect(test.refreshList).not.toHaveBeenCalled();
  });
  it("confirms an agent added to a joined system channel by re-reading its roster", async () => {
    const test = setup();
    test.setKnown(system([viewer]));
    // The store's `resolve` skips a channel it already authorizes; a gate that
    // asked it would wait for evidence that never comes.
    test.refreshRoster.mockImplementation(async (channelId) => {
      expect(channelId).toBe(id);
      test.setKnown(system([agent, viewer]));
      return true;
    });
    await expect(
      test.service.refresh(id, { member: agent, system: true }, false),
    ).resolves.toBeUndefined();
    expect(test.resolve).not.toHaveBeenCalled();
    expect(test.refreshRoster).toHaveBeenCalledExactlyOnceWith(id, {
      signal: expect.any(AbortSignal),
      consistency: "strong",
    });
    expect(lookupSignal(test, test.refreshRoster).aborted).toBe(true);
    expect(test.refreshList).not.toHaveBeenCalled();
    expect(test.listListeners.size).toBe(0);
  });
});
it("confirms an addition the live roster lists while its roster read is still in flight", async () => {
  const { id, member, before, after } = listedChannel();
  const test = setup(true, before);
  test.refreshRoster.mockImplementation(() => new Promise<boolean>(() => {}));
  const refreshing = test.service.refresh(id, { member }, false);
  await vi.waitFor(() => expect(test.refreshRoster).toHaveBeenCalledOnce());
  const lookup = lookupSignal(test, test.refreshRoster);
  expect(lookup.aborted).toBe(false);
  test.setList(after);
  await expect(refreshing).resolves.toBeUndefined();
  // The live roster decided, so the in-flight read releases its reader slot.
  expect(lookup.aborted).toBe(true);
  expect(test.controller.signal.aborted).toBe(false);
  expect(test.resolve).not.toHaveBeenCalled();
  expect(test.refreshList).not.toHaveBeenCalled();
});
it.each(["idle", "loading", "error"] as const)(
  "waits for the full discovery instead of a roster read while the list carrying the channel is %s",
  async (status) => {
    const { id, member, before, after } = listedChannel();
    const test = setup(true, {
      ...before,
      status,
      ...(status === "error" ? { error: "offline" } : {}),
    });
    let settled = false;
    const refreshing = test.service
      .refresh(id, { member }, false)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(test.refreshList).toHaveBeenCalledOnce());
    // Either exact read would commit a ready list over a list that is not.
    expect(test.refreshRoster).not.toHaveBeenCalled();
    expect(test.resolve).not.toHaveBeenCalled();
    await flush();
    expect(settled).toBe(false);
    test.setList(after);
    await expect(refreshing).resolves.toBeUndefined();
    expect(test.refreshRoster).not.toHaveBeenCalled();
    expect(test.listListeners.size).toBe(0);
  },
);
it.each([
  ["without the member", async () => {}],
  [
    "as stale",
    async () => {
      throw new DOMException("Stale roster refresh", "AbortError");
    },
  ],
])(
  "falls back to the full discovery when the roster read returns %s",
  async (_outcome, lookup) => {
    const { id, member, before, after } = listedChannel();
    const test = setup(true, before);
    test.refreshRoster.mockImplementation(async () => {
      await lookup();
      return true;
    });
    let settled = false;
    const refreshing = test.service
      .refresh(id, { member }, false)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(test.refreshList).toHaveBeenCalledOnce());
    expect(test.refreshRoster).toHaveBeenCalledExactlyOnceWith(id, {
      signal: expect.any(AbortSignal),
      consistency: "strong",
    });
    expect(test.refreshRoster.mock.invocationCallOrder[0]).toBeLessThan(
      test.refreshList.mock.invocationCallOrder[0] ?? 0,
    );
    expect(test.resolve).not.toHaveBeenCalled();
    await flush();
    expect(settled).toBe(false);
    test.setList(after);
    await expect(refreshing).resolves.toBeUndefined();
    expect(test.refreshList).toHaveBeenCalledOnce();
    expect(test.listListeners.size).toBe(0);
  },
);
it.each([true, false])(
  "gives up 15 seconds after refresh starts when the exact lookup never answers (solo: %s)",
  async (soloOnly) => {
    vi.useFakeTimers();
    try {
      const id = "11111111-1111-4111-8111-111111111111";
      const member = "a".repeat(64);
      const test = setup();
      test.resolve.mockImplementation(() => new Promise<void>(() => {}));
      let settled = false;
      const refreshing = test.service
        .refresh(id, { member }, soloOnly)
        .finally(() => {
          settled = true;
        });
      const failure = expect(refreshing).rejects.toThrow(
        soloOnly
          ? /membership is still loading/
          : /Agent addition is unconfirmed/,
      );
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await failure;
      // The deadline decided; a hung exact read must not start discovery late,
      // and its reader slot is released without waiting for the connection.
      expect(test.refreshList).not.toHaveBeenCalled();
      expect(lookupSignal(test).aborted).toBe(true);
      expect(test.controller.signal.aborted).toBe(false);
      expect(test.listListeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
it("counts the fallback discovery against the same 15 second deadline", async () => {
  vi.useFakeTimers();
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    const member = "a".repeat(64);
    const test = setup();
    let settled = false;
    const refreshing = test.service
      .refresh(id, { member }, false)
      .finally(() => {
        settled = true;
      });
    const failure = expect(refreshing).rejects.toThrow(
      /Agent addition is unconfirmed/,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.refreshList).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(test.listListeners.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it("retries the same unknown event and confirms restored receipts through verified reads", async () => {
  const test = setup();
  test.setItems([{ event, delivery: "unknown" }]);
  await test.service.delivered(event.id);
  expect(test.outbox.retry).toHaveBeenCalledWith(event.id);
  test.setItems([]);
  await test.service.delivered(event.id);
  expect(test.reader.read).toHaveBeenCalled();
});
it("fails closed when capability is absent or connection ends", async () => {
  const unsupported = setup(false);
  expect(unsupported.service.available).toBe(false);
  expect(() =>
    unsupported.service.create("11111111-1111-4111-8111-111111111111", "Work"),
  ).toThrow(/does not support/);
  const test = setup();
  test.setItems([{ event, delivery: "sending" }]);
  const pending = test.service.delivered(event.id);
  test.controller.abort();
  await expect(pending).rejects.toThrow(/connection changed/);
  expect(test.listeners.size).toBe(0);
});

it("permits editing only after a definitive rejection, never an uncertain send", async () => {
  const test = setup();
  test.setItems([{ event, delivery: "unknown" }]);
  expect(test.service.failed(event.id)).toBe(false);
  await expect(test.service.discardFailed(event.id)).rejects.toThrow(
    /unconfirmed/,
  );
  expect(test.outbox.dismiss).not.toHaveBeenCalled();
  test.setItems([{ event, delivery: "failed" }]);
  expect(test.service.failed(event.id)).toBe(true);
  await test.service.discardFailed(event.id);
  expect(test.outbox.dismiss).toHaveBeenCalledWith(event.id);
});

it("creates an ordinary stream with explicit visibility and optional description", () => {
  const test = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  test.service.createChannel(id, "  Release notes  ", "open", "  Updates  ");
  expect(test.outbox.send).toHaveBeenCalledWith(
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Release notes"],
        ["visibility", "open"],
        ["channel_type", "stream"],
        ["about", "Updates"],
      ],
    },
    undefined,
    undefined,
  );
  test.service.createChannel(id, "Private", "private");
  expect(test.outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Private"],
        ["visibility", "private"],
        ["channel_type", "stream"],
      ],
    },
    undefined,
    undefined,
  );
  test.service.createChannel(id, "Standup", "open", undefined, 604800);
  expect(test.outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Standup"],
        ["visibility", "open"],
        ["channel_type", "stream"],
        ["ttl", "604800"],
      ],
    },
    undefined,
    undefined,
  );
  expect(test.outbox.send).toHaveBeenCalledTimes(3);
  expect(() => test.service.createChannel(id, " ", "open")).toThrow(/name/);
  expect(() =>
    test.service.createChannel(id, "Work", "open", "x".repeat(1001)),
  ).toThrow(/description/);
  expect(() =>
    test.service.createChannel(id, "Work", "open", undefined, 0),
  ).toThrow(/duration/);
});

it("recovers a lost normal-channel creation acknowledgment only with its exact verified event", async () => {
  const test = setup();
  const creation = signed(keypair(), {
    kind: 9007,
    content: "",
    tags: [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Notes"],
    ],
  });
  test.setItems([{ event: creation, delivery: "unknown" }]);
  test.reader.read.mockResolvedValueOnce([creation]);
  await test.service.delivered(creation.id);
  expect(test.outbox.retry).not.toHaveBeenCalled();
  expect(test.reader.read).toHaveBeenCalledWith(
    [
      {
        kinds: [39000, 39002],
        consistency: "strong",
        "#d": ["11111111-1111-4111-8111-111111111111"],
        limit: 2,
      },
      { ids: [creation.id], limit: 1, consistency: "strong" },
    ],
    expect.anything(),
  );
});

it.each([true, false])(
  "checks fresh roster access before recovering creation (member: %s)",
  async (member) => {
    const viewer = keypair(),
      relay = keypair();
    const channelId = "11111111-1111-4111-8111-111111111111";
    const creation = signed(viewer, {
      kind: 9007,
      content: "",
      tags: [["h", channelId]],
    });
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async (filters) =>
        filters.some((filter) => filter.ids)
          ? [creation, roster(relay, channelId, member ? [viewer.pubkey] : [])]
          : [],
    });
    try {
      owner.session.channels.ensureList?.();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      let items: readonly OutgoingEvent[] = [
        { event: creation, delivery: "unknown" },
      ];
      const outbox: Outbox = {
        observeDismiss: () => () => {},
        observeSend: () => () => {},
        ready: async () => {},
        recovery: async () => undefined,
        recover: async () => {},
        acknowledge: async () => {},
        supports: () => true,
        send: vi.fn(),
        snapshot: () => items,
        subscribe: () => () => {},
        retry: vi.fn(() => {
          items = [{ event: creation, delivery: "failed" }];
        }),
        dismiss: async () => {},
      };
      const service = createChannelWrites(
        outbox,
        owner.session.channels,
        {
          read: async (filters, options) => {
            const visible = await owner.session.read(filters, options);
            return visible.some((event) => event.id === creation.id)
              ? [creation]
              : [];
          },
        },
        new AbortController().signal,
      );
      if (member) {
        await service.delivered(creation.id);
        expect(outbox.retry).not.toHaveBeenCalled();
      } else {
        await expect(service.delivered(creation.id)).rejects.toThrow(
          /could not be confirmed/,
        );
        expect(outbox.retry).toHaveBeenCalledWith(creation.id);
      }
    } finally {
      owner.dispose();
    }
  },
);

it("confirms shared delivery without channel-creation authority while additions remain gated", async () => {
  const test = setup(false);
  await expect(test.service.delivered(event.id)).resolves.toBeUndefined();
  await expect(
    test.service.delivered(event.id, () => true, true),
  ).rejects.toThrow(/cannot add agents/);
  test.controller.abort();
  await expect(test.service.delivered(event.id)).rejects.toThrow(
    /cannot confirm/,
  );
});

it("rejects an addition cancelled during delivery readback", async () => {
  const test = setup();
  test.setItems([]);
  let active = true;
  test.reader.read.mockImplementationOnce(async () => {
    active = false;
    return [event];
  });
  await expect(
    test.service.delivered(event.id, () => active, true),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(test.outbox.retry).not.toHaveBeenCalled();
});

it("creates a stream with NIP-CL labels after about and ttl, and rejects bad labels before sending", () => {
  const test = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  test.service.createChannel(
    id,
    "Records",
    "private",
    "For You records",
    604800,
    undefined,
    { labels: ["for-you", "app:records", "for-you"] },
  );
  expect(test.outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "Records"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["about", "For You records"],
        ["ttl", "604800"],
        ["t", "for-you"],
        ["t", "app:records"],
      ],
    },
    undefined,
    undefined,
  );
  for (const labels of [["system"], ["Upper"], [""]])
    expect(() =>
      test.service.createChannel(
        id,
        "Records",
        "private",
        undefined,
        undefined,
        undefined,
        { labels },
      ),
    ).toThrow(/channel labels/);
  expect(test.outbox.send).toHaveBeenCalledTimes(1);
});

it.each([
  ["labeled", { labels: ["for-you"] }],
  ["system", { system: true as const }],
])(
  "refuses a new %s channel without signing when the relay does not advertise NIP-CL",
  async (_, extra) => {
    const viewer = keypair(),
      relay = keypair();
    const sign = vi.fn();
    const publish = vi.fn();
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query: async () => [],
        writer: { kinds: [9, 9000, 9007], sign, publish },
      },
      { outboxStorage: { load: () => [], save() {} } },
    );
    try {
      await expect(
        owner.session.channelCreation.create({
          name: "Records",
          visibility: "private",
          ...extra,
        }),
      ).rejects.toThrow(/does not support channel labels or system channels/);
      expect(sign).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(owner.session.outbox?.snapshot() ?? []).toEqual([]);
    } finally {
      owner.dispose();
    }
  },
);

it("creates a Solo chat in its single durable outbox command, with validated lifetime and name", () => {
  const h = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  expect(h.service.available).toBe(true);
  const command = (extra: string[][]) => ({
    kind: 9007,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ...extra,
    ],
  });
  h.service.create(id, "Work");
  expect(h.outbox.send).toHaveBeenLastCalledWith(
    command([["t", SOLO_LABEL]]),
    undefined,
    undefined,
  );
  h.service.create(id, "Work", 600);
  expect(h.outbox.send).toHaveBeenLastCalledWith(
    command([
      ["ttl", "600"],
      ["t", SOLO_LABEL],
    ]),
    undefined,
    undefined,
  );
  h.service.create(id, "Work", 600, true);
  expect(h.outbox.send).toHaveBeenLastCalledWith(
    command([
      ["ttl", "600"],
      ["t", SOLO_LABEL],
      ["t", "buzz.session.named"],
    ]),
    undefined,
    undefined,
  );
  for (const ttl of [0, -1, 1.5, 2147483648, NaN])
    expect(() => h.service.create(id, "Work", ttl)).toThrow("duration");
  expect(h.outbox.send).toHaveBeenCalledTimes(3);
});

it("creates a NIP-CL system channel with its labels", () => {
  const test = setup();
  const id = "22222222-2222-4222-8222-222222222222";
  test.service.createChannel(
    id,
    "For You records",
    "private",
    undefined,
    undefined,
    undefined,
    { labels: ["for-you"], system: true },
  );
  expect(test.outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "For You records"],
        ["visibility", "private"],
        ["channel_type", "system"],
        ["t", "for-you"],
      ],
    },
    undefined,
    undefined,
  );
});

describe("starting a Solo chat", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const viewer = "f".repeat(64);
  const agent = "a".repeat(64);
  const listed = (members: string[]) => ({
    status: "ready" as const,
    channels: [{ id, name: "Work", channelType: "solo" as const, members }],
  });

  it("names its agents in the create, lists it at once, and settles with the create", async () => {
    const test = setup();
    test.resolve.mockImplementation(async () => {
      test.setList(listed([viewer, agent]));
    });
    const { create, ready } = test.service.start(id, "Work", [agent]);
    expect(create).toBe(event.id);
    expect(test.outbox.send).toHaveBeenCalledExactlyOnceWith(
      {
        kind: 9007,
        content: "",
        tags: [
          ["h", id],
          ["name", "Work"],
          ["visibility", "private"],
          ["channel_type", "stream"],
          ["t", SOLO_LABEL],
          ["p", agent],
        ],
      },
      undefined,
      undefined,
    );
    expect(test.channels.start).toHaveBeenCalledExactlyOnceWith({
      id,
      name: "Work",
      members: [agent],
      labels: [SOLO_LABEL],
      ttlSeconds: undefined,
    });
    expect(test.service.starting(id)).toBe(ready);
    await ready;
    // The relay added the agent with the create: no separate add.
    expect(test.outbox.send).toHaveBeenCalledOnce();
    await flush();
    expect(test.service.starting(id)).toBeUndefined();
    expect(test.channels.abandon).not.toHaveBeenCalled();
  });

  it("takes events once the create is OK, without waiting for the chat to confirm", async () => {
    const test = setup();
    let confirm = () => {};
    test.resolve.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          confirm = () => {
            test.setList(listed([viewer, agent]));
            resolve();
          };
        }),
    );
    const { ready } = test.service.start(id, "Work", [agent]);
    try {
      await ready;
      await flush();
      expect(test.service.starting(id)).toBeUndefined();
      // The confirming read is still open: it no longer holds the chat.
      await vi.waitFor(() => expect(test.resolve).toHaveBeenCalledOnce());
      expect(test.outbox.send).toHaveBeenCalledOnce();
    } finally {
      confirm();
    }
    await flush();
    expect(test.channels.abandon).not.toHaveBeenCalled();
  });

  it("reads a starting chat's roster only once the relay has its create", async () => {
    const test = setup(true, undefined, undefined, "b".repeat(64));
    test.setItems([{ event, delivery: "sending" }]);
    const roster = () =>
      (
        test.reader.read.mock.calls as unknown as [{ kinds?: number[] }[]][]
      ).filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(39002)),
      ).length;
    const { ready } = test.service.start(id, "Work", [agent]);
    const membership = test.service.refreshMembership(id);
    membership.catch(() => {});
    await flush();
    expect(roster()).toBe(0);
    test.setItems([{ event, delivery: "accepted" }]);
    for (const fn of test.listeners) fn();
    await ready;
    await membership.catch(() => {});
    expect(roster()).toBe(1);
  });

  it("drops the pending chat when the relay refuses the create", async () => {
    const test = setup();
    test.setItems([{ event, delivery: "failed" }]);
    test.reader.read.mockResolvedValue([]);
    vi.mocked(test.outbox.retry).mockImplementation(() => {
      test.setItems([
        { event, delivery: "failed", error: "rejected", refused: true },
      ]);
      for (const fn of test.listeners) fn();
    });
    const { ready } = test.service.start(id, "Work", [agent]);
    await expect(ready).rejects.toThrow("rejected");
    await flush();
    expect(test.channels.abandon).toHaveBeenCalledExactlyOnceWith(id);
    expect(test.service.starting(id)).toBeUndefined();
  });

  it("retries a create that failed on this device before the relay saw it", async () => {
    vi.useFakeTimers();
    try {
      const test = setup();
      test.setItems([{ event, delivery: "failed" }]);
      test.reader.read.mockResolvedValue([]);
      let tries = 0;
      vi.mocked(test.outbox.retry).mockImplementation(() => {
        tries++;
        test.setItems([
          tries === 1
            ? { event, delivery: "failed", error: "Signing timed out" }
            : { event, delivery: "accepted" },
        ]);
        for (const fn of test.listeners) fn();
      });
      const { ready } = test.service.start(id, "Work", [agent]);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(ready).resolves.toBeUndefined();
      expect(tries).toBe(2);
      expect(test.channels.abandon).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// The real signing boundary proves the Solo wrapper preserves the Outbox gate.
it("cancels a guarded Solo create after signing starts and requires a fresh gate after restore", async () => {
  const viewer = keypair(),
    relay = keypair();
  let active = true;
  let release!: (event: RelayEvent) => void;
  let template: Parameters<typeof signed>[1] | undefined;
  let records: readonly OutgoingEvent[] = [];
  const publish = vi.fn(async () => {});
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    channelIdentity: true as const,
    media: () => undefined,
    query: async () => [],
    writer: {
      kinds: [9007],
      publish,
      sign: (input: Parameters<typeof signed>[1]) => {
        template = input;
        return new Promise<RelayEvent>((resolve) => {
          release = resolve;
        });
      },
    },
  };
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const owner = createRelaySession(transport, { outboxStorage: storage });
  try {
    const outbox = owner.session.outbox;
    assert.exists(outbox);
    await outbox.ready();
    const id = owner.session.channelWrites.create(
      "11111111-1111-4111-8111-111111111111",
      "Work",
      undefined,
      true,
      [viewer.pubkey],
      () => active,
    );
    await vi.waitFor(() => expect(template).toBeDefined());
    expect(
      outbox.snapshot().find((item) => item.event.id === id)?.guarded,
    ).toBe(true);
    active = false;
    assert.exists(template);
    release(signed(viewer, template));
    await vi.waitFor(() =>
      expect(
        outbox.snapshot().find((item) => item.event.id === id)?.delivery,
      ).toBe("failed"),
    );
    expect(publish).not.toHaveBeenCalled();
    owner.dispose();
    const restored = createRelaySession(transport, { outboxStorage: storage });
    try {
      const restoredOutbox = restored.session.outbox;
      assert.exists(restoredOutbox);
      await restoredOutbox.ready();
      expect(() => restoredOutbox.retry(id)).toThrow(/cancelled/);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      restored.dispose();
    }
  } finally {
    owner.dispose();
  }
});
