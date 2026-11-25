import type {
  ChannelMessage,
  ChannelSummary,
  MembershipChange,
} from "./contracts.ts";
import type { EventData } from "./events.ts";
import { objectBody } from "./body.ts";

/** Content rows retained by channel history/live windows, not the unread kind set. */
export const CHANNEL_ROW_KINDS = [9, 40002, 40008, 40099, 48100, 48103];
export const channelRowKind = (kind: number) =>
  CHANNEL_ROW_KINDS.includes(kind);
/** A content row has one channel home; ambiguous tags are not membership evidence. */
export function channelRowChannel(event: EventData): string | undefined {
  if (!channelRowKind(event.kind)) return undefined;
  let home: string[] | undefined;
  for (let index = 0; index < event.tags.length; index++) {
    const entry = event.tags[index];
    if (entry?.[0] !== "h") continue;
    if (home) return undefined;
    home = entry;
  }
  return home?.[1] || undefined;
}
const pubkey = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Only the session's verified relay identity may describe membership activity. */
export function membershipChange(
  event: EventData,
  relayAuthor: string,
): MembershipChange | undefined {
  if (event.kind !== 40099 || event.pubkey !== relayAuthor) return;
  const body = objectBody(event.content);
  if (!body || !pubkey(body.actor)) return;
  if (body.type === "member_left") {
    if (body.target !== undefined && body.target !== body.actor) return;
    return Object.freeze({
      type: body.type,
      actor: body.actor,
      target: body.actor,
    });
  }
  if (
    (body.type === "member_joined" || body.type === "member_removed") &&
    pubkey(body.target)
  )
    return Object.freeze({
      type: body.type,
      actor: body.actor,
      target: body.target,
    });
}

/** Shared profile demand includes system actors/subjects without inventing mentions. */
export function rowProfileIds(row: ChannelMessage): readonly string[] {
  return row.membership
    ? [row.membership.actor, row.membership.target]
    : [
        row.authorId,
        ...(row.workflowOwnerId ? [row.workflowOwnerId] : []),
        // Loading the claimed agent's profile is what lets its owner verify.
        ...(row.relayedFrom ? [row.relayedFrom.agent] : []),
        ...row.mentions,
        ...(row.mentionReferences ?? []),
        ...row.participants,
      ];
}

/** One line naming a diff row, whose content is a raw patch rather than prose. */
export const diffPreview = (diff: NonNullable<ChannelMessage["diff"]>) =>
  `Diff: ${diff.filePath || "patch"}${diff.description ? ` — ${diff.description}` : ""}`;

/** Activity never replaces the latest conversational sidebar preview. */
export function messagePreview(
  rows: readonly ChannelMessage[] = [],
): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && !row.membership && !row.huddle)
      return row.diff ? diffPreview(row.diff) : row.content;
  }
}

/** Viewer-only membership. Legacy summaries may still carry only a signed roster.
 * Explicit viewer evidence wins even when a retained peer roster disagrees. */
export function viewerMember(
  channel: Pick<ChannelSummary, "viewerMembership" | "members"> | undefined,
  viewer: string | undefined,
): boolean {
  if (!channel || !viewer) return false;
  const membership = channel.viewerMembership;
  return membership
    ? membership.pubkey === viewer && membership.joined
    : !!channel.members?.includes(viewer);
}
