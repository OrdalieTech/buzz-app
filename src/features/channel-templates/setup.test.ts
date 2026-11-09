// @vitest-environment jsdom
import { afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import {
  createChannelSetup,
  type ChannelCreationInput,
  type ChannelSetup,
} from "./setup";
import type { Outbox, OutgoingEvent } from "../relay/outbox";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { createRelaySession } from "../relay/session";
import { matchesEvent } from "../relay/projection";
import type { ReadFilter, RelayEvent } from "../relay/events";

const viewer = keypair();
const agent = keypair().pubkey;
const input: ChannelCreationInput = {
  name: "Daily",
  visibility: "private",
  setup: {
    agents: [agent],
    canvas: "# Plan",
    groupId: "work",
    templateId: "daily",
  },
};
const empty: ChannelSetup = {
  agents: [],
  canvas: "",
  groupId: "",
  templateId: "daily",
};
// The template resolved to agents and a Canvas in the general Channels section.
const general: ChannelCreationInput = {
  ...input,
  setup: {
    agents: [agent],
    canvas: "# Plan",
    groupId: "",
    templateId: "daily",
  },
};
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _key: string,
        _opts: unknown,
        run: (lock: object) => unknown,
      ) => run({}),
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
});
function fixture() {
  const events: OutgoingEvent[] = [];
  let clock = 1_700_000_000;
  let canvas: string | undefined;
  const outbox: Outbox = {
    snapshot: () => events,
    subscribe: () => () => {},
    observeDismiss: () => () => {},
    observeSend: () => () => {},
    ready: async () => {},
    recovery: async () => undefined,
    recover: async () => {},
    acknowledge: async () => {},
    supports: () => true,
    send: vi.fn((value) => {
      const event = signed(viewer, { ...value, created_at: clock++ });
      events.push({ event, delivery: "accepted" });
      return event.id;
    }),
    retry: vi.fn(),
    dismiss: vi.fn(async (id: string) => {
      const index = events.findIndex((item) => item.event.id === id);
      if (index >= 0) events.splice(index, 1);
    }),
  };
  const opts = {
    scope: "setup-test",
    changed: vi.fn(),
    outbox,
    local: outbox,
    create: vi.fn((id: string, _input: ChannelCreationInput) =>
      outbox.send({ kind: 9007, content: "", tags: [["h", id]] }),
    ),
    delivered: vi.fn(async (_id: string, _active?: () => boolean) => {}),
    confirm: vi.fn(async (id: string) => {
      if (events.find((e) => e.event.id === id)?.event.kind === 40100)
        canvas = id;
    }),
    refresh: vi.fn(async (_id: string, _member: string) => {}),
    canvasHead: vi.fn(async () => canvas),
    place: vi.fn(async (_id: string, _group: string) => {}),
    star: vi.fn(async (_id: string) => {}),
    preflight: vi.fn(async (_input: ChannelCreationInput) => {}),
    signal: new AbortController().signal,
  };
  return {
    opts,
    events,
    outbox,
    setup: createChannelSetup(opts),
    setCanvas: (id: string) => {
      canvas = id;
    },
  };
}

function receipts() {
  return Object.keys(localStorage).filter((key) =>
    key.startsWith("buzz-channel-setup.v2:setup-test:"),
  );
}

