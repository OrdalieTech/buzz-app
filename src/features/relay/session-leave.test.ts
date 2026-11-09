import { afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import { matchesEvent } from "./projection";
import { createRelaySession } from "./session";
import { keypair, message, signed } from "./testing";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const cases = ["public", "private"].flatMap((visibility) =>
  ["before ACK", "during readback"].map((ordering) => ({
    visibility,
    ordering,
  })),
);
it.each(cases)(
  "confirms a Guest leaving a $visibility channel when its signed roster arrives $ordering",
  async ({ visibility, ordering }) => {
    const viewer = keypair(),
      relay = keypair(),
      peer = keypair();
    const id = "11111111-1111-4111-8111-111111111111";
    let member = true,
      published = false,
      time = 1700000000;
    let receive!: (events: readonly RelayEvent[]) => void;
    const record = (kind: number, tags: string[][]) =>
      signed(relay, { kind, tags, content: "", created_at: time });
    const roster = () =>
      record(39002, [
        ["d", id],
        ["p", peer.pubkey, "", "owner"],
        ...(member ? [["p", viewer.pubkey, "", "guest"]] : []),
      ]);
    const events = () => [
      record(39000, [
        ["d", id],
        ["name", "Leave race"],
        ["t", "stream"],
        [visibility],
        ["join_role", "guest"],
      ]),
      record(39001, [
        ["d", id],
        ["p", peer.pubkey, "owner"],
      ]),
      roster(),
    ];
    const sign = vi.fn(async (template: EventTemplate) =>
      signed(viewer, template),
    );
    const publish = vi.fn(async (event: RelayEvent) => {
      expect(event.kind).toBe(9022);
      published = true;
      if (ordering === "before ACK") depart();
    });
    function depart() {
      member = false;
      time++;
      receive([roster()]);
    }
    const query = vi.fn(
      async (filters: Parameters<typeof matchesEvent>[1][]) => {
        const result = events().filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
        if (
          published &&
          member &&
          filters.some((filter) => filter.consistency === "strong")
        ) {
          // Retire the shared job while it still holds the pre-Leave response.
          // The lifecycle must discard it and issue a new strong roster read.
          depart();
        }
        return result;
      },
    );
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      channelLifecycle: { sign, publish },
      query,
      subscribe(callbacks) {
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    owners.push(owner);
    owner.session.channels.refreshList?.();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    expect(owner.session.channels.list().channels).toHaveLength(1);
    const content = owner.session.observe([
      { kinds: [9], "#h": [id], limit: 10 },
    ]);
    receive([message(peer, id, "Prior channel content", time)]);
    expect(content.snapshot().events).toHaveLength(1);
    const outcome = await owner.session.channelLifecycle.run("leave", id).then(
      () => "confirmed",
      (error: unknown) =>
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    );
    expect(member).toBe(false);
    expect(publish).toHaveBeenCalledOnce();
    expect(owner.session.channels.list().channels).toHaveLength(0);
    expect(outcome).toBe("confirmed");
    if (visibility === "private") expect(content.snapshot().events).toEqual([]);
    const confirmations = query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.consistency === "strong");
    expect(confirmations).toHaveLength(ordering === "before ACK" ? 1 : 2);
    for (const filter of confirmations)
      expect(filter).toEqual({
        kinds: [39002],
        consistency: "strong",
        authors: [relay.pubkey],
        "#d": [id],
        "#p": [viewer.pubkey],
        limit: 1,
      });
  },
);
