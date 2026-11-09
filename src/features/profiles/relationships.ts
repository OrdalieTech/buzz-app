import type { ChannelSummary } from "../relay/contracts";

/**
 * How the viewer already relates to each person, for ordering people as
 * destinations (New message recipients, Command-K People). Lower is closer:
 * a one-to-one DM, then a group DM, then one of the viewer's messageable agents,
 * then a shared channel, then nobody. This is the destination form of the
 * mention chooser's "channel members first".
 */
export function peopleRelationships(
  channels: readonly ChannelSummary[],
  messageableAgents: ReadonlySet<string>,
) {
  const { dms, interacted, shared } = channelRelationships(channels);
  return {
    /** The one-to-one DM with this person, if one is listed. */
    dm: (pubkey: string) => dms.get(pubkey),
    rank: (pubkey: string) =>
      dms.has(pubkey)
        ? 0
        : interacted.has(pubkey)
          ? 1
          : messageableAgents.has(pubkey)
            ? 2
            : shared.has(pubkey)
              ? 3
              : 4,
  };
}
// Every render ranks against the same list until it changes; large channels
// make the member walk the expensive part.
const indexes = new WeakMap<
  readonly ChannelSummary[],
  Readonly<{
    dms: ReadonlyMap<string, string>;
    interacted: ReadonlySet<string>;
    shared: ReadonlySet<string>;
  }>
>();
function channelRelationships(channels: readonly ChannelSummary[]) {
  const known = indexes.get(channels);
  if (known) return known;
  const dms = new Map<string, string>();
  const interacted = new Set<string>();
  const shared = new Set<string>();
  for (const channel of channels) {
    for (const pubkey of channel.members ?? []) shared.add(pubkey);
    if (channel.channelType !== "dm") continue;
    for (const pubkey of channel.participants ?? []) interacted.add(pubkey);
    const only = channel.participants?.length === 1 && channel.participants[0];
    if (only) dms.set(only, channel.id);
  }
  const index = { dms, interacted, shared };
  indexes.set(channels, index);
  return index;
}
