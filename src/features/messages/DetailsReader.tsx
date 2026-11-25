import { type ReactNode, useEffect, useState } from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { avatarMedia } from "../../shared/avatar-source";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useConversation } from "../conversation/Conversation";
import { useChannelIdentityNames } from "../identity-names/react";
import type { ChannelMessage } from "../relay/contracts";
import { useChannelWindow, useRowProfiles } from "../relay/react";
import type { RelaySession } from "../relay/session";
import { useComposerScope } from "./composer-overlay";
import { MessageMarkdown } from "./MessageMarkdown";
import { useReferenceDirectory } from "./ReferenceText";
import styles from "./Messages.module.css";

/** A message by id: from its conversation's loaded rows, else read exactly.
 * Undefined while it loads; null when it is missing. */
export function useReaderMessage(
  session: RelaySession,
  channelId: string,
  messageId: string,
): ChannelMessage | null | undefined {
  const window = useChannelWindow(session.channels, channelId);
  const loaded = window.rows.find((row) => row.id === messageId);
  const isLoaded = !!loaded;
  const [read, setRead] = useState<{
    id: string;
    message: ChannelMessage | null | undefined;
  }>();
  useEffect(() => {
    if (isLoaded) return;
    let view: ReturnType<RelaySession["thread"]>;
    try {
      view = session.thread(channelId, messageId, { exact: true });
    } catch {
      setRead({ id: messageId, message: null });
      return;
    }
    const update = () => {
      const snapshot = view.snapshot();
      setRead({
        id: messageId,
        message:
          snapshot.target ??
          (snapshot.targetStatus === "unavailable" ||
          snapshot.targetStatus === "error"
            ? null
            : undefined),
      });
    };
    const stop = view.subscribe(update);
    update();
    void view.refresh();
    return () => {
      stop();
      view.dispose();
    };
  }, [session, channelId, messageId, isLoaded]);
  return loaded ?? (read?.id === messageId ? read.message : undefined);
}

export type DetailsParts = Readonly<{
  title: ReactNode;
  avatar: ReactNode;
  time: ReactNode;
  body: ReactNode;
}>;

/**
 * A details message read whole, drawn from its id inside its conversation, so
 * it opens whether or not its row is on screen, and its links, mentions and
 * edits stay live. Draws nothing while it loads, or when it is missing, as a
 * missing message link shows nothing.
 */
export function DetailsReader({
  channelId,
  messageId,
  children,
}: {
  channelId: string;
  messageId: string;
  children(parts: DetailsParts): ReactNode;
}) {
  const { session, scope, extensions, onOpenLink, canOpenLink } =
    useConversation();
  const message = useReaderMessage(session, channelId, messageId);
  const resolveName = useChannelIdentityNames(session, channelId);
  const rows = message ? [message] : [];
  const profiles = useRowProfiles(session.profiles, rows);
  const directory = useReferenceDirectory(session, profiles);
  const composer = useComposerScope();
  if (!message) return null;
  // A verified relay's reader is titled with the agent it relays, never with
  // the signer.
  const author =
    (message.relayedFrom?.verified && message.relayedFrom.agent) ||
    message.authorId;
  const profile = profiles.get(author) ?? directory.profiles.get(author);
  const name = resolveName(author, profile?.name ?? author.slice(0, 10));
  const agent =
    (author === message.authorId && !!message.agentEnvelope) ||
    !!profile?.isAgent;
  const rootId = message.threadRootId ?? message.id;
  return children({
    title: name,
    avatar: (
      <Avatar
        src={avatarMedia(profile?.picture, session.media)}
        alt=""
        fallback={name}
        size="small"
        shape={agent ? "squircle" : "circle"}
      />
    ),
    time: formatItemTimestamp(message.createdAt, { withTime: true }),
    body: (
      <div className={styles.detailsReader}>
        <MessageMarkdown
          directory={directory}
          session={session}
          scope={scope}
          row={message}
          extensions={extensions}
          media={session.media}
          onOpenLink={(url) =>
            onOpenLink(url, {
              rootId,
              ...(composer && { view: { rootId: composer.rootId } }),
            })
          }
          canOpenLink={canOpenLink}
          participantProfiles={profiles}
        />
      </div>
    ),
  });
}
