import { expect, it } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import {
  eligibleSolo,
  ownSolo,
  SOLO_NAMED_LABEL,
  SOLO_LABEL,
  soloChatLinkName,
  soloLabels,
} from "./labels";

const id = "22222222-2222-4222-8222-222222222222";
const owner = "a".repeat(64);
const guest = "b".repeat(64);

it.each([
  { name: "joined viewer", changes: {}, expected: true },
  { name: "departed viewer", changes: { members: [owner] }, expected: false },
  { name: "empty roster", changes: { members: [] }, expected: false },
  {
    name: "unjoined reader",
    changes: { viewerRole: undefined, members: [owner] },
    expected: false,
  },
  { name: "archived membership", changes: { archived: true }, expected: false },
  {
    name: "ordinary channel",
    changes: { channelType: "stream" },
    expected: false,
  },
] satisfies {
  name: string;
  changes: Partial<ChannelSummary>;
  expected: boolean;
}[])(
  "lists a $name in Solo only with current membership",
  ({ changes, expected }) => {
    const channel: ChannelSummary = {
      id,
      name: "Shared chat",
      channelType: "solo",
      creator: owner,
      readOnly: true,
      viewerRole: "guest",
      members: [owner, guest],
      ...changes,
    };
    expect(eligibleSolo(channel, guest)).toBe(expected);
    expect(eligibleSolo(channel, undefined)).toBe(false);
  },
);

it("names shared chats by their current name, falling back to the short ID", () => {
  expect(soloChatLinkName({ id, name: "Investigate the flaky test" })).toBe(
    "Investigate the flaky test",
  );
  expect(soloChatLinkName({ id, name: "PR 45 fixes" })).toBe("PR 45 fixes");
  expect(soloChatLinkName({ id, name: "  " })).toBe("22222222");
});

it("marks Solo only with its channel label", () => {
  expect(soloLabels([SOLO_LABEL])).toBe(true);
  expect(soloLabels([SOLO_NAMED_LABEL, SOLO_LABEL])).toBe(true);
  expect(soloLabels([SOLO_NAMED_LABEL])).toBe(false);
  expect(soloLabels([])).toBe(false);
  expect(soloLabels(undefined)).toBe(false);
});

it("files a Solo chat as the viewer's own only when they created it", () => {
  const solo = { channelType: "solo", creator: owner };
  expect(ownSolo(solo, owner)).toBe(true);
  expect(ownSolo(solo, guest)).toBe(false);
  expect(ownSolo(solo, undefined)).toBe(false);
  expect(ownSolo({ channelType: "solo" }, owner)).toBe(false);
  expect(ownSolo({ channelType: "stream", creator: owner }, owner)).toBe(false);
  expect(ownSolo(undefined, owner)).toBe(false);
});