it.each(["ready", "unavailable", "failed", "conflicting"] as const)(
  "integrates Starred creation with the session preference writer (%s)",
  async (status) => {
    const relay = keypair();
    const events: RelayEvent[] = [];
    let starred: readonly string[] = [];
    const writeStar = vi.fn(
      async ({ channelId }: { channelId: string; starred: boolean }) => {
        if (status === "failed") throw new Error("Star publication failed");
        starred = [...starred, channelId];
        return starred;
      },
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: "https://starred.example.test",
        media: () => undefined,
        query: async (filters) =>
          events.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        channelKit: { prepare: async () => "", decode: async () => [] },
        decodeSidebarPreferences: async () => ({
          sections: [],
          assignments: {},
          starred,
          muted: [],
        }),
        writeSidebarAssignment: async () => ({ sections: [], assignments: {} }),
        ...(status !== "unavailable" ? { writeSidebarStar: writeStar } : {}),
        writer: {
          kinds: [9007],
          sign: async (template) => signed(viewer, template),
          publish: async (event) => {
            events.push(event);
            const id = event.tags.find(([tag]) => tag === "h")?.[1];
            assert.exists(id);
            events.push(
              metadata(relay, id, "Starred channel"),
              roster(relay, id, [viewer.pubkey]),
            );
          },
        },
      },
      { outboxStorage: { load: async () => [], save: async () => {} } },
    );
    const draft: ChannelCreationInput = {
      name: "Starred channel",
      visibility: "open",
      setup: {
        agents: [],
        canvas: "",
        groupId: status === "conflicting" ? "work" : "",
        templateId: "",
        starred: true,
      },
    };
    try {
      const creation = owner.session.channelCreation.create(draft);
      if (status === "unavailable" || status === "conflicting") {
        await expect(creation).rejects.toThrow(
          status === "unavailable"
            ? "Starred placement is unavailable"
            : "Invalid template or group selection",
        );
        expect(events.filter((event) => event.kind === 9007)).toEqual([]);
        return;
      }
      const id = await creation;
      if (status === "failed") {
        await vi.waitFor(() =>
          expect(owner.session.channelCreation.notices()).toEqual([
            expect.objectContaining({
              id,
              error: expect.stringContaining("Star publication failed"),
            }),
          ]),
        );
      } else {
        const receipt = `buzz-channel-setup.v2:https://starred.example.test:${viewer.pubkey}:${id}`;
        await vi.waitFor(() =>
          expect(localStorage.getItem(receipt)).toBeNull(),
        );
        expect(
          owner.session.sidebarPreferences.snapshot().data?.starred,
        ).toContain(id);
        expect(owner.session.channelCreation.notices()).toEqual([]);
      }
      expect(writeStar).toHaveBeenCalledExactlyOnceWith(
        { channelId: id, starred: true },
        expect.any(AbortSignal),
      );
      expect(events.filter((event) => event.kind === 9007)).toHaveLength(1);
    } finally {
      owner.dispose();
    }
  },
);
it.each(["group", "starred"] as const)(
  "applies %s placement before the new channel first lists or opens",
  async (destination) => {
    const relay = keypair();
    const events: RelayEvent[] = [];
    const sections = [{ id: "work", name: "Work", order: 0 }];
    let assignments: Record<string, string> = {};
    let starred: readonly string[] = [];
    let created: string | undefined;
    // The first read of the new channel's metadata or roster is the re-read.
    const listed = hold();
    const listing = hold();
    // A preference re-read after Create stays held: placement must not wait on it.
    const reread = hold();
    const writeAssignment = vi.fn(
      async ({
        channelId,
        sectionId,
      }: {
        channelId?: string;
        sectionId?: string;
      }) => {
        if (channelId && sectionId)
          assignments = { ...assignments, [channelId]: sectionId };
        return { sections, assignments };
      },
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: "https://placement.example.test",
        media: () => undefined,
        query: async (filters) => {
          if (created) {
            if (filters.some((filter) => filter.kinds?.includes(30078)))
              await reread.promise;
            const row = events.filter((event) =>
              event.tags.some(
                ([tag, value]) => tag === "d" && value === created,
              ),
            );
            if (
              row.some((event) => filters.some((f) => matchesEvent(event, f)))
            ) {
              listed.release();
              await listing.promise;
            }
          }
          return events.filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          );
        },
        channelKit: { prepare: async () => "", decode: async () => [] },
        decodeSidebarPreferences: async () => ({
          sections,
          assignments,
          starred,
          muted: [],
        }),
        writeSidebarAssignment: writeAssignment,
        writeSidebarStar: async ({ channelId, starred: on }) => {
          starred = on
            ? [...starred, channelId]
            : starred.filter((id) => id !== channelId);
          return starred;
        },
        writer: {
          kinds: [9007],
          sign: async (template) => signed(viewer, template),
          publish: async (event) => {
            events.push(event);
            created = event.tags.find(([tag]) => tag === "h")?.[1];
            assert.exists(created);
            events.push(
              metadata(relay, created, "Placed"),
              roster(relay, created, [viewer.pubkey]),
            );
          },
        },
      },
      { outboxStorage: { load: async () => [], save: async () => {} } },
    );
    try {
      let admitted = false;
      const creation = owner.session.channelCreation
        .create({
          name: "Placed",
          visibility: "open",
          setup: {
            agents: [],
            canvas: "",
            groupId: destination === "group" ? "work" : "",
            templateId: "",
            ...(destination === "starred" ? { starred: true } : {}),
          },
        })
        .finally(() => {
          admitted = true;
        });
      // Awaited below; a failed assertion before then must not leave it unhandled.
      creation.catch(() => {});
      await listed.promise;
      const id = created;
      assert.exists(id);
      const placed = owner.session.sidebarPreferences.snapshot();
      expect(admitted).toBe(false);
      expect(placed.status).toBe("ready");
      if (destination === "group")
        expect(placed.data?.assignments[id]).toBe("work");
      else expect(placed.data?.starred).toContain(id);
      listing.release();
      expect(await creation).toBe(id);
      const receipt = `buzz-channel-setup.v2:https://placement.example.test:${viewer.pubkey}:${id}`;
      await vi.waitFor(() => expect(localStorage.getItem(receipt)).toBeNull());
      expect(owner.session.channelCreation.notices()).toEqual([]);
      const saved = owner.session.sidebarPreferences.snapshot().data;
      if (destination === "group") {
        expect(saved?.assignments[id]).toBe("work");
        expect(writeAssignment).toHaveBeenCalledExactlyOnceWith(
          { channelId: id, sectionId: "work" },
          expect.any(AbortSignal),
        );
      } else {
        expect(saved?.starred).toEqual([id]);
        expect(writeAssignment).not.toHaveBeenCalled();
      }
    } finally {
      listing.release();
      reread.release();
      owner.dispose();
    }
  },
);
/** A real relay session with one saved "Work" group whose Creates are readable
 * at once. `state` can fail or hold the new channel's reads or the preference
 * reads. */
