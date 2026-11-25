import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { WorkspaceAsideWidth } from "../../features/conversation/contracts";
import {
  ReadingCovers,
  readingPositioned,
} from "../../features/messages/use-reading";
import styles from "./Channels.module.css";

const DEFAULT_WIDTH = 320;
/** The narrowest reader a docked aside leaves beside it. */
const MIN_READER = 600;

/**
 * Where an aside goes in a row this wide, and how wide it is. The only place
 * that decides the aside's placement, from the host's own row width; a later
 * width form adds its rule here.
 */
export function asideLayout(
  rowWidth: number,
  width: WorkspaceAsideWidth = DEFAULT_WIDTH,
) {
  const docked = rowWidth - width >= MIN_READER;
  return { docked, width: docked ? width : Math.min(width, rowWidth) };
}

type Props = {
  aside: ReactNode;
  width: WorkspaceAsideWidth | undefined;
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  onFloatingChange: ((floating: boolean) => void) | undefined;
  children: ReactNode;
};

/**
 * A workspace's reader and its page's aside, placed over the history's end
 * edge. Docked, the history, composer, queue and typing label keep to the
 * reader's width beside it, so the history's scrollbar stays at the reader's
 * end. When the reader would get too narrow, it floats over the history
 * instead, while open, and rows under it aren't read.
 */
export function WorkspaceRow({
  aside,
  width,
  open: controlled,
  onOpenChange,
  onFloatingChange,
  children,
}: Props) {
  const row = useRef<HTMLDivElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState<number>();
  const [inner, setInner] = useState(true);
  const open = controlled ?? inner;
  const change = useEffectEvent((next: boolean) => {
    setInner(next);
    onOpenChange?.(next);
  });
  const layout =
    rowWidth === undefined ? undefined : asideLayout(rowWidth, width);
  const docked = layout?.docked ?? true;
  const shown = aside != null && open;
  const floating = shown && !docked;
  const asideWidth = layout?.width ?? width ?? DEFAULT_WIDTH;

  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => setRowWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Narrowing to a floating aside closes it; widening again restores the
  // docked state. An aside that first measures narrow, or arrives in a narrow
  // row, narrows from docked.
  const placedDocked = aside == null || docked;
  const dockedOpen = useRef(open);
  const transition = useEffectEvent((docked: boolean) => {
    if (!docked) {
      dockedOpen.current = open;
      if (open) change(false);
    } else if (open !== dockedOpen.current) change(dockedOpen.current);
  });
  const wasDocked = useRef(true);
  useLayoutEffect(() => {
    if (wasDocked.current === placedDocked) return;
    wasDocked.current = placedDocked;
    transition(placedDocked);
  }, [placedDocked]);

  // Only a page opening the floating aside moves focus into it, not a row
  // narrowing under an open aside it is about to close.
  const wasOpen = useRef(open);
  const opened = useRef(false);
  useLayoutEffect(() => {
    opened.current = open && !wasOpen.current;
    wasOpen.current = open;
  });

  const measured = layout !== undefined;
  const reportFloating = useEffectEvent((floating: boolean) =>
    onFloatingChange?.(floating),
  );
  useLayoutEffect(() => {
    if (measured) reportFloating(!docked);
  }, [measured, docked]);

  // The box starts at the history's top, beside its scrollbar; floating, it
  // stops at the history's bottom, above the composer. It wakes reading whenever it shows, moves, floats, docks or hides. A reader
  // can show its history later, as a thread does once loaded, or replace it.
  const [geometry, setGeometry] = useState<CSSProperties>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: docking or floating changes what covers the rows, so reading wakes.
  useLayoutEffect(() => {
    const container = row.current;
    const frame = reader.current;
    if (!shown || !container || !frame) return;
    let scroller: HTMLElement | null = null;
    const measure = () => {
      if (!scroller?.isConnected) return find();
      const outer = container.getBoundingClientRect();
      const history = scroller.getBoundingClientRect();
      setGeometry({
        "--aside-top": `${history.top - outer.top}px`,
        "--aside-height": `${history.height}px`,
        "--aside-scrollbar": `${scroller.offsetWidth - scroller.clientWidth}px`,
      } as CSSProperties);
      readingPositioned(scroller);
    };
    // A removed history reports one last resize, so only a reader without
    // one is watched for it to appear.
    const resize = new ResizeObserver(measure);
    const appear = new MutationObserver(() => find());
    const find = () => {
      resize.disconnect();
      appear.disconnect();
      scroller = frame.querySelector<HTMLElement>("[data-message-scroller]");
      if (!scroller) {
        appear.observe(frame, { childList: true, subtree: true });
        return;
      }
      resize.observe(container);
      resize.observe(scroller);
      measure();
    };
    find();
    return () => {
      resize.disconnect();
      appear.disconnect();
      if (scroller) readingPositioned(scroller);
    };
  }, [shown, floating]);

  // A nested surface: Escape and a press elsewhere in the row close only it.
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = box.current;
    const container = row.current;
    if (!floating || !element || !container) return;
    previous.current = null;
    if (opened.current) {
      previous.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      element.focus({ preventScroll: true });
    }
    const pointerdown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (container.contains(target) && !element.contains(target))
        change(false);
    };
    document.addEventListener("pointerdown", pointerdown, true);
    return () => document.removeEventListener("pointerdown", pointerdown, true);
  }, [floating]);
  // After the aside's own controls, which may take Escape first; a portaled
  // popover's Escape is its own.
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      !event.currentTarget.contains(event.target as Node)
    )
      return;
    event.preventDefault();
    event.nativeEvent.stopPropagation();
    setInner(false);
    onOpenChange?.(false);
    previous.current?.focus({ preventScroll: true });
  };

  // Stable, so opening the overlay doesn't rerender the readers.
  const covers = useCallback(() => {
    const element = box.current;
    return element?.dataset.workspaceAside === "floating" && !element.hidden
      ? [element.getBoundingClientRect()]
      : [];
  }, []);

  return (
    <div ref={row} className={styles.workspaceRow}>
      <div
        ref={reader}
        className={styles.workspaceReader}
        data-aside-docked={shown && docked ? "" : undefined}
        style={
          shown && docked
            ? ({
                "--timeline-aside-width": `${asideWidth}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <ReadingCovers value={covers}>{children}</ReadingCovers>
      </div>
      {aside != null && (
        // biome-ignore lint/a11y/noStaticElementInteractions: hears Escape from the aside's controls; the box takes no input of its own.
        <div
          ref={box}
          className={styles.workspaceAside}
          data-workspace-aside={docked ? "docked" : "floating"}
          hidden={!open}
          tabIndex={docked ? undefined : -1}
          onKeyDown={floating ? keydown : undefined}
          style={{ ...geometry, inlineSize: asideWidth }}
        >
          {aside}
        </div>
      )}
    </div>
  );
}
