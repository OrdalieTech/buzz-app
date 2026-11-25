import {
  type ReactNode,
  useCallback,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../features/panels/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import { useListedChannel } from "../../features/relay/listed-channel";
import { diffPreview } from "../../features/relay/membership";
import { PIN_KIND, pinLists } from "../../features/relay/pins";
import { useRelayConnection, useRowProfiles } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { MessageTimestamp } from "../../features/messages/MessageTimestamp";
import { useReferenceDirectory } from "../../features/messages/ReferenceText";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import {
  usePinnedMessages,
  usePinnedRows,
} from "../../features/messages/use-pins";
import {
  ArrowRightIcon,
  PinIcon,
  PinOffIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./PinsPanel.module.css";

function Launcher({
  context,
  pressed,
  toggle,
  relay,
}: ChannelLauncherProps & { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const current = connection.scope === context.scope;
  const solo = useListedChannel(
    connection.session.channels,
    context.channelId,
    (channel) => channel?.channelType === "solo",
  );
  const pins = usePinnedMessages(
    connection.session,
    current && connection.session.workflowAuthority
      ? context.channelId
      : undefined,
  );
  // Where this host sends pin commands, or still lists some pins.
  // A Solo chat offers no pins.
  if (
    !current ||
    solo ||
    (!connection.session.outbox?.supports(PIN_KIND) && !pins.ids.length)
  )
    return null;
  return (
    <IconButton
      size="toolbar"
      icon={<PinIcon size={16} aria-hidden="true" />}
      aria-label="Pinned messages"
      title="Pinned messages"
      aria-expanded={pressed}
      onClick={(event) => {
        event.currentTarget.focus();
        toggle(context.channelId);
      }}
    />
  );
}

/** A pin's body at one height, as a forward collapses, until opened. */
function PinBody({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const contentId = useId();
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const update = () =>
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const toggles = overflows || expanded;
  return (
    <>
      <div
        id={contentId}
        ref={measure}
        className={styles.pinBody}
        data-expanded={expanded || undefined}
        data-overflows={overflows || undefined}
        onFocusCapture={() => setExpanded(true)}
      >
        {children}
      </div>
      {/* Keeps its room when hidden, so every card is the same size. */}
      <span
        className={styles.toggle}
        data-hidden={!toggles || undefined}
        aria-hidden={!toggles || undefined}
      >
        <Button
          size="inline"
          variant="subtle"
          disabled={!toggles}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show full message"}
        </Button>
      </span>
    </>
  );
}

function PinnedList({
  session,
  channelId,
  scope,
  open,
  openLink,
}: {
  session: RelaySession;
  channelId: string;
  scope: string;
  open(row: ChannelMessage): void;
  openLink(url: string): boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const pins = usePinnedMessages(session, channelId);
  const pinned = usePinnedRows(session, channelId, pins.ids, attempt);
  const profiles = useRowProfiles(session.profiles, pinned.rows);
  const resolveName = useChannelIdentityNames(session, channelId);
  const canUnpin = useListedChannel(
    session.channels,
    channelId,
    (channel) =>
      !!channel && !channel.readOnly && !channel.cached && !channel.archived,
  );
  const dm = useListedChannel(
    session.channels,
    channelId,
    (channel) => channel?.channelType === "dm",
  );
  const [error, setError] = useState<string>();
  const retry = () =>
    pins.status === "error"
      ? pinLists(session).retry(channelId)
      : setAttempt((value) => value + 1);
  const pinnable = !!session.outbox?.supports(PIN_KIND);
  const directory = useReferenceDirectory(session, profiles);
  if (
    pins.status === "error" ||
    (pinned.status === "error" && !pinned.rows.length)
  )
    return (
      <EmptyState
        icon={<PinIcon />}
        title="Couldn’t load pinned messages"
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  if (
    pins.status === "loading" ||
    (pinned.status === "loading" && !pinned.rows.length && pins.ids.length)
  )
    return (
      <p role="status" className={styles.status}>
        Loading pinned messages…
      </p>
    );
  if (!pinned.rows.length)
    return (
      <EmptyState
        icon={<PinIcon />}
        title="No pinned messages"
        {...(pinnable && {
          description: "Pin a message from its More menu to keep it here.",
        })}
      />
    );
  return (
    <>
      {/* A failed refresh retries in the background, keeping these rows. */}
      {error && (
        <p role="alert" className={styles.status}>
          {error}
        </p>
      )}
      <ul className={styles.list} aria-label="Pinned messages">
        {pinned.rows.map((row) => {
          const profile = profiles.get(row.authorId);
          const name = resolveName(
            row.authorId,
            profile?.name ?? row.authorId.slice(0, 10),
          );
          const attachments = row.attachments.length;
          return (
            <li key={row.id} className={styles.card}>
              <div className={styles.head}>
                <Avatar
                  alt=""
                  fallback={name}
                  src={avatarMedia(profile?.picture, session.media)}
                  size="small"
                  shape={profile?.isAgent ? "squircle" : "circle"}
                />
                <span className={styles.byline}>
                  <strong className="text-label-sm">{name}</strong>
                  <MessageTimestamp createdAt={row.createdAt} />
                </span>
                <IconButton
                  size="sm"
                  hint="helpful"
                  aria-label={`Go to message from ${name}`}
                  title="Go to message"
                  icon={<ArrowRightIcon />}
                  onClick={() => open(row)}
                />
                {canUnpin && pinnable && (
                  <IconButton
                    size="sm"
                    hint="helpful"
                    aria-label={`Unpin message from ${name}`}
                    title={dm ? "Unpin from DM" : "Unpin from channel"}
                    icon={<PinOffIcon />}
                    onClick={() => {
                      setError(undefined);
                      try {
                        session.messages.pin(channelId, row.id, false);
                      } catch (cause) {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Could not unpin. Try again.",
                        );
                      }
                    }}
                  />
                )}
              </div>
              <PinBody>
                {row.diff ? (
                  <p>{diffPreview(row.diff)}</p>
                ) : (
                  <MessageMarkdown
                    row={row}
                    directory={directory}
                    session={session}
                    scope={scope}
                    media={session.media}
                    onOpenLink={openLink}
                    participantProfiles={profiles}
                  />
                )}
                {attachments > 0 && (
                  <p className="text-body-sm text-subtle">
                    {attachments === 1
                      ? "1 attachment"
                      : `${attachments} attachments`}
                  </p>
                )}
              </PinBody>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function registerPins(ctx: Context) {
  function Panel({ channelContext, close }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const ready =
      !!channelContext &&
      state.status === "ready" &&
      state.scope === channelContext.scope;
    return (
      <div className={styles.panel}>
        <PanelHeader
          title="Pinned"
          actions={
            <IconButton
              size="toolbar"
              aria-label="Close pinned messages"
              onClick={close}
              icon={<XIcon size={18} aria-hidden="true" />}
            />
          }
        />
        <div className={styles.body}>
          {ready && state.origin && state.viewer ? (
            <PinnedList
              key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
              session={state.session}
              channelId={channelContext.channelId}
              scope={state.scope}
              openLink={(url) => {
                const target = buzzLinkTarget(url, {
                  viewer: state.viewer ?? "",
                  communityOrigin: state.origin ?? "",
                });
                if (!target) return false;
                close();
                void ctx.navigation.open(target);
                return true;
              }}
              open={(row) => {
                // As a message link does: the message replaces the list.
                close();
                void ctx.navigation.open({
                  version: 1,
                  kind: "conversation",
                  scope: {
                    viewer: state.viewer ?? "",
                    communityOrigin: state.origin ?? "",
                  },
                  channelId: row.channelId,
                  messageId: row.id,
                  ...(row.threadRootId
                    ? { threadRootId: row.threadRootId }
                    : {}),
                });
              }}
            />
          ) : (
            <p role="status" className={styles.status}>
              Pinned messages are unavailable while the connection recovers.
            </p>
          )}
        </div>
      </div>
    );
  }
  ctx.panels.register({
    id: "pins",
    title: "Pinned",
    matches: () => false,
    channelLauncher: (props) => <Launcher {...props} relay={ctx.relay} />,
    channelPlacement: "side",
    component: Panel,
  });
}