function placementSession(published?: () => Promise<void>) {
  const relay = keypair();
  const events: RelayEvent[] = [];
  const sections = [{ id: "work", name: "Work", order: 0 }];
  const state = {
    assignments: {} as Record<string, string>,
    created: undefined as string | undefined,
    failChannel: false,
    failPreferences: false,
    readChannel: undefined as (() => Promise<void>) | undefined,
    readPreferences: undefined as Promise<void> | undefined,
  };
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://placement.example.test",
      media: () => undefined,
      query: async (filters) => {
        const found = events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
        if (
          found.some((event) =>
            event.tags.some(
              ([tag, value]) => tag === "d" && value === state.created,
            ),
          )
        ) {
          if (state.failChannel) throw new Error("Channel read failed");
          await state.readChannel?.();
        }
        return found;
      },
      channelKit: { prepare: async () => "", decode: async () => [] },
      decodeSidebarPreferences: async () => {
        await state.readPreferences;
        if (state.failPreferences) throw new Error("Preferences unavailable");
        return {
          sections,
          assignments: state.assignments,
          starred: [],
          muted: [],
        };
      },
      writeSidebarAssignment: async ({ channelId, sectionId }) => {
        if (channelId && sectionId)
          state.assignments = { ...state.assignments, [channelId]: sectionId };
        return { sections, assignments: state.assignments };
      },
      writeSidebarStar: async () => [],
      writer: {
        kinds: [9007],
        sign: async (template) => signed(viewer, template),
        publish: async (event) => {
          const id = event.tags.find(([tag]) => tag === "h")?.[1];
          assert.exists(id);
          state.created = id;
          events.push(
            event,
            metadata(relay, id, "Placed"),
            roster(relay, id, [viewer.pubkey]),
          );
          await published?.();
        },
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  return { owner, state };
}
const placed: ChannelCreationInput = {
  name: "Placed",
  visibility: "open",
  setup: { agents: [], canvas: "", groupId: "work", templateId: "" },
};
it("re-reads sidebar preferences before placement once the preflight read no longer stands", async () => {
  let stale: string | undefined;
  const { owner, state } = placementSession(async () => {
    // Another reader fails the shared preferences after preflight.
    state.failPreferences = true;
    await owner.session.sidebarPreferences.refresh();
    state.failPreferences = false;
    stale = owner.session.sidebarPreferences.snapshot().status;
  });
  try {
    const id = await owner.session.channelCreation.create(placed);
    const receipt = `buzz-channel-setup.v2:https://placement.example.test:${viewer.pubkey}:${id}`;
    await vi.waitFor(() => expect(localStorage.getItem(receipt)).toBeNull());
    expect(stale).toBe("error");
    expect(owner.session.channelCreation.notices()).toEqual([]);
    expect(state.assignments[id]).toBe("work");
    expect(owner.session.sidebarPreferences.snapshot()).toMatchObject({
      status: "ready",
      data: { assignments: { [id]: "work" } },
    });
  } finally {
    owner.dispose();
  }
});
it("places without waiting on another preference refresh still in flight", async () => {
  // The first read of the new channel's metadata or roster is the re-read.
  const listed = hold();
  const listing = hold();
  const reread = hold();
  let inFlight: unknown;
  const { owner, state } = placementSession(async () => {
    // Another reader refreshes after preflight; its snapshot still stands.
    state.readPreferences = reread.promise;
    void owner.session.sidebarPreferences.refresh();
    inFlight = {
      status: owner.session.sidebarPreferences.snapshot().status,
      writable: owner.session.sidebarPreferences.writable,
    };
  });
  state.readChannel = () => {
    listed.release();
    return listing.promise;
  };
  try {
    let admitted = false;
    const creation = owner.session.channelCreation
      .create(placed)
      .finally(() => {
        admitted = true;
      });
    // Awaited below; a failed assertion before then must not leave it unhandled.
    creation.catch(() => {});
    await listed.promise;
    const id = state.created;
    assert.exists(id);
    expect(inFlight).toEqual({ status: "loading", writable: true });
    await vi.waitFor(() =>
      expect(
        owner.session.sidebarPreferences.snapshot().data?.assignments[id],
      ).toBe("work"),
    );
    expect(admitted).toBe(false);
    reread.release();
    listing.release();
    expect(await creation).toBe(id);
    const receipt = `buzz-channel-setup.v2:https://placement.example.test:${viewer.pubkey}:${id}`;
    await vi.waitFor(() => expect(localStorage.getItem(receipt)).toBeNull());
    expect(owner.session.channelCreation.notices()).toEqual([]);
    expect(state.assignments).toEqual({ [id]: "work" });
    expect(owner.session.sidebarPreferences.snapshot()).toMatchObject({
      status: "ready",
      data: { assignments: { [id]: "work" } },
    });
  } finally {
    reread.release();
    listing.release();
    owner.dispose();
  }
});
it("keeps a delivered Create's placement through failed admission and its identical retry", async () => {
  const { owner, state } = placementSession();
  state.failChannel = true;
  try {
    await expect(owner.session.channelCreation.create(placed)).rejects.toThrow(
      "Channel read failed",
    );
    const id = state.created;
    assert.exists(id);
    expect(
      owner.session.sidebarPreferences.snapshot().data?.assignments[id],
    ).toBe("work");
    state.failChannel = false;
    await expect(owner.session.channelCreation.create(placed)).resolves.toBe(
      id,
    );
    await vi.waitFor(() =>
      expect(owner.session.channelCreation.notices()).toEqual([
        expect.objectContaining({
          id,
          error: expect.stringContaining("Template setup was not continued"),
        }),
      ]),
    );
    expect(owner.session.channels.list().channels.map((c) => c.id)).toContain(
      id,
    );
    expect(state.assignments).toEqual({ [id]: "work" });
    expect(owner.session.sidebarPreferences.snapshot()).toMatchObject({
      status: "ready",
      data: { assignments: { [id]: "work" } },
    });
  } finally {
    owner.dispose();
  }
});
function firstReceipt() {
  const key = receipts()[0];
  assert.exists(key);
  return key;
}
function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([true, false])(
  "confirms a setup seed against the writer without replay (writer visible: %s)",
  async (visible) => {
    const relay = keypair();
    const events: RelayEvent[] = [];
    const published: RelayEvent[] = [];
    const query = vi.fn(async (filters: readonly ReadFilter[]) =>
      events.filter((event) =>
        filters.some(
          (filter) =>
            matchesEvent(event, filter) &&
            (event.kind !== 40100 ||
              (visible && filter.consistency === "strong")),
        ),
      ),
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: "https://setup.example.test",
        media: () => undefined,
        query,
        channelKit: { prepare: async () => "", decode: async () => [] },
        writer: {
          kinds: [9007, 40100],
          sign: async (template) => signed(viewer, template),
          publish: async (event) => {
            published.push(event);
            events.push(event);
            if (event.kind === 9007) {
              const id = event.tags.find(([tag]) => tag === "h")?.[1];
              assert.exists(id);
              events.push(
                metadata(relay, id, "Daily"),
                roster(relay, id, [viewer.pubkey]),
              );
            }
          },
        },
      },
      { outboxStorage: { load: async () => [], save: async () => {} } },
    );
    try {
      const id = await owner.session.channelCreation.create({
        name: "Daily",
        visibility: "open",
        setup: { canvas: "# Plan", agents: [], groupId: "", templateId: "" },
      });
      const receipt = `buzz-channel-setup.v2:https://setup.example.test:${viewer.pubkey}:${id}`;
      if (visible) {
        await vi.waitFor(() =>
          expect(localStorage.getItem(receipt)).toBeNull(),
        );
        expect(owner.session.channelCreation.notices()).toEqual([]);
        expect(owner.session.outbox?.snapshot()).toEqual([]);
      } else {
        await vi.waitFor(() =>
          expect(owner.session.channelCreation.notices()).toEqual([
            expect.objectContaining({
              id,
              error: expect.stringContaining(
                "awaiting exact relay confirmation",
              ),
            }),
          ]),
        );
        expect(
          JSON.parse(localStorage.getItem(receipt) ?? "null"),
        ).toMatchObject({
          canvasDone: false,
        });
      }
      // Receipt retirement / completion failure is the barrier: confirmation
      // must not republish even when the writer cannot prove the accepted seed.
      expect(published.map((event) => event.kind)).toEqual([9007, 40100]);
      const seed = published[1];
      assert.exists(seed);
      const exact = query.mock.calls.flatMap(([filters]) =>
        filters.filter((filter) => filter.ids?.includes(seed.id)),
      );
      // Outbox delivery may also observe by ID; this pins setup's separate,
      // fresh confirmation read rather than incidental background read counts.
      expect(exact).toContainEqual({
        ids: [seed.id],
        limit: 1,
        consistency: "strong",
      });
    } finally {
      owner.dispose();
    }
  },
);

