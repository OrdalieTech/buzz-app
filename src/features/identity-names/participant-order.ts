// One collator: localeCompare with options builds a collator per comparison.
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/** DM labels list people alphabetically, ignoring case, so one conversation
 * reads the same on every surface and is findable by any member's name. */
export function sortParticipantNames(names: readonly string[]): string[] {
  return [...names].sort(collator.compare);
}

/** Who a DM's name lists: its people, never agents, unless no other person is
 * in it. Member counts and lists still include agents. A profile not loaded
 * yet counts as a person until it says otherwise. */
export function dmNamedParticipants(
  participants: readonly string[],
  profiles: ReadonlyMap<string, { isAgent?: true | undefined }>,
): readonly string[] {
  const people = participants.filter((key) => !profiles.get(key)?.isAgent);
  return people.length ? people : participants;
}
