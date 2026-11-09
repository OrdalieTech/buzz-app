// One collator: localeCompare with options builds a collator per comparison.
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/** DM labels list people alphabetically, ignoring case, so one conversation
 * reads the same on every surface and is findable by any member's name. */
export function sortParticipantNames(names: readonly string[]): string[] {
  return [...names].sort(collator.compare);
}