it("opens after confirmed creation, before Canvas completes; places independently and never sends a message", async () => {
  const f = fixture();
  const gate = hold();
  const reached = hold();
  const confirm = f.opts.confirm.getMockImplementation();
  f.opts.confirm.mockImplementation(async (id) => {
    reached.release();
    await gate.promise;
    await confirm?.(id);
  });
  const run = f.setup.run(input, viewer.pubkey);
  const id = await run.admission;
  await reached.promise;
  expect(f.opts.place).toHaveBeenCalledWith(id, "work");
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100]);
  expect(f.events[1]?.event.tags).toEqual([
    ["h", id],
    ["expected-revision", "none"],
  ]);
  expect(receipts()).toHaveLength(1);
  gate.release();
  await run.completion;
  expect(f.opts.confirm).toHaveBeenCalledTimes(2);
  expect(receipts()).toHaveLength(0);
});

it("keeps partial intent without locking a second Create or replaying the first member", async () => {
  const f = fixture();
  f.opts.refresh.mockImplementation(async (_id, member) => {
    if (member === agent) throw new Error("Roster not confirmed");
  });
  const run = f.setup.run(input, viewer.pubkey);
  const failure = expect(run.completion).rejects.toThrow(
    "Roster not confirmed",
  );
  const id = await run.admission;
  await failure;
  const frozen = localStorage.getItem(firstReceipt());
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100, 9000]);
  const next = f.setup.run(
    { name: "Second", visibility: "open" },
    viewer.pubkey,
  );
  expect(await next.admission).not.toBe(id);
  await next.completion;
  expect(localStorage.getItem(firstReceipt())).toBe(frozen);
  expect(f.outbox.retry).not.toHaveBeenCalled();
});

