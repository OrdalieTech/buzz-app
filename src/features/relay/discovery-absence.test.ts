import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import type { RelayEvent } from "./events";
import { keypair, signed } from "./testing";

const dm = (
  relay: ReturnType<typeof keypair>,
  members: string[],
): [RelayEvent, RelayEvent] => [
  signed(relay, {
    kind: 39000,
    content: "",
    tags: [["d", "dm"], ["t", "dm"], ["private"], ["hidden"]],
  }),
  signed(relay, {
    kind: 39002,
    content: "",
    tags: [["d", "dm"], ...members.map((member) => ["p", member])],
  }),
];

it("restores a roster a complete read omitted once a later complete read lists it", () => {
  const viewer = keypair(),
    relay = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  const [metadata, roster] = dm(relay, [viewer.pubkey, keypair().pubkey]);
  state.accept(metadata);
  state.accept(roster);
  // A lagging read replica omits the just-created DM.
  state.retain(new Set(), state.rosterVersions());
  expect(state.canAccess("dm")).toBe(false);
  // An omission is not the relay's answer for the channel.
  expect(state.revoked("dm")).toBe(false);

  const started = state.rosterVersions();
  state.accept(roster);
  state.retain(new Set(["dm"]), started);
  expect(state.canAccess("dm")).toBe(true);
  expect(state.channels().map((channel) => channel.id)).toEqual(["dm"]);
});

it("keeps a relay denial when a later complete read lists the same roster", () => {
  const viewer = keypair(),
    relay = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  const [metadata, roster] = dm(relay, [viewer.pubkey]);
  state.accept(metadata);
  state.accept(roster);
  state.retain(new Set(), state.rosterVersions());
  state.revoke("dm");

  state.accept(roster);
  state.retain(new Set(["dm"]), state.rosterVersions());
  expect(state.canAccess("dm")).toBe(false);
  expect(state.revoked("dm")).toBe(true);
});
