// What the owner's Activity may show of an agent's saved conversations. The
// agent can read channels its owner cannot, such as a DM with a sibling agent,
// and its harness saves those conversations like any other, so every
// owner-facing list, label and transcript passes through these.
import {
  promptChannel,
  STEER,
  type TranscriptTurn,
} from "./activity-transcript";
import type { AgentReads } from "./reads";
import type { SessionUsage } from "./service";

type Place = Readonly<{ channelId: string; community?: true }>;

/** The channel's name and kind, only when the owner can read it. */
export const ownerLabel = (reads: AgentReads | undefined, channelId: string) =>
  reads?.ownerReadable(channelId) ? reads.channelLabel(channelId) : undefined;

/** The conversations in channels the owner can read; a community session
 * spans channels, so it stays and its turns are checked one by one. */
export const ownerRows = <T extends Place>(
  rows: readonly T[],
  reads: AgentReads | undefined,
) =>
  rows.filter(
    (row) => row.community || reads?.ownerReadable(row.channelId) === true,
  );

/** The turns of `place` the owner can read. A community session's turn is
 * read when it opens with its own prompt, not a steer whose opening was cut
 * off, and every prompt names a channel the owner can read; a prompt or turn
 * with no known source is not shown. */
export function ownerTurns<T extends TranscriptTurn>(
  turns: readonly T[],
  reads: AgentReads | undefined,
  place: Place,
): T[] {
  if (!place.community)
    return reads?.ownerReadable(place.channelId) ? [...turns] : [];
  return turns.filter((turn) => {
    const prompts = turn.items.flatMap((item) =>
      item.type === "prompt" ? [item] : [],
    );
    const sources = prompts.map((prompt) => promptChannel(prompt.sections));
    const [opening] = prompts;
    return (
      !!opening &&
      !opening.steer &&
      !opening.sections.some((section) => section.tag === STEER) &&
      sources.every(
        (channelId) =>
          channelId !== undefined && reads?.ownerReadable(channelId) === true,
      )
    );
  });
}

/** The sessions' usage, without where and what a session was about unless the
 * owner can read its channel: its cost is the owner's, its content not. */
export const ownerUsage = (
  sessions: readonly SessionUsage[],
  reads: AgentReads | undefined,
) =>
  sessions.map((session) => {
    if (session.channelId && reads?.ownerReadable(session.channelId))
      return session;
    const { channelId: _, root: __, title: ___, ...rest } = session;
    return rest;
  });
