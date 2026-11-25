export const isMigrationSource = (source: unknown): source is string =>
  typeof source === "string" && source.length > 0;

export function migrationSource(tags: readonly (readonly string[])[]) {
  return tags.find(
    (tag) =>
      tag.length === 2 && tag[0] === "migration" && isMigrationSource(tag[1]),
  )?.[1];
}
