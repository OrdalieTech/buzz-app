import { useSyncExternalStore, type ReactNode } from "react";
import { MessageLoading } from "../messages/MessageLoading";
import { useSheetReady } from "../messages/sheet-reveal";
import styles from "../messages/Messages.module.css";
import type { ChannelSummary } from "../relay/contracts";
import { viewerMember } from "../relay/membership";
import { rosterRecovering } from "../relay/live-recovery";
import { useRecoveryOwns } from "../relay/RecoveryNotice";
import type { RelaySession } from "../relay/session";

/** What is mounted on a channel: a thread, which only reads it, or the
 * conversation with its composer. */
type ChannelView = "thread" | "conversation";
type Session = Pick<RelaySession, "recovery" | "live" | "channels" | "viewer">;

const DID_NOT_LOAD = "This conversation didn’t load.";

/** `channel`, when a view can be mounted on it.
 *
 * The relay must have confirmed it in this session. A channel listed from
 * saved membership is not confirmed, and the session refuses to read it, so
 * a thread mounted on one would report a failure that clears by itself.
 *
 * A confirmed channel's thread is read whether or not the viewer can post:
 * the thread shows an archived or guest channel with its notice in place of
 * the composer. This relies on the joined list holding only channels whose
 * roster names the viewer (DiscoveryState.readable), so a confirmed listing
 * is one the viewer may read. Only the conversation, which always mounts a
 * composer, needs a channel the viewer can post in. */
export function confirmedChannel(
  view: ChannelView,
  channel: ChannelSummary | undefined,
  viewer: string | undefined,
) {
  if (!channel || channel.cached) return undefined;
  if (view === "thread") return channel;
  return !channel.readOnly &&
    !channel.archived &&
    (channel.channelType !== "solo" || viewerMember(channel, viewer))
    ? channel
    : undefined;
}

/** A view of a channel, mounted only once `confirmedChannel` admits it. Until
 * then it shows what `Unavailable` decides, so every surface that holds such
 * a view (a tab's body, an inline thread sheet) waits and explains alike. The
 * host resolves `channel` and re-renders as it changes, so the view replaces
 * the wait only as promptly as its host follows the list. */
export function ConfirmedChannel({
  session,
  view,
  channelId,
  channel,
  children,
}: {
  session: Session;
  view: ChannelView;
  channelId: string;
  /** The channel as its host lists it, confirmed or not. */
  channel: ChannelSummary | undefined;
  children: (channel: ChannelSummary) => ReactNode;
}) {
  const confirmed = confirmedChannel(view, channel, session.viewer);
  return confirmed ? (
    children(confirmed)
  ) : (
    <Unavailable
      session={session}
      view={view}
      channelId={channelId}
      channel={channel}
    />
  );
}

/** In place of a view with no usable channel: the message placeholders while
 * the roster read is still expected to settle the channel, else the most
 * specific reason known. It reads the list and the roster read itself, so
 * the states of a missing channel stay current under a host that follows
 * neither.
 *
 * A channel the relay has confirmed states why the conversation cannot show
 * it; a thread shows such a channel with its notice and never gets here.
 * Otherwise the channel is missing, or listed from saved membership:
 *
 * - The relay's own answer for the channel settles it at once: a denied read
 *   of it, or a roster that dropped the viewer, takes it off the list before
 *   any roster read completes.
 * - Without a connection nothing is read, so absence proves nothing.
 * - Only a complete roster read proves a missing channel gone. A `ready` list
 *   may be restored from saved events or hold one page of a longer read.
 * - `rosterAsOf` is set once this session has completed such a read, and
 *   kept through later refreshes, whose pages, failures and retries revoke
 *   nothing by omission. A missing channel stays gone throughout.
 * - A failed or interrupted read keeps the placeholders while recovery
 *   retries it, the recovery notice being the one report, as in the sidebar.
 * - A read that settled without deciding the channel (its cap was hit) is
 *   stated, so the placeholders end once the read does. */
function Unavailable({
  session,
  view,
  channelId,
  channel,
}: {
  session: Session;
  view: ChannelView;
  channelId: string;
  channel: ChannelSummary | undefined;
}) {
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const readRoster = () => session.live.snapshot().roster.state;
  const roster = useSyncExternalStore(
    session.live.subscribe,
    readRoster,
    readRoster,
  );
  const retrying = useRecoveryOwns(session, (live) =>
    rosterRecovering(live.roster),
  );
  const reason = () => {
    if (channel && !channel.cached) {
      if (channel.archived) return "This conversation is archived.";
      if (channel.readOnly)
        return "You have read-only access to this conversation.";
      return "This conversation is no longer available.";
    }
    if (!channel && session.channels.revoked?.(channelId))
      return "This conversation is no longer available.";
    if (session.channels.cachedOnly)
      return channel
        ? "This conversation will appear once Buzz reconnects."
        : "This conversation may appear once Buzz reconnects.";
    if (list.status === "unavailable") return DID_NOT_LOAD;
    if (!channel && list.rosterAsOf !== undefined)
      return "This conversation is no longer available.";
    if (list.status === "error" || roster === "error" || roster === "deferred")
      return retrying ? undefined : DID_NOT_LOAD;
    return roster === "verified" ? DID_NOT_LOAD : undefined;
  };
  const text = reason();
  // A settled notice is all a quick-opening sheet will show; a loading one is
  // not settled.
  useSheetReady(!!text);
  return text ? (
    <p role="status" className={styles.empty}>
      {text}
    </p>
  ) : (
    <MessageLoading
      label={view === "thread" ? "Loading thread…" : "Loading conversation…"}
      placeholders={view !== "thread"}
    />
  );
}