it.each([false, true])(
  "checks an uncertain attempt without replaying Create or setup writes (Starred: %s)",
  async (starred) => {
    const f = fixture();
    assert.exists(input.setup);
    const draft = starred
      ? { ...input, setup: { ...input.setup, groupId: "", starred: true } }
      : input;
    f.opts.delivered.mockRejectedValueOnce(new Error("Unknown delivery"));
    const run = f.setup.run(draft, viewer.pubkey);
    await expect(run.admission).rejects.toThrow("Unknown delivery");
    await expect(run.completion).rejects.toThrow("Unknown delivery");
    const saved = JSON.parse(localStorage.getItem(firstReceipt()) ?? "null");
    const next = f.setup.run(draft, viewer.pubkey);
    await expect(next.admission).resolves.toBe(saved.id);
    await expect(next.completion).rejects.toThrow(
      "Template setup was not continued",
    );
    expect(f.opts.delivered.mock.calls).toEqual([
      [saved.operations.create],
      [saved.operations.create, expect.any(Function)],
    ]);
    expect(f.events.map((e) => e.event.kind)).toEqual([9007]);
    expect(f.outbox.retry).not.toHaveBeenCalled();
    expect(f.opts.star).not.toHaveBeenCalled();
    expect(f.opts.place).not.toHaveBeenCalled();
  },
);

