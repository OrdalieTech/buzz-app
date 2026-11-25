import { useListedChannel } from "../relay/listed-channel";
import type { ComposerSession } from "./composer-session";

/** What a channel's composer can do on this connection. `cached`: the channel
 * is a cached copy, whose composer shows without sending. `readingOnly`: the
 * connection can't publish chat messages (kind 9) and the channel isn't
 * cached, so the composer is a read-only footer with no box. */
export function useComposerWrites(
  session: Pick<ComposerSession, "outbox" | "channels">,
  channelId: string | undefined,
  soloConversation: boolean | undefined,
) {
  const listed =
    session.channels?.get || soloConversation ? session.channels : undefined;
  const cached = useListedChannel(
    listed,
    channelId,
    (channel) => !!channel?.cached,
  );
  return { cached, readingOnly: !session.outbox?.supports(9) && !cached };
}
