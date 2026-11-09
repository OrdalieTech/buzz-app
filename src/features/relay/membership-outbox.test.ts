import { afterEach, assert, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { ReadError } from "./errors";
import type { RelayEvent } from "./events";
import { PublishRejected, type OutgoingEvent } from "./outbox";
import { matchesEvent } from "./projection";
import { createRelaySession } from "./session";
import { keypair, message, signed } from "./testing";

const gone = "11111111-1111-4111-8111-111111111111";
const kept = "22222222-2222-4222-8222-222222222222";
/** A channel the viewer is not on, and one that does not exist yet. */
const left = "33333333-3333-4333-8333-333333333333";
const unborn = "44444444-4444-4444-8444-444444444444";
const viewer = keypair(),
  relay = keypair(),
  peer = keypair(),
  agent = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
/** A relay holding two private channels the viewer belongs to, with `saved`
 * as the outbox a previous launch left behind, loaded once `loaded` settles.
 * Strong reads answer from the writer; others from a replica that serves
 * `lagging` channels as they were before the viewer joined. */
async function setup(
  saved: readonly OutgoingEvent[] = [],
  loaded?: Promise<void>,
) {
  let archived = false,
    records = saved,
    gate: Promise<void> | undefined,
    receive!: (events: readonly RelayEvent[]) => void,
    deny!: (channelId: string, reason: string) => void;
  /** The channels of each writer read of exact viewer rosters. */
  const confirmations: string[][] = [];
  const members = new Set([gone, kept]);
  /** Each channel's signed version; a change re-signs only that channel. */
  const versions = new Map([
    [gone, 1_700_000_000],
    [kept, 1_700_000_000],
  ]);
  const at = (id: string) => versions.get(id) ?? 0;
  const bump = (id: string) => versions.set(id, at(id) + 1);
  const lagging = new Set<string>();
  /** Channels whose history reads are refused, with the HTTP status. */
  const refusals = new Map<string, number>();
  const channel = (id: string, replica: boolean) => [
    signed(relay, {
      kind: 39000,
      created_at: at(id),
      content: "",
      tags: [
        ["d", id],
        ["name", id === gone ? "Gone" : "Kept"],
        ["t", "stream"],
        ...(archived && id === gone ? [["archived", "true"]] : []),
      ],
    }),
    signed(relay, {
      kind: 39001,
      created_at: at(id),
      content: "",
      tags: [
        ["d", id],
        ["p", peer.pubkey, "owner"],
        ["p", viewer.pubkey, "admin"],
      ],
    }),
    roster(id, replica),
  ];
  const roster = (id: string, replica = false) =>
    signed(relay, {
      kind: 39002,
      created_at: at(id),
      content: "",
      tags: [
        ["d", id],
        ["p", peer.pubkey, "", "owner"],
        ...(members.has(id) && !(replica && lagging.has(id))
          ? [["p", viewer.pubkey, "", "admin"]]
          : []),
      ],
    });
  /** The relay's member-removed hint for `id`. */
  const removal = (id: string) =>
    signed(relay, {
      kind: 44101,
      content: "",
      tags: [
        ["p", viewer.pubkey],
        ["h", id],
      ],
    });
  const sign = vi.fn(async (event: EventTemplate) => signed(viewer, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
    if (event.kind === 9022) end(id);
    if (event.kind === 9002) {
      archived = true;
      bump(id);
    }
  });
  function end(id: string) {
    members.delete(id);
    bump(id);
  }
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      writer: { sign, publish },
      channelLifecycle: { sign, publish },
      query: async (filters) => {
        for (const id of filters.flatMap((filter) => filter["#h"] ?? [])) {
          const status = refusals.get(id);
          if (status) throw new ReadError("denied", "Denied", status);
        }
        const strong = filters.some(
          (filter) => filter.consistency === "strong",
        );
        const events = [
          ...channel(gone, !strong),
          ...channel(kept, !strong),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
        const exact = filters.find((filter) => filter["#d"] && filter["#p"]);
        if (strong && exact?.["#d"]) {
          confirmations.push([...exact["#d"]]);
          const held = gate;
          gate = undefined;
          await held;
        }
        return events;
      },
      subscribe(callbacks) {
        receive = callbacks.receive;
        deny = callbacks.denied;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      outboxStorage: {
        load: () => (loaded ? loaded.then(() => records) : records),
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  owners.push(owner);
  owner.session.channels.refreshList?.();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().channels).toHaveLength(2),
  );
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  if (!loaded) await outbox.ready();
  return {
    ...owner,
    outbox,
    publish,
    lag: (id: string) => lagging.add(id),
    refuse: (id: string, status: number) => refusals.set(id, status),
    /** The relay closes the viewer's live subscription to `id`. */
    deny: (id: string) => deny(id, "restricted: not a channel member"),
    confirmations,
    /** Holds the next writer confirmation's reply until released. */
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    /** The ids pending in the outbox and in its storage, which must agree. */
    pending: () => [
      outbox.snapshot().map((item) => item.event.id),
      records.map((item) => item.event.id),
    ],
    /** Someone else removes the viewer; `seen` is how this device learns. A
     * live removal is the relay's 44101 hint, which starts a writer-backed
     * roster refresh. */
    async remove(
      id: string,
      seen: "live removal" | "roster refresh" | "strong roster refresh",
    ) {
      end(id);
      if (seen === "live removal") receive([removal(id)]);
      else
        owner.session.channels.refreshList?.(
          seen === "strong roster refresh" ? { consistency: "strong" } : {},
        );
      await vi.waitFor(() =>
        expect(
          owner.session.channels.list().channels.map((item) => item.id),
        ).not.toContain(id),
      );
    },
    /** The relay tells this device live that the viewer is no longer on `id`:
     * its roster push, its removal hint, or closing the subscription. */
    announce(id: string, how: "roster" | "hint" | "closed") {
      if (how === "closed") deny(id, "restricted: not a channel member");
      else receive([how === "roster" ? roster(id) : removal(id)]);
    },
    /** A roster read that changes nothing, through to its verified end. */
    async refresh() {
      owner.session.channels.refreshList?.();
      expect(owner.session.live.snapshot().roster.state).toBe("pending");
      await vi.waitFor(() =>
        expect(owner.session.live.snapshot().roster.state).toBe("verified"),
      );
    },
    /** Someone adds the viewer back, seen through the live roster unless
     * the relay's roster push has not reached this device yet. */
    async rejoin(id: string, seen: "live roster" | "unseen" = "live roster") {
      members.add(id);
      bump(id);
      if (seen === "unseen") return;
      receive([roster(id)]);
      await vi.waitFor(() =>
        expect(
          owner.session.channels.list().channels.map((item) => item.id),
        ).toContain(id),
      );
    },
  };
}

const failed = (channelId: string, content: string): OutgoingEvent => ({
  event: message(viewer, channelId, content, 1_700_000_000),
  delivery: "failed",
  error: "restricted: slow down",
});

it.each(["leave", "live removal", "roster refresh"] as const)(
  "ending membership by %s discards that channel's failed sends only",
  async (how) => {
    const stranded = failed(gone, "Never sent");
    const unconfirmed: OutgoingEvent = {
      event: message(viewer, gone, "Maybe sent", 1_700_000_000),
      delivery: "unknown",
    };
    const elsewhere = failed(kept, "Still retryable");
    const h = await setup([stranded, unconfirmed, elsewhere]);
    if (how === "leave") await h.session.channelLifecycle.run("leave", gone);
    else await h.remove(gone, how);
    const remaining = [unconfirmed.event.id, elsewhere.event.id];
    await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
  },
);

it.each(["roster", "hint", "closed"] as const)(
  "a leave the relay announces live by %s before acknowledging completes",
  async (how) => {
    const h = await setup();
    const apply = h.publish.getMockImplementation();
    assert.exists(apply);
    // The relay runs a leave's side effects, live announcements included,
    // before it acknowledges the publication.
    h.publish.mockImplementationOnce(async (event) => {
      await apply(event);
      h.announce(gone, how);
    });
    // A hint's roster refresh revokes access once the leave's own
    // confirmation read is running; hold that read so the refresh retires it.
    const release = how === "hint" ? h.hold() : undefined;
    const leaving = expect(
      h.session.channelLifecycle.run("leave", gone),
    ).resolves.toBeUndefined();
    try {
      await vi.waitFor(() =>
        expect(
          h.session.channels.list().channels.map((item) => item.id),
        ).toEqual([kept]),
      );
    } finally {
      release?.();
    }
    await leaving;
    expect(h.publish).toHaveBeenCalledOnce();
    // The hint's refresh retired the held confirmation; the leave read again.
    expect(h.confirmations).toEqual(
      how === "hint" ? [[gone], [gone]] : [[gone]],
    );
  },
);

/** Sends to `gone` and holds the attempt until `end` rejects it. */
async function inFlight(h: Awaited<ReturnType<typeof setup>>) {
  let end!: (error: Error) => void;
  h.publish.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        end = reject;
      }),
  );
  const id = h.session.messages.send(gone, "In flight");
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  return { id, end: (error: Error) => end(error) };
}