it("abandons an uncertain attempt for a changed request or a closed form", async () => {
  const f = fixture();
  f.opts.delivered.mockRejectedValueOnce(new Error("Unknown delivery"));
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Unknown delivery");
  await expect(run.completion).rejects.toThrow("Unknown delivery");
  const abandoned = f.events[0]?.event.id;
  const changed = f.setup.run({ ...input, name: "Weekly" }, viewer.pubkey);
  await changed.admission;
  await changed.completion;
  expect(f.opts.create).toHaveBeenCalledTimes(2);
  expect(f.outbox.dismiss).toHaveBeenCalledWith(abandoned);

  f.opts.delivered.mockRejectedValueOnce(new Error("Unknown delivery"));
  const closing = f.setup.run(input, viewer.pubkey);
  await expect(closing.admission).rejects.toThrow("Unknown delivery");
  await expect(closing.completion).rejects.toThrow("Unknown delivery");
  expect(receipts()).toHaveLength(1);
  f.setup.forget();
  await vi.waitFor(() => expect(receipts()).toHaveLength(0));
  expect(f.events.some(({ event }) => event.kind === 9007)).toBe(false);
});

it("rechecks the same Create when only the inventory behind a form moved", async () => {
  const f = fixture();
  f.opts.delivered.mockRejectedValueOnce(new Error("Unknown delivery"));
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Unknown delivery");
  await expect(run.completion).rejects.toThrow("Unknown delivery");
  const moved = {
    ...input,
    setup: {
      groupId: "work",
      templateId: "daily",
      agents: [],
      canvas: "# Plan v2",
    },
  };
  const retry = f.setup.run(moved, viewer.pubkey);
  await retry.admission;
  await expect(retry.completion).rejects.toThrow(
    "Template setup was not continued",
  );
  expect(f.opts.create).toHaveBeenCalledTimes(1);
  expect(f.outbox.dismiss).not.toHaveBeenCalled();
});

it.each([
  ["empties", general, { ...input, setup: empty }],
  ["fills", { ...input, setup: empty }, general],
] as const)(
  "rechecks the same Create when the selected template %s before a retry",
  async (_, first, second) => {
    const f = fixture();
    f.opts.delivered.mockRejectedValueOnce(new Error("Unknown delivery"));
    const run = f.setup.run(first, viewer.pubkey);
    await expect(run.admission).rejects.toThrow("Unknown delivery");
    await expect(run.completion).rejects.toThrow("Unknown delivery");
    const retry = f.setup.run(second, viewer.pubkey);
    await retry.admission;
    await retry.completion.catch(() => {});
    expect(f.opts.create).toHaveBeenCalledTimes(1);
  },
);

it("finishes an identical retry quietly when its template adds nothing", async () => {
  const f = fixture();
  const plain = { ...input, setup: empty };
  f.opts.delivered.mockRejectedValueOnce(new Error("Unknown delivery"));
  const run = f.setup.run(plain, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Unknown delivery");
  await expect(run.completion).rejects.toThrow("Unknown delivery");
  const retry = f.setup.run(plain, viewer.pubkey);
  await retry.admission;
  await retry.completion;
  expect(f.opts.create).toHaveBeenCalledTimes(1);
});

it("retires a proven-failed Create so the form can try a new attempt", async () => {
  const f = fixture();
  f.opts.delivered.mockImplementationOnce(async (id) => {
    const index = f.events.findIndex((item) => item.event.id === id);
    assert.exists(f.events[index]);
    f.events[index] = { ...f.events[index], delivery: "failed" };
    throw new Error("Rejected");
  });
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Rejected");
  await expect(run.completion).rejects.toThrow("Rejected");
  expect(receipts()).toHaveLength(0);
  const next = f.setup.run(input, viewer.pubkey);
  await next.admission;
  await next.completion;
  expect(f.opts.create).toHaveBeenCalledTimes(2);
});

it("Canvas failure does not lose group placement or turn admission into failure", async () => {
  const f = fixture();
  f.opts.confirm.mockRejectedValue(new Error("Canvas unconfirmed"));
  const run = f.setup.run(input, viewer.pubkey);
  const failure = expect(run.completion).rejects.toThrow("Canvas unconfirmed");
  const id = await run.admission;
  await failure;
  expect(f.opts.place).toHaveBeenCalledWith(id, "work");
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100]);
  expect(receipts()).toHaveLength(1);
});

