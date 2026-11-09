import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, roster, signed } from "./testing";
import { SOLO_LABEL } from "../solo/labels";
it("recognizes relay-authorized streams with the Solo label independently of visibility", () => {
  const viewer = keypair(),
    relay = keypair();
  const discovery = new DiscoveryState(viewer.pubkey, relay.pubkey);
  discovery.accept(roster(relay, "work", [viewer.pubkey]));
  const metadata = (
    author: typeof relay,
    privateChannel: boolean,
    time: number,
  ) =>
    signed(author, {
      kind: 39000,
      created_at: time,
      content: "",
      tags: [
        ["d", "work"],
        ["name", "Work"],
        ["t", "stream"],
        ["t", SOLO_LABEL],
        ["about", "Plain text"],
        ...(privateChannel ? [["private"]] : []),
      ],
    });
  discovery.accept(metadata(viewer, true, 1));
  expect(discovery.isSolo("work")).toBe(false);
  discovery.accept(metadata(relay, false, 1));
  expect(discovery.isSolo("work")).toBe(true);
  discovery.accept(metadata(relay, true, 2));
  expect(discovery.channels()[0]).toMatchObject({
    channelType: "solo",
    description: "Plain text",
    labels: [SOLO_LABEL],
    private: true,
  });
  discovery.accept(
    signed(relay, {
      kind: 39000,
      created_at: 3,
      content: "",
      tags: [
        ["d", "work"],
        ["t", "session"],
      ],
    }),
  );
  expect(discovery.isSolo("work")).toBe(false);
});