it("discards a send the relay refuses after removal ends membership", async () => {
  const stranded = failed(gone, "Never sent");
  const h = await setup([stranded]);
  const send = await inFlight(h);
  try {
    await h.remove(gone, "live removal");
    // The sweep that discards `stranded` has seen the running send.
    await vi.waitFor(() => expect(h.pending()).toEqual([[send.id], [send.id]]));
  } finally {
    send.end(new PublishRejected("restricted: not a member"));
  }
  await vi.waitFor(() => expect(h.pending()).toEqual([[], []]));
});

it.each([
  ["the viewer is back before it is refused", "failed", undefined],
  [
    "the viewer is back before a 401 history read and the refusal",
    "failed",
    401,
  ],
  ["it may have reached the relay", "unknown", undefined],
] as const)("keeps an in-flight send when %s", async (_, delivery, status) => {
  const stranded = failed(gone, "Never sent");
  const elsewhere = failed(kept, "Removed later");
  const h = await setup([stranded, elsewhere]);
  const send = await inFlight(h);
  const running = [elsewhere.event.id, send.id];
  try {
    await h.remove(gone, "live removal");
    // The sweep that discards `stranded` has seen the running send.
    await vi.waitFor(() => expect(h.pending()).toEqual([running, running]));
    if (delivery === "failed") await h.rejoin(gone);
    if (status) {
      // A local denial after the rejoin is not removal: the writer decides.
      h.refuse(gone, status);
      h.session.channels.ensure(gone);
      await vi.waitFor(() =>
        expect(
          h.session.channels.list().channels.map((item) => item.id),
        ).not.toContain(gone),
      );
    }
  } finally {
    send.end(
      delivery === "failed"
        ? new PublishRejected("restricted: not a member")
        : new Error("Connection lost"),
    );
  }
  await vi.waitFor(() =>
    expect(
      h.outbox.snapshot().find((item) => item.event.id === send.id)?.delivery,
    ).toBe(delivery),
  );
  // A later removal's discard is the barrier: outbox writes run in order.
  await h.remove(kept, "live removal");
  await vi.waitFor(() => expect(h.pending()).toEqual([[send.id], [send.id]]));
});

