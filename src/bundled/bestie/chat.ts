import { viewerMember } from "../../features/relay/membership";
import type { ChannelSummary } from "../../features/relay/contracts";

/** The verified one-to-one DM with this Bestie. Solo chats stay separate. */
export function bestieChat(
  channels: readonly ChannelSummary[],
  viewer: string | undefined,
  bestie: string | undefined,
) {
  if (!viewer || !bestie) return;
  return channels
    .filter(
      (channel) =>
        channel.channelType === "dm" &&
        !channel.cached &&
        !channel.archived &&
        viewerMember(channel, viewer) &&
        onlyOther(channel.members, viewer) === bestie,
    )
    .sort(
      (a, b) =>
        recency(b) - recency(a) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .at(0);
}

const recency = (channel: ChannelSummary) =>
  channel.lastActivityAt ?? channel.createdAt ?? 0;

function onlyOther(members: readonly string[] | undefined, viewer: string) {
  if (!members) return;
  const others = [...new Set(members)].filter((key) => key !== viewer);
  return others.length === 1 ? others[0] : undefined;
}
