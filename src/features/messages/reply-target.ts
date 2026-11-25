import { useSyncExternalStore } from "react";

/** The key a thread's reply box saves its draft under: the thread's root, or
 * one invocation's branch (`threadRootId`) of the thread `sourceRootId`. */
export const threadDraftKey = (
  channelId: string,
  threadRootId: string,
  sourceRootId?: string | undefined,
) =>
  sourceRootId
    ? `draft:${channelId}:thread:${sourceRootId}:subthread:${threadRootId}`
    : `draft:${channelId}:thread:${threadRootId}`;

/** The reply a thread's draft is aimed at ("Replying to …"), kept beside
 * that draft: per session, under the draft's scope and key. Every reader of
 * the thread shares it, so it follows the draft from an inline sheet to a tab
 * and through a close and reopen. It is held in memory only, so a reload
 * starts without one. */
type Targets = {
  ids: Map<string, string>;
  subscribe(listener: () => void): () => void;
  changed(): void;
};
const targets = new WeakMap<object, Targets>();
function targetsFor(session: object) {
  let held = targets.get(session);
  if (!held) {
    const listeners = new Set<() => void>();
    held = {
      ids: new Map(),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      changed() {
        for (const listener of [...listeners]) listener();
      },
    };
    targets.set(session, held);
  }
  return held;
}
const name = (scope: string, draftKey: string) => `${scope}:${draftKey}`;

export const replyTarget = (session: object, scope: string, draftKey: string) =>
  targets.get(session)?.ids.get(name(scope, draftKey));

/** Aims the draft at the reply `id`, or at its thread when undefined. */
export function setReplyTarget(
  session: object,
  scope: string,
  draftKey: string,
  id: string | undefined,
) {
  if (replyTarget(session, scope, draftKey) === id) return;
  const held = targetsFor(session);
  if (id) held.ids.set(name(scope, draftKey), id);
  else held.ids.delete(name(scope, draftKey));
  held.changed();
}

/** A send answered `id`: the draft it cleared no longer aims at it. A target
 * chosen since, while that send was publishing, stays. */
export function retireReplyTarget(
  session: object,
  scope: string,
  draftKey: string,
  id: string | undefined,
) {
  if (id && replyTarget(session, scope, draftKey) === id)
    setReplyTarget(session, scope, draftKey, undefined);
}

/** The target of the draft at `draftKey`; none until the key is known. */
export function useReplyTarget(
  session: object,
  scope: string,
  draftKey: string | undefined,
) {
  const read = () =>
    draftKey === undefined ? undefined : replyTarget(session, scope, draftKey);
  return useSyncExternalStore(targetsFor(session).subscribe, read, read);
}
