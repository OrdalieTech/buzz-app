import type { OpenLayer } from "../../features/messages/view-layer";
import type { OpenTarget, ViewLayer } from "../../features/navigation/targets";

/** The inline thread and the layer over a view live in the conversation's
 * address. These are the transforms its openings and closings make to it:
 * pure, from the visit on screen to the visit, or visits, they replace. */

export type ConversationTarget = Extract<OpenTarget, { kind: "conversation" }>;

/** Visits retired together, and the one that takes their place. */
export type Dismissal = Readonly<{
  visits(visit: OpenTarget): boolean;
  fallback: OpenTarget;
}>;

/** Whether `visit` is in `target`'s conversation, for the same viewer. */
export const sameScope = (visit: OpenTarget, target: ConversationTarget) =>
  visit.kind === "conversation" &&
  visit.channelId === target.channelId &&
  visit.scope.viewer === target.scope.viewer &&
  visit.scope.communityOrigin === target.scope.communityOrigin;

const conversation = (target: OpenTarget | undefined) =>
  target?.kind === "conversation" ? target : undefined;

/** ✕, Escape and the scrim on the inline thread with `rootId`: its visits
 * retire, with a layer read over it and the reply it was opened at, which an
 * address names only with its thread. Back then leaves the conversation. */
export function inlineDismissal(
  current: OpenTarget | undefined,
  rootId: string,
): Dismissal | undefined {
  const target = conversation(current);
  if (target?.inline !== rootId) return;
  const { inline: _inline, inlineMessage: _message, layer, ...rest } = target;
  return {
    visits: (visit) =>
      sameScope(visit, target) &&
      visit.kind === "conversation" &&
      visit.inline === rootId,
    fallback: !layer || layer.rootId === rootId ? rest : { ...rest, layer },
  };
}

/** A link's thread hint names the inline thread until the reader verifies
 * its `root` from the linked message; the visits then name that root, so the
 * thread is the same one its row opens. */
export function canonicalInline(
  current: OpenTarget | undefined,
  from: string,
  root: string,
): Dismissal | undefined {
  const target = conversation(current);
  if (from === root || target?.inline !== from) return;
  const { layer, ...rest } = target;
  return {
    visits: (visit) =>
      sameScope(visit, target) &&
      visit.kind === "conversation" &&
      visit.inline === from,
    fallback: {
      ...rest,
      inline: root,
      ...(layer && layer.rootId !== from ? { layer } : {}),
    },
  };
}

/** Move to side panel: the inline thread's visits retire and the visit of
 * its tab takes their place. */
export function inlineToTab(
  current: OpenTarget | undefined,
  rootId: string,
): Dismissal | undefined {
  const dismissal = inlineDismissal(current, rootId);
  const target = conversation(current);
  if (!dismissal || !target) return;
  return {
    visits: dismissal.visits,
    fallback: {
      version: 1,
      kind: "conversation",
      scope: target.scope,
      channelId: target.channelId,
      messageId: rootId,
      threadRootId: rootId,
    },
  };
}

/** The thread with `rootId` inline over `current`'s conversation, the visit a
 * routed thread (a link, the sidebar) resolves to. A reply it named stays
 * named, so the thread opens at it as its tab would. */
export function routedInline(
  current: ConversationTarget,
  rootId: string,
): ConversationTarget {
  const {
    messageId,
    threadRootId: _root,
    context: _context,
    ...rest
  } = current;
  return {
    ...rest,
    inline: rootId,
    ...(messageId && messageId !== rootId ? { inlineMessage: messageId } : {}),
  };
}

/** The visit with `layer` open over the view it was opened in. Over a thread
 * the visit keeps that thread; over the conversation it is the
 * conversation's own dialog. */
export function layerVisit(
  current: ConversationTarget,
  layer: OpenLayer,
): ConversationTarget {
  const view = {
    ...(layer.rootId ? { rootId: layer.rootId } : {}),
    ...(layer.channelId !== current.channelId
      ? { channelId: layer.channelId }
      : {}),
  };
  const value: ViewLayer =
    layer.messageId !== undefined
      ? { messageId: layer.messageId, ...view }
      : {
          target: layer.target,
          ...(layer.threadId ? { threadId: layer.threadId } : {}),
          ...view,
        };
  return layer.rootId
    ? { ...current, layer: value }
    : {
        version: 1,
        kind: "conversation",
        scope: current.scope,
        channelId: current.channelId,
        layer: value,
      };
}

/** ✕, Escape or a send on the layer: its visits retire, and what was under
 * it stays, or `fallback` takes their place, as Open as tab does. A closing
 * that names the layer it means (`only`) does nothing once another is open:
 * a send that was waiting never closes what the reader opened meanwhile. */
export function layerDismissal(
  current: OpenTarget | undefined,
  fallback?: OpenTarget,
  only?: OpenLayer,
): Dismissal | undefined {
  const target = conversation(current);
  if (!target?.layer) return;
  const { layer, ...under } = target;
  if (
    only &&
    !(
      layer.messageId === only.messageId &&
      layer.target === only.target &&
      layer.threadId === only.threadId &&
      layer.rootId === only.rootId &&
      (layer.channelId ?? target.channelId) === only.channelId
    )
  )
    return;
  return {
    visits: (visit) =>
      sameScope(visit, target) &&
      visit.kind === "conversation" &&
      !!visit.layer &&
      visit.layer.messageId === layer.messageId &&
      visit.layer.target === layer.target &&
      visit.layer.threadId === layer.threadId &&
      visit.layer.rootId === layer.rootId &&
      visit.layer.channelId === layer.channelId,
    fallback: fallback ?? under,
  };
}