it("discards a removed channel's failed contributions once restored sends load", async () => {
  let load!: () => void;
  const loaded = new Promise<void>((resolve) => {
    load = resolve;
  });
  const target = message(viewer, gone, "Reacted to", 1_700_000_000).id;
  const contribution = (kind: number, tags: string[][]): OutgoingEvent => ({
    event: signed(viewer, { kind, content: "", tags: [["h", gone], ...tags] }),
    delivery: "failed",
  });
  const stranded = [
    failed(gone, "Restored late"),
    contribution(7, [["e", target]]),
    contribution(40003, [["e", target]]),
    contribution(5, [["e", target]]),
  ];
  // Workflow deletions are kind 5 too, but the workflow capability owns them.
  const workflowDelete = contribution(5, [
    ["a", `30620:${viewer.pubkey}:${unborn}`],
  ]);
  const elsewhere = failed(kept, "Still retryable");
  const h = await setup([...stranded, workflowDelete, elsewhere], loaded);
  try {
    await h.remove(gone, "roster refresh");
    expect(h.outbox.snapshot()).toEqual([]);
  } finally {
    load();
  }
  const remaining = [workflowDelete.event.id, elsewhere.event.id];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
});

it("keeps failed sends in a channel only a lagging replica leaves out", async () => {
  const unsent = failed(gone, "Never sent");
  const lagged = failed(kept, "Writer still lists the viewer");
  const h = await setup([unsent, lagged]);
  h.lag(kept);
  await h.remove(gone, "roster refresh");
  // One writer read confirms both omissions, so gone's discard decides kept's.
  const remaining = [lagged.event.id];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
});

