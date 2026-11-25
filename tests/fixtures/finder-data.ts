import type { ReadFilter, RelayEvent } from "../../src/features/relay/events";

/** A small relay for the fixture and Finder's owner tests. */
export function queryEvents(
  events: readonly RelayEvent[],
  filters: readonly ReadFilter[],
) {
  return filters.flatMap((filter) =>
    events
      .filter((event) => {
        const tagged = (name: string, values: readonly string[] | undefined) =>
          !values ||
          event.tags.some(
            ([key, value]) => key === name && values.includes(value ?? ""),
          );
        return (
          (!filter.ids || filter.ids.includes(event.id)) &&
          (!filter.kinds || filter.kinds.includes(event.kind)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (filter.since === undefined || event.created_at >= filter.since) &&
          (filter.until === undefined || event.created_at <= filter.until) &&
          (!filter.before_id ||
            filter.until === undefined ||
            event.created_at < filter.until ||
            event.id > filter.before_id) &&
          (!filter.search ||
            filter.search
              .toLowerCase()
              .split(/\s+/)
              .every((term) =>
                event.content
                  .toLowerCase()
                  .split(/\W+/)
                  .some((word) => word.startsWith(term)),
              )) &&
          tagged("h", filter["#h"]) &&
          tagged("d", filter["#d"]) &&
          tagged("p", filter["#p"]) &&
          tagged("e", filter["#e"])
        );
      })
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(
        ((filter.page ?? 1) - 1) * (filter.limit ?? 500),
        (filter.page ?? 1) * (filter.limit ?? 500),
      ),
  );
}
