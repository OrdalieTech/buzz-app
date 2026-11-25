import { useEffect, useRef, type RefObject } from "react";
import type { PageNavigation } from "../../features/navigation/service";

/** A read-only conversation has no composer to take its opening's focus. */
export function useChannelHistoryFocus(
  container: RefObject<HTMLElement | null>,
  navigation: PageNavigation | undefined,
  enabled: boolean,
  ready: boolean,
) {
  const pending = useRef<Element | null>(null);
  const { target, signal, focus } = navigation ?? {};
  const plain =
    focus !== "preserve" &&
    target?.kind === "conversation" &&
    !target.messageId &&
    !target.threadRootId &&
    !target.panel &&
    !target.detail &&
    !target.layer;
  useEffect(() => {
    pending.current = null;
    if (!plain || !signal || signal.aborted) return;
    pending.current = document.activeElement;
    // Loading must not pull focus back after the reader chooses another control.
    const moved = (event: FocusEvent) => {
      // Search can close before rows arrive and hand focus to the history shell.
      pending.current =
        pending.current && event.target === container.current
          ? container.current
          : null;
    };
    document.addEventListener("focusin", moved);
    return () => document.removeEventListener("focusin", moved);
  }, [container, signal, plain]);
  useEffect(() => {
    if (!plain || !enabled || !ready || signal?.aborted) return;
    const previous = pending.current;
    if (!previous || previous !== document.activeElement) return;
    const history = container.current?.querySelector<HTMLElement>(
      "[data-message-scroller]",
    );
    if (
      !history ||
      history.closest('[hidden], [inert], [aria-hidden="true"]') ||
      previous.closest('dialog[open], [aria-modal="true"], [role="menu"]')
    )
      return;
    pending.current = null;
    history.focus({ preventScroll: true });
  }, [container, signal, plain, enabled, ready]);
}