it.each([
  ["a 401 history read", 401],
  ["a relay-wide 403, such as a ban,", 403],
] as const)(
  "%s keeps failed sends while the writer lists the viewer",
  async (_, status) => {
    const unsent = failed(gone, "Never sent");
    const elsewhere = failed(kept, "Removed later");
    const h = await setup([unsent, elsewhere]);
    h.refuse(gone, status);
    h.session.channels.ensure(gone);
    await vi.waitFor(() =>
      expect(
        h.session.channels.list().channels.map((item) => item.id),
      ).not.toContain(gone),
    );
    // Discovery keeps the denial, so the next sweep asks the writer about
    // gone too. One writer read decides both channels, so kept's discard is
    // the barrier for gone's.
    await h.remove(kept, "strong roster refresh");
    const remaining = [unsent.event.id];
    await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
  },
);

it("runs one writer confirmation at a time and sweeps again after it", async () => {
  const unsent = failed(gone, "Never sent");
  const h = await setup([unsent]);
  // A 401 denies gone locally while the writer still lists the viewer, so
  // every sweep asks about it and none discards.
  h.refuse(gone, 401);
  h.session.channels.ensure(gone);
  await vi.waitFor(() =>
    expect(
      h.session.channels.list().channels.map((item) => item.id),
    ).not.toContain(gone),
  );
  const release = h.hold();
  try {
    await h.refresh();
    await vi.waitFor(() => expect(h.confirmations).toEqual([[gone]]));
    // A sweep this pass started would have asked the writer before the pass
    // verified. A pass that changes no access leaves the held read running.
    await h.refresh();
    expect(h.confirmations).toEqual([[gone]]);
  } finally {
    release();
  }
  await vi.waitFor(() => expect(h.confirmations).toEqual([[gone], [gone]]));
  expect(h.pending()).toEqual([[unsent.event.id], [unsent.event.id]]);
});

it("sweeps again when an access change cancels its writer read", async () => {
  const unsent = failed(gone, "Never sent");
  const h = await setup([unsent]);
  const release = h.hold();
  try {
    await h.remove(gone, "roster refresh");
    await vi.waitFor(() => expect(h.confirmations).toEqual([[gone]]));
    // A live refusal elsewhere starts no roster read, but retires the held one.
    h.deny(kept);
    await vi.waitFor(() => expect(h.pending()).toEqual([[], []]));
    expect(h.confirmations).toEqual([[gone], [gone]]);
  } finally {
    release();
  }
});

it("keeps a removed channel's failed sends when the viewer rejoins before the writer answers", async () => {
  const unsent = failed(gone, "Never sent");
  const elsewhere = failed(kept, "Removed later");
  const h = await setup([unsent, elsewhere]);
  const release = h.hold();
  try {
    await h.remove(gone, "roster refresh");
    await vi.waitFor(() => expect(h.confirmations).toEqual([[gone]]));
    // The held answer was sampled before the rejoin and still omits the viewer.
    await h.rejoin(gone);
  } finally {
    release();
  }
  // A later removal's discard is the barrier: outbox writes run in order.
  await h.remove(kept, "live removal");
  await vi.waitFor(() =>
    expect(h.pending()).toEqual([[unsent.event.id], [unsent.event.id]]),
  );
});