it.each(["failed", "unknown"] as const)(
  "keeps seed recovery observe-only and dismisses only a proven conflict (%s)",
  async (delivery) => {
    const f = fixture();
    f.opts.confirm.mockImplementation(async (id) => {
      const index = f.events.findIndex((item) => item.event.id === id);
      assert.exists(f.events[index]);
      f.events[index] = {
        ...f.events[index],
        delivery,
        error: "conflict: the relay state changed",
      };
      f.setCanvas("other-editor");
      throw new Error("conflict: the relay state changed");
    });
    const run = f.setup.run(input, viewer.pubkey);
    const failure = expect(run.completion).rejects.toThrow(
      delivery === "failed"
        ? /Canvas changed.*no agents were added/
        : /conflict:/,
    );
    await run.admission;
    await failure;
    expect(f.opts.canvasHead).toHaveBeenCalledTimes(1);
    expect(await f.opts.canvasHead()).toBe("other-editor");
    expect(f.outbox.retry).not.toHaveBeenCalled();
    expect(
      vi.mocked(f.outbox.send).mock.calls.map(([event]) => event.kind),
    ).toEqual([9007, 40100]);
    expect(f.events.map((item) => item.event.kind)).toEqual(
      delivery === "failed" ? [9007] : [9007, 40100],
    );
    expect(f.outbox.dismiss).toHaveBeenCalledTimes(
      delivery === "failed" ? 1 : 0,
    );
    const saved = JSON.parse(localStorage.getItem(firstReceipt()) ?? "null");
    expect(saved.created).toBe(true);
    expect(saved.canvasDone).toBe(false);
    expect(saved.added).toEqual([]);
  },
);

it.each([false, true])(
  "placement failure does not skip Canvas and members; retains the incomplete destination (Starred: %s)",
  async (starred) => {
    const f = fixture();
    f.opts.place.mockRejectedValue(new Error("Group unavailable"));
    f.opts.star.mockRejectedValue(new Error("Star unavailable"));
    assert.exists(input.setup);
    const draft = starred
      ? { ...input, setup: { ...input.setup, groupId: "", starred: true } }
      : input;
    const run = f.setup.run(draft, viewer.pubkey);
    const failure = expect(run.completion).rejects.toThrow(
      starred ? "Star unavailable" : "Group unavailable",
    );
    await run.admission;
    await failure;
    expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100, 9000]);
    expect(receipts()).toHaveLength(1);
    expect(
      JSON.parse(localStorage.getItem(firstReceipt()) ?? "null").input,
    ).toEqual(draft);
  },
);

it("keeps a placement started before a failed channel-list re-read handled", async () => {
  const f = fixture();
  let placed = 0;
  // A vi.fn would observe its own rejection and hide an unhandled one.
  const setup = createChannelSetup({
    ...f.opts,
    place: () => {
      placed++;
      return Promise.reject(new Error("Group unavailable"));
    },
  });
  f.opts.refresh.mockRejectedValueOnce(new Error("Roster not confirmed"));
  const run = setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Roster not confirmed");
  await expect(run.completion).rejects.toThrow("Roster not confirmed");
  expect(placed).toBe(1);
  expect(f.events.map((e) => e.event.kind)).toEqual([9007]);
  expect(receipts()).toHaveLength(1);
});

it("stars a confirmed channel through the setup owner without assigning a custom group", async () => {
  const f = fixture();
  assert.exists(input.setup);
  const run = f.setup.run(
    { ...input, setup: { ...input.setup, groupId: "", starred: true } },
    viewer.pubkey,
  );
  const id = await run.admission;
  await run.completion;
  expect(f.opts.star).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.opts.place).not.toHaveBeenCalled();
  expect(receipts()).toHaveLength(0);
});

it("leaves historical/corrupt records untouched and never lets them occupy a fresh form", async () => {
  const f = fixture();
  localStorage.setItem("buzz-channel-setup.v1:setup-test", "broken");
  localStorage.setItem(
    "buzz-channel-setup.v1:setup-test:channel:old",
    "frozen old intent",
  );
  const run = f.setup.run({ name: "Fresh", visibility: "open" }, viewer.pubkey);
  await run.admission;
  await run.completion;
  expect(localStorage.getItem("buzz-channel-setup.v1:setup-test")).toBe(
    "broken",
  );
  expect(
    localStorage.getItem("buzz-channel-setup.v1:setup-test:channel:old"),
  ).toBe("frozen old intent");
});

it("bounds record count and UTF-8 bytes before enqueue without evicting unresolved intent", async () => {
  const f = fixture();
  for (let i = 0; i < 256; i++)
    localStorage.setItem(`buzz-channel-setup.v2:setup-test:${i}`, "old");
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Too many unfinished");
  await expect(run.completion).rejects.toThrow("Too many unfinished");
  expect(f.events).toHaveLength(0);
  expect(receipts()).toHaveLength(256);
  localStorage.clear();
  localStorage.setItem(
    "buzz-channel-setup.v2:setup-test:old",
    "é".repeat(1024 * 1024),
  );
  const next = f.setup.run(input, viewer.pubkey);
  await expect(next.admission).rejects.toThrow("Too many unfinished");
  await expect(next.completion).rejects.toThrow("Too many unfinished");
  expect(f.events).toHaveLength(0);
  expect(receipts()).toHaveLength(1);
});

