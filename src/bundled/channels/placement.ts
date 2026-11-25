import { threadPlacementPreference } from "../../features/messages/thread-preferences";
import type { Panel } from "../../features/panels/service";
import type { ChannelSummary } from "../../features/relay/contracts";

/** What the viewer opened from a view: a thread, a panel (a profile, a pull
 * request, a diff, a plugin's link panel), media, or a link to a Solo chat. */
export type Opening =
  | Readonly<{ kind: "thread" }>
  | Readonly<{ kind: "panel"; panel: Pick<Panel, "inline"> }>
  | Readonly<{ kind: "chat" }>;

/**
 * Where an opening goes: `inline` is a dialog on the view it was opened from
 * (for a Solo chat link, going to the chat itself, since inline opens no
 * tabs); `tab` is a tab, as on main, or for media its fullscreen viewer.
 * Media is a viewer either way: it never adds a step to history.
 *
 * This is the only place that reads the placement setting for an opening.
 * Under any setting but inline everything opens as a tab. Under inline, an
 * opening that already has a tab focuses that tab, so nothing is inline and
 * in a tab at once; a view that can't hold a dialog, and a panel that
 * declares `inline: false`, open tabs too.
 */
export function placeOpening(
  opening: Opening,
  {
    hasTab,
    canHold,
  }: Readonly<{
    /** A tab already shows it. */
    hasTab: boolean;
    /** The page addresses dialogs on the view it was opened from. */
    canHold: boolean;
  }>,
): "inline" | "tab" {
  if (threadPlacementPreference() !== "inline") return "tab";
  if (hasTab || !canHold) return "tab";
  if (opening.kind === "panel" && opening.panel.inline === false) return "tab";
  return "inline";
}

/** Whether `channel` shows a composer box, which an inline thread takes the
 * place of: not archived, not a guest's, writable unless only saved, on a
 * connection that can write. */
export const composesIn = (
  channel: ChannelSummary | undefined,
  readingOnly: boolean,
) =>
  !!channel &&
  !channel.archived &&
  channel.viewerRole !== "guest" &&
  (!channel.readOnly || !!channel.cached) &&
  !readingOnly;

/** What the page on screen can hold inline, read when something is opened. */
export type InlineHost = Readonly<{
  /** The page addresses its views, and its visit is a conversation's. */
  addressed: boolean;
  /** The conversation it shows. */
  channelId: string | undefined;
  /** That conversation's composer is on screen, which a thread sheet takes
   * the place of. */
  composes: boolean;
  /** Its threads open in a pane of their own, as a Solo chat's do. */
  threadsInPane: boolean;
}>;

/** Where in the page an opening would read: the conversation of `channelId`,
 * or the thread view with `rootId` (the inline thread or a thread tab). */
export type InlineView = Readonly<{
  channelId: string;
  rootId?: string | undefined;
}>;

/** Whether `host` can hold `opening` read from `view`: the one answer for
 * `placeOpening`'s `canHold`. A thread needs the conversation it belongs to,
 * on screen with its composer. A panel needs a view of this page: the
 * conversation on screen, or a thread view; without a composer it reads as
 * a centered dialog. A link to a Solo chat goes to the chat itself. */
export function canHoldInline(
  opening: Opening,
  host: InlineHost,
  view: InlineView,
): boolean {
  if (opening.kind === "chat") return true;
  if (!host.addressed || !host.channelId) return false;
  if (opening.kind === "thread")
    return (
      host.composes && !host.threadsInPane && view.channelId === host.channelId
    );
  if (opening.kind === "panel")
    return view.rootId !== undefined || view.channelId === host.channelId;
  return false;
}

/** `placeOpening` for an opening read from `view` of `host`. */
export const placeIn = (
  opening: Opening,
  host: InlineHost,
  view: InlineView,
  hasTab: boolean,
) =>
  placeOpening(opening, {
    hasTab,
    canHold: canHoldInline(opening, host, view),
  });
