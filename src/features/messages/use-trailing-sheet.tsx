import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { ConversationWorkspaceProps } from "../conversation/contracts";
import styles from "./Messages.module.css";

/** History left above a trailing card that its toggle grows it to. */
const TRAILING_TOP_GAP = 60;
/** Where a trailing sheet's toggle grows its card to. */
function sheetFull(sheet: HTMLElement) {
  const spacer = sheet.firstElementChild?.getBoundingClientRect().height ?? 0;
  return Math.min(
    Math.max(0, spacer - TRAILING_TOP_GAP),
    sheet.scrollHeight - sheet.clientHeight,
  );
}
/** How far a trailing sheet has grown its card past the rest height. */
function sheetGrowth(sheet: HTMLElement | null) {
  const spacer = sheet?.firstElementChild;
  return sheet && spacer
    ? Math.min(sheet.scrollTop, spacer.getBoundingClientRect().height)
    : 0;
}

/**
 * A workspace's trailing card over the end of a history scroller. The card
 * scrolls in its own sheet: at scrollTop 0 it shows its rest height, and
 * scrolling the sheet grows the card, then slides it up, without moving the
 * history. The history renders `restSpace` at the end of its scroll content
 * and `sheet` after itself, so keyboard order follows the card's place.
 */
export function useTrailingSheet(
  trailing: ConversationWorkspaceProps["trailing"],
  scroller: RefObject<HTMLElement | null>,
  /** The card's scroll uncovers rows; reading measures them again. */
  onReveal: () => void,
) {
  // Space for the card's rest height below the latest message.
  const restBox = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  // Where the toggle's smooth scroll is going, until it arrives or the reader
  // takes over.
  const sheetTarget = useRef<number>(undefined);
  const sheetPointer = useRef("");
  const [expanded, setExpanded] = useState(false);
  const hasTrailing = !!trailing;
  const restHeight = trailing?.restHeight;
  // Jump to latest stays above the card's visible top.
  const placeJumpToLatest = useCallback(() => {
    if (restHeight !== undefined)
      scroller.current?.style.setProperty(
        "--timeline-trailing-rest",
        `${restHeight + sheetGrowth(sheet.current)}px`,
      );
  }, [restHeight, scroller]);
  // A new rest height moves the card's top over other rows; reading measures
  // again, as neither layer scrolls.
  const reveal = useRef(onReveal);
  useLayoutEffect(() => {
    reveal.current = onReveal;
  }, [onReveal]);
  const shownRest = useRef(restHeight);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (shownRest.current !== restHeight) {
      shownRest.current = restHeight;
      reveal.current();
    }
    if (restHeight === undefined || !element) return;
    placeJumpToLatest();
    return () => {
      element.style.removeProperty("--timeline-trailing-rest");
    };
  }, [restHeight, placeJumpToLatest, scroller]);
  // The sheet covers the history's scrollport, with its inline padding, so
  // the card lines up with the history's rows.
  useLayoutEffect(() => {
    const element = scroller.current;
    const panel = sheet.current;
    const frame = element?.offsetParent;
    if (!hasTrailing || !element || !panel || !(frame instanceof HTMLElement))
      return;
    if (typeof ResizeObserver === "undefined") return;
    const place = () => {
      const style = getComputedStyle(element);
      const top = element.offsetTop;
      panel.style.top = `${top}px`;
      panel.style.left = `${element.offsetLeft}px`;
      panel.style.right = `${frame.clientWidth - element.offsetLeft - element.offsetWidth}px`;
      panel.style.bottom = `${frame.clientHeight - top - element.offsetHeight}px`;
      panel.style.paddingInline = `${style.paddingInlineStart} ${style.paddingInlineEnd}`;
      // The layout can still settle while a toggle grows the card.
      const target = sheetTarget.current;
      if (!target) return;
      const full = sheetFull(panel);
      if (Math.abs(full - target) < 1) return;
      sheetTarget.current = full;
      panel.scrollTo({ top: full, behavior: "smooth" });
    };
    const resize = new ResizeObserver(place);
    resize.observe(element);
    resize.observe(frame);
    if (panel.lastElementChild) resize.observe(panel.lastElementChild);
    place();
    return () => {
      resize.disconnect();
      sheetTarget.current = undefined;
      setExpanded(false);
    };
  }, [hasTrailing, scroller]);
  const toggle = useCallback(() => {
    const element = sheet.current;
    if (!element) return;
    const expand = (sheetTarget.current ?? element.scrollTop) < 1;
    const top = expand ? sheetFull(element) : 0;
    // Already there and still, as a card too short to grow is: no scroll will
    // settle it. A toggle in flight scrolls back, which stops it.
    if (
      sheetTarget.current === undefined &&
      Math.abs(top - element.scrollTop) < 1
    ) {
      setExpanded(top >= 1);
      return;
    }
    setExpanded(expand);
    const reduced = element.ownerDocument.defaultView?.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    sheetTarget.current = reduced ? undefined : top;
    element.scrollTo({ top, behavior: reduced ? "instant" : "smooth" });
  }, []);
  // Jump to latest and a send return the card to its rest height.
  const rest = useCallback(() => {
    sheetTarget.current = undefined;
    if (sheet.current) sheet.current.scrollTop = 0;
    setExpanded(false);
  }, []);
  // The scroll padding keeps keyboard focus in the history above the card's
  // visible top. When the history can't scroll it clear of a grown card, the
  // card returns to Rest. This runs after the focus's own scroll into view; a
  // click never needs it, since the card takes the pointer.
  const revealFocus = useCallback(
    (focused: EventTarget) => {
      if (
        !sheet.current?.scrollTop ||
        focused === scroller.current ||
        !(focused instanceof HTMLElement) ||
        !focused.matches(":focus-visible")
      )
        return;
      queueMicrotask(() => {
        const cardTop =
          sheet.current?.firstElementChild?.getBoundingClientRect().bottom;
        if (
          cardTop === undefined ||
          focused.getBoundingClientRect().bottom <= cardTop + 1
        )
          return;
        rest();
        placeJumpToLatest();
        focused.scrollIntoView({ block: "nearest" });
      });
    },
    [scroller, rest, placeJumpToLatest],
  );
  /** Where rows stop showing above the card, if there is one. */
  const coveredFrom = useCallback(
    () => sheet.current?.lastElementChild?.getBoundingClientRect().top,
    [],
  );
  /** The rest space below the latest message, for an end-aligned scroll. */
  const restSpaceHeight = useCallback(
    () => restBox.current?.getBoundingClientRect().height ?? 0,
    [],
  );
  const state = useMemo(() => ({ expanded, toggle }), [expanded, toggle]);
  const restSpace = trailing && (
    <div
      ref={restBox}
      aria-hidden="true"
      style={{ height: trailing.restHeight }}
    />
  );
  const sheetElement = trailing && (
    <div
      ref={sheet}
      className={styles.trailingSheet}
      style={{ "--trailing-rest": `${trailing.restHeight}px` } as CSSProperties}
      // The pointer over the card holds the sheet: it then takes input across
      // its empty top too, so a gesture keeps scrolling it as the card slides
      // out from under the pointer, and WebKit's scrolling finds it. Moving
      // the pointer over the empty top lets go; the card sliding under a still
      // pointer leaves its position unchanged.
      onPointerOver={(event) => {
        if (event.target !== event.currentTarget.firstElementChild)
          event.currentTarget.toggleAttribute("data-held", true);
      }}
      onWheel={() => (sheetTarget.current = undefined)}
      onPointerMove={(event) => {
        // WebKit reports no movementX/Y here, so compare positions.
        const at = `${event.clientX},${event.clientY}`;
        const moved = at !== sheetPointer.current;
        sheetPointer.current = at;
        if (moved && event.target === event.currentTarget.firstElementChild)
          event.currentTarget.toggleAttribute("data-held", false);
      }}
      onPointerLeave={(event) =>
        event.currentTarget.toggleAttribute("data-held", false)
      }
      onTouchStart={() => (sheetTarget.current = undefined)}
      onScroll={(event) => {
        placeJumpToLatest();
        onReveal();
        const top = event.currentTarget.scrollTop;
        const target = sheetTarget.current;
        if (target !== undefined) {
          if (Math.abs(top - target) >= 1) return;
          sheetTarget.current = undefined;
        }
        setExpanded(top >= 1);
      }}
    >
      <div className={styles.trailingSpacer} />
      <div className={styles.trailingCard}>{trailing.content(state)}</div>
    </div>
  );
  return {
    /** Render at the end of the history's scroll content. */
    restSpace,
    /** Observe to follow a change in the rest height. */
    restBox,
    /** Render after the history. */
    sheet: sheetElement,
    rest,
    revealFocus,
    coveredFrom,
    restSpaceHeight,
  };
}