it("checks saved growth and preserves the last receipt when storage fails", async () => {
  const f = fixture();
  const original = Storage.prototype.setItem;
  let saved: string | undefined;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (saved) throw new Error("Storage full");
    saved = value;
    original.call(this, key, value);
  });
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Storage full");
  await expect(run.completion).rejects.toThrow("Storage full");
  expect(localStorage.getItem(firstReceipt())).toBe(saved);
  expect(f.opts.delivered).not.toHaveBeenCalled();
  expect(f.events.map((e) => e.event.kind)).toEqual([9007]);
  expect(f.outbox.dismiss).not.toHaveBeenCalled();
});

it("does not retire intent if Outbox dismissal did not actually remove the operation", async () => {
  const f = fixture();
  vi.mocked(f.outbox.dismiss).mockResolvedValue();
  const run = f.setup.run(input, viewer.pubkey);
  const failure = expect(run.completion).rejects.toThrow(
    "could not be retired",
  );
  await run.admission;
  await failure;
  expect(receipts()).toHaveLength(1);
});

it("shares one admission while preflight is pending, including concurrent submits", async () => {
  const f = fixture();
  const gate = hold();
  f.opts.preflight.mockImplementationOnce(() => gate.promise);
  const run = f.setup.run(input, viewer.pubkey);
  const concurrent = f.setup.run(input, viewer.pubkey);
  expect(concurrent).toBe(run);
  gate.release();
  expect(await concurrent.admission).toBe(await run.admission);
  await run.completion;
  expect(f.opts.create).toHaveBeenCalledOnce();
});

it("queues a different request behind a pending admission instead of sharing it", async () => {
  const f = fixture();
  const gate = hold();
  f.opts.preflight.mockImplementationOnce(() => gate.promise);
  const first = f.setup.run(input, viewer.pubkey);
  const other = f.setup.run(
    { name: "Config", visibility: "private", system: true },
    viewer.pubkey,
  );
  expect(other).not.toBe(first);
  expect(f.opts.create).not.toHaveBeenCalled();
  gate.release();
  const [a, b] = await Promise.all([first.admission, other.admission]);
  await Promise.all([first.completion, other.completion]);
  expect(b).not.toBe(a);
  expect(f.opts.create).toHaveBeenCalledTimes(2);
  expect(f.opts.create.mock.calls.map(([id]) => id)).toEqual([a, b]);
});

it("keeps an uncertain Create recheckable when a queued different request follows it", async () => {
  const f = fixture();
  const plain: ChannelCreationInput = { name: "Daily", visibility: "private" };
  const gate = hold();
  f.opts.delivered.mockImplementationOnce(async () => {
    await gate.promise;
    throw new Error("Timed out");
  });
  const first = f.setup.run(plain, viewer.pubkey);
  await vi.waitFor(() => expect(f.opts.delivered).toHaveBeenCalledOnce());
  const other = f.setup.run(
    { name: "Config", visibility: "private", system: true },
    viewer.pubkey,
  );
  gate.release();
  await expect(first.admission).rejects.toThrow("Timed out");
  await expect(other.admission).rejects.toThrow("unconfirmed");
  await expect(other.completion).rejects.toThrow("unconfirmed");
  expect(receipts()).toHaveLength(1);
  const retry = f.setup.run(plain, viewer.pubkey);
  await retry.admission;
  await retry.completion;
  expect(f.opts.create).toHaveBeenCalledOnce();
});

it("releases a pending attempt when read-only confirmation proves it failed", async () => {
  const f = fixture();
  f.opts.delivered.mockRejectedValueOnce(new Error("Timed out"));
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Timed out");
  await expect(run.completion).rejects.toThrow("Timed out");
  f.opts.delivered.mockImplementationOnce(async (id) => {
    const index = f.events.findIndex((item) => item.event.id === id);
    assert.exists(f.events[index]);
    f.events[index] = { ...f.events[index], delivery: "failed" };
    throw new Error("Rejected");
  });
  const check = f.setup.run(input, viewer.pubkey);
  await expect(check.admission).rejects.toThrow("Rejected");
  await expect(check.completion).rejects.toThrow("Rejected");
  expect(receipts()).toHaveLength(0);
  expect(f.opts.create).toHaveBeenCalledOnce();
});
