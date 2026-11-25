import { expect, it } from "vitest";
import { soloAudience, soloRecipients } from "./recipients";
import type { ChannelSummary, Profile } from "../relay/contracts";
const viewer = "a".repeat(64),
  agent = "b".repeat(64),
  other = "c".repeat(64);
const library = {
  status: "ready" as const,
  definitions: [],
  identities: [{ pubkey: agent, name: "Agent" }],
};
const channel: ChannelSummary = {
  id: "chat",
  name: "Work",
  channelType: "solo",
  members: [viewer, agent],
};
const profiles = new Map<string, Profile>();
it("uses only roster members and deduplicates a known sole agent", () => {
  expect(
    soloRecipients(
      { ...channel, members: [viewer, agent, agent] },
      profiles,
      library,
      viewer,
      [],
    ),
  ).toEqual([agent]);
  expect(
    soloRecipients(
      { ...channel, members: [viewer] },
      profiles,
      library,
      viewer,
      [],
    ),
  ).toEqual([]);
});
it("does not confuse a missing profile with a human or guess from display names", () => {
  const multiple = { ...channel, members: [viewer, agent, other] };
  expect(() => soloRecipients(multiple, profiles, library, viewer, [])).toThrow(
    /loading/,
  );
  expect(
    soloRecipients(
      multiple,
      new Map([[other, { name: "Agent" }]]),
      library,
      viewer,
      [],
    ),
  ).toEqual([agent]);
  expect(() =>
    soloRecipients(
      multiple,
      new Map([[other, { name: "Agent", isAgent: true }]]),
      library,
      viewer,
      [],
    ),
  ).toThrow(/multiple/);
});
it("preserves explicit recipients and leaves ordinary channels unchanged", () => {
  expect(soloRecipients(channel, profiles, library, viewer, [other])).toEqual([
    other,
  ]);
  expect(
    soloRecipients(
      { ...channel, channelType: "stream" },
      profiles,
      library,
      viewer,
      [],
    ),
  ).toEqual([]);
});

it("does not mistake an agent-library refresh for evidence of a sole agent", () => {
  const multiple = { ...channel, members: [viewer, agent, other] };
  const knownProfiles = new Map<string, Profile>([
    [agent, { name: "Local agent" }],
    [other, { name: "Shared agent", isAgent: true }],
  ]);
  expect(() =>
    soloRecipients(
      multiple,
      knownProfiles,
      { ...library, status: "loading", identities: [] },
      viewer,
      [],
    ),
  ).toThrow(/loading/);
  expect(() =>
    soloRecipients(
      multiple,
      knownProfiles,
      { ...library, status: "loading" },
      viewer,
      [],
    ),
  ).toThrow(/multiple/);
});

it("a draft that opens with a tag is for its tags; a later tag joins the toolbar", () => {
  const ada = { pubkey: agent, name: "Ada" };
  const bea = { pubkey: other, name: "Bea" };
  const named = (key: string) => key !== viewer;
  const tag = (who: typeof ada, start: number) => ({
    ...who,
    start,
    end: start + who.name.length + 1,
  });
  // Opening tags, after any whitespace, address only themselves.
  expect(
    soloAudience("@Bea hi", [tag(bea, 0)], [ada], named).recipients,
  ).toEqual([tag(bea, 0)]);
  expect(
    soloAudience("\n  @Bea hi", [tag(bea, 3)], [ada], named).opensWithTag,
  ).toBe(true);
  // Draft order need not be text order.
  expect(
    soloAudience("@Bea @Ada hi", [tag(ada, 5), tag(bea, 0)], [ada], named)
      .opensWithTag,
  ).toBe(true);
  // A later tag, even after a greeting, joins the toolbar's agents once.
  expect(
    soloAudience("hey @Bea", [tag(bea, 4)], [ada], named).recipients,
  ).toEqual([ada, tag(bea, 4)]);
  expect(
    soloAudience("hey @Ada", [tag(ada, 4)], [ada], named).recipients,
  ).toHaveLength(1);
  // A reference never opens the draft; it goes along with the toolbar.
  const reference = { pubkey: viewer, name: "Pat", start: 0, end: 4 };
  expect(soloAudience("@Pat said", [reference], [ada], named)).toEqual({
    opensWithTag: false,
    recipients: [ada, reference],
  });
  // No tags: the toolbar's agents.
  expect(soloAudience("hi", [], [ada], named).recipients).toEqual([ada]);
});