it("asks the writer again for a send refused while it was answering", async () => {
  const elsewhere = failed(kept, "Removed later");
  const h = await setup([elsewhere]);
  const send = await inFlight(h);
  const release = h.hold();
  try {
    await h.remove(gone, "roster refresh");
    // The sweep saw the running send; the writer sampled the viewer's absence.
    await vi.waitFor(() => expect(h.confirmations).toEqual([[gone]]));
    // The viewer is added back, but no roster push has reached this device.
    await h.rejoin(gone, "unseen");
    send.end(new PublishRejected("restricted: not a member"));
    await vi.waitFor(() =>
      expect(
        h.outbox.snapshot().find((item) => item.event.id === send.id)?.delivery,
      ).toBe("failed"),
    );
  } finally {
    release();
  }
  // The stale answer decides nothing for the send; a fresh read lists the viewer.
  await vi.waitFor(() => expect(h.confirmations).toEqual([[gone], [gone]]));
  // A later removal's discard is the barrier: outbox writes run in order.
  await h.remove(kept, "live removal");
  await vi.waitFor(() => expect(h.pending()).toEqual([[send.id], [send.id]]));
});

it("asks the writer again for a failed send retried while it was answering", async () => {
  const unsent = failed(gone, "Never sent");
  const elsewhere = failed(kept, "Removed later");
  const h = await setup([unsent, elsewhere]);
  const { id } = unsent.event;
  const release = h.hold();
  try {
    await h.remove(gone, "roster refresh");
    // The sweep saw the failed send; the writer sampled the viewer's absence.
    await vi.waitFor(() => expect(h.confirmations).toEqual([[gone]]));
    // The viewer is added back, but no roster push has reached this device.
    await h.rejoin(gone, "unseen");
    // Retrying keeps the send's ID; the relay refuses it again.
    h.publish.mockRejectedValueOnce(
      new PublishRejected("restricted: not a member"),
    );
    h.outbox.retry(id);
    expect(
      h.outbox.snapshot().find((item) => item.event.id === id)?.delivery,
    ).toBe("sending");
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        h.outbox.snapshot().find((item) => item.event.id === id)?.delivery,
      ).toBe("failed"),
    );
  } finally {
    release();
  }
  // The stale answer predates the retry; a fresh read lists the viewer.
  await vi.waitFor(() => expect(h.confirmations).toEqual([[gone], [gone]]));
  // A later removal's discard is the barrier: outbox writes run in order.
  await h.remove(kept, "live removal");
  await vi.waitFor(() => expect(h.pending()).toEqual([[id], [id]]));
});

it("discards failed sends an earlier session left in a channel the viewer is not on", async () => {
  const stray = failed(left, "Sent before leaving");
  // Sent to channels the viewer is not on: a create, and removing its agent.
  const create: OutgoingEvent = {
    event: signed(viewer, {
      kind: 9007,
      content: "",
      tags: [
        ["h", unborn],
        ["name", "New"],
      ],
    }),
    delivery: "failed",
  };
  const removal: OutgoingEvent = {
    event: signed(viewer, {
      kind: 9001,
      content: "",
      tags: [
        ["h", left],
        ["p", agent.pubkey],
      ],
    }),
    delivery: "failed",
  };
  const h = await setup([stray, create, removal]);
  const remaining = [create.event.id, removal.event.id];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
});

it("keeps failed sends in a channel the viewer archives", async () => {
  const archived = failed(gone, "Still viewable");
  const h = await setup([archived, failed(kept, "Removed later")]);
  await h.session.channelLifecycle.run("archive", gone);
  expect(h.publish.mock.calls.map(([event]) => event.kind)).toEqual([9002]);
  // A later removal's discard is the barrier: outbox writes run in order.
  await h.remove(kept, "live removal");
  const remaining = [archived.event.id];
  await vi.waitFor(() => expect(h.pending()).toEqual([remaining, remaining]));
});
