import { startTransition, useEffect, useState } from "react";
import { ConfirmedChannel } from "../../features/conversation/ConfirmedChannel";
import { ConversationThread } from "../../features/conversation/Conversation";
import {
  ComposerScopeProvider,
  composerHost,
  useComposerDock,
  useComposerScope,
} from "../../features/messages/composer-overlay";
import { ComposerSheet } from "../../features/messages/ComposerSheet";
import {
  INLINE_THREAD_INTRO,
  InlineThreadIntro,
  type InlineThreadIntroStep,
  introducesInlineThreads,
} from "../../features/messages/InlineThreadIntro";
import { LayerReader } from "../../features/messages/LayerReader";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { Seen } from "../../features/seen/service";

/** The reply box's placeholder, guessed from the root's row in the
 * view so the view's composer can turn into it as the sheet opens. The reply
 * box corrects it once it mounts. */
function guessPlaceholder(rootId: string) {
  const row = document.querySelector(
    `[data-message-id="${CSS.escape(rootId)}"]`,
  );
  const author = row?.querySelector("strong")?.textContent?.trim();
  return author ? `Reply in thread to ${author}` : "Reply in thread";
}

/** The conversation's inline thread: a dialog drawn over the conversation's
 * composer, with the thread's own reply box in its place. The address owns
 * whether it is open; this only presents it. The viewer's first one
 * introduces itself. The thread and its layers mount once the relay has
 * confirmed the channel, as a thread tab's do; until then the sheet waits. */
export function InlineThreadSheet({
  session,
  channel,
  rootId,
  messageId,
  tall,
  seen,
  close,
  moveToTab,
  onResolvedRoot,
}: {
  session: RelaySession;
  /** The open conversation, which may still be listed from saved membership. */
  channel: ChannelSummary;
  rootId: string;
  /** The reply a link named, which the thread opens at. */
  messageId?: string | undefined;
  /** A layer sits over it: it grows to fit that layer until it closes. */
  tall: boolean;
  /** Records that the viewer has been shown the intro. */
  seen?: Seen | undefined;
  /** Explicit close: ✕, Escape or the scrim. */
  close(): void;
  /** Moves the thread to a side-pane tab. */
  moveToTab(): void;
  /** The thread's verified root, which a link to one of its replies names
   * only once the reply is read. */
  onResolvedRoot?: ((rootId: string) => void) | undefined;
}) {
  const view = useComposerScope();
  const dock = useComposerDock(view?.handle);
  // Decided once per thread opening; a thread closed mid-intro shows it again.
  const [intro, setIntro] = useState<InlineThreadIntroStep | undefined>(() =>
    introducesInlineThreads(seen) ? 1 : undefined,
  );
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [placeholder] = useState(() => guessPlaceholder(rootId));
  // The reply box takes focus once the thread is drawn, not while hidden.
  const [focusRequest, setFocusRequest] = useState(0);
  // The thread mounts once the open motion is under way on the
  // compositor, not in the click's frame, and draws hidden until it's ready.
  const [threadMounted, setThreadMounted] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => startTransition(() => setThreadMounted(true)));
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, []);
  const host = dock ? composerHost(view?.handle) : null;
  if (!host) return null;
  return (
    <>
      <ComposerSheet
        open
        onOpenChange={(next) => {
          if (!next) close();
        }}
        host={host}
        title="Thread"
        containsComposer
        tall={tall}
        quick={{ placeholder, onReveal: () => setFocusRequest(1) }}
        spotlight={intro}
        onSpotlightAnchor={setAnchor}
        onMoveToTab={() => {
          if (intro) seen?.mark(INLINE_THREAD_INTRO);
          moveToTab();
        }}
      >
        {threadMounted && (
          <ConfirmedChannel
            session={session}
            view="thread"
            channelId={channel.id}
            channel={channel}
          >
            {(confirmed) => (
              // The thread's own view, for the details and panels its rows open.
              <ComposerScopeProvider rootId={rootId}>
                <ConversationThread
                  messageId={messageId ?? rootId}
                  revealSelected={messageId !== undefined}
                  focusRequest={focusRequest}
                  onResolvedRoot={onResolvedRoot}
                />
                <LayerReader channelId={confirmed.id} />
              </ComposerScopeProvider>
            )}
          </ConfirmedChannel>
        )}
      </ComposerSheet>
      {intro && (
        <InlineThreadIntro
          seen={seen}
          step={intro}
          anchor={anchor}
          onNext={() => setIntro(2)}
          onDone={() => setIntro(undefined)}
        />
      )}
    </>
  );
}
