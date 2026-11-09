import type { RelayData } from "../relay/service";
import type { RelayEvent } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { profileMentionParts } from "../messages/profile-mentions";
import { profileKey } from "../profiles/target";
import type { DraftRecipient } from "../messages/mention-draft";
import { ownSolo, SOLO_NAMED_LABEL } from "../solo/labels";
import { isStartingChatTitle } from "../solo/chat-title";

/**
 * Names the owner's Solo chat with an agent harness's own title, once. Only a
 * chat that still has its original first-message name is renamed. The first
 * tagged harness on that message names it, regardless of retry wording. A chat
 * renamed by anyone, including by this, is never touched again. The owner's
 * session renames it, as the owner would.
 */
export async function nameSoloChat(
  relay: RelayData | undefined,
  owner: string,
  agent: string,
  event: RelayEvent,
  title: string,
) {
  // Every reason to leave a chat's name is quiet by design; log which one, or
  // a title that never lands can't be traced.
  const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
  const skip = (reason: string) =>
    console.info(`Solo chat not named (${reason})`, { channel, title });
  const snapshot = relay?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner)
    return skip("owner not connected");
  const { session } = snapshot;
  const solo = () =>
    ownSolo(
      session.channels.list().channels.find((item) => item.id === channel),
      owner,
    );
  if (!channel || !solo()) return skip("not the owner's Solo chat");
  const name = [...canonicalDetailsName(title.replace(/\s+/g, " "))]
    .slice(0, 120)
    .join("");
  const details = session.channelDetails;
  if (!name) return skip("empty title");
  if (!details.available) return skip("channel editing unavailable");
  const current = () => {
    const latest = relay?.snapshot();
    return (
      latest?.status === "ready" &&
      latest.viewer === owner &&
      latest.session === session &&
      solo()
    );
  };
  // Naming is for a new chat, not an unbounded history scan. A full page cannot
  // establish the first message, so keep the existing title rather than guess.
  // An ordinary filter, not a channel window: the relay's window ignores authors
  // and rejects `until` without a `before_id` cursor. Replies are dropped below.
  const limit = 100;
  const history = await session.read([
    {
      kinds: [9],
      authors: [owner],
      "#h": [channel],
      until: event.created_at,
      limit,
      consistency: "strong",
    },
  ]);
  if (!current()) return skip("connection changed");
  if (history.length >= limit) return skip("too much history");
  // session.read also merges the local outbox; an unsent event cannot be
  // evidence of the chat's original published message.
  if (
    history.some(
      (message) =>
        message.delivery !== undefined &&
        message.delivery !== "accepted" &&
        message.delivery !== "seen",
    )
  )
    return skip("unsent message");
  const messages = history
    .filter(
      (message) =>
        message.kind === 9 &&
        message.pubkey === owner &&
        message.created_at <= event.created_at &&
        !threadReference(message) &&
        message.tags.some(([key, value]) => key === "h" && value === channel),
    )
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const original = messages[0];
  if (!original) return skip("first message not found");
  // Same-second messages do not prove authoring order. Do not choose a winner.
  if (messages[1]?.created_at === original.created_at)
    return skip("first message unclear");
  if (original.tags.find(([tag]) => tag === "p")?.[1] !== agent)
    return skip("another agent was tagged first");
  const recipients: DraftRecipient[] = [];
  let offset = 0;
  for (const part of profileMentionParts(
    {
      content: original.content,
      mentions: original.tags
        .filter(([key]) => key === "p")
        .map((tag) => tag[1] ?? ""),
    },
    session.profiles.snapshot(),
    session.agentChoices.snapshot().identities,
  )) {
    const pubkey = part.target && profileKey(part.target);
    if (pubkey)
      recipients.push({
        pubkey,
        name: part.text.slice(1),
        start: offset,
        end: offset + part.text.length,
      });
    offset += part.text.length;
  }
  const base = await details.load(channel);
  if (!current()) return skip("connection changed");
  if (!base.canEdit) return skip("owner can't edit the chat");
  if (
    base.labels?.includes(SOLO_NAMED_LABEL) ||
    base.name === name ||
    !isStartingChatTitle(base.name, { text: original.content, recipients })
  )
    return skip("chat already renamed");
  await details.save(base, { ...base, name });
}
