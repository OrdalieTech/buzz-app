import { useLayoutEffect, type RefObject } from "react";

/** Preserve keyboard position when an activity owner retires or is replaced. */
export function useActivityFocusHandoff(owner: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const node = owner.current;
    return () => {
      const scope = node?.closest<HTMLElement>("[data-message-scroller]");
      const focused = node?.ownerDocument.activeElement;
      if (!node || !scope || !focused || !node.contains(focused)) return;
      const top = node.getBoundingClientRect().top;
      queueMicrotask(() => {
        if (
          !scope.isConnected ||
          scope.ownerDocument.activeElement !== scope.ownerDocument.body
        )
          return;
        const buttons = [
          ...scope.querySelectorAll<HTMLButtonElement>(
            "[data-message-id] button:not([disabled])",
          ),
        ];
        const target = buttons
          .filter(
            (button) =>
              button.getClientRects().length &&
              !button.closest("[inert], [aria-hidden='true']"),
          )
          .sort(
            (a, b) =>
              Math.abs(a.getBoundingClientRect().top - top) -
              Math.abs(b.getBoundingClientRect().top - top),
          )[0];
        (target ?? scope).focus({ preventScroll: true });
      });
    };
  }, [owner]);
}
