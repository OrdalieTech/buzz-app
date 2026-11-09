import type { ChannelMessage } from "../relay/contracts";

/** Only consecutive agent-only messages on one local day fold together.
 * Human messages, public agent replies and membership notices stay visible. */
export function activityRuns(
  rows: readonly ChannelMessage[],
  requests?: ReadonlyMap<string, string>,
): ChannelMessage[][] {
  const groups: ChannelMessage[][] = [];
  let group: ChannelMessage[] | undefined;
  let previous: ChannelMessage | undefined;
  for (const row of rows) {
    if (row.audience !== "agents" || row.membership) {
      group = undefined;
    } else {
      if (
        !group ||
        previous?.channelId !== row.channelId ||
        previous.threadRootId !== row.threadRootId ||
        requests?.get(previous.id) !== requests?.get(row.id) ||
        new Date(previous.createdAt * 1000).toDateString() !==
          new Date(row.createdAt * 1000).toDateString()
      ) {
        group = [];
        groups.push(group);
      }
      group.push(row);
    }
    previous = row;
  }
  return groups;
}
