import {
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { useComposerScope } from "./composer-overlay";
import styles from "./Messages.module.css";
import { LayerAddressContext } from "./view-layer";

const HEADING = /^H[1-6]$/;

/** Whether the chat holds back any of the message: a later block, or a brief
 * longer than its lines. The brief follows a leading heading when an older
 * details message has one. */
function holdsBack(clip: HTMLElement) {
  const text = clip.firstElementChild;
  if (!text) return false;
  const blocks = [...text.children];
  const shown = blocks[0] && HEADING.test(blocks[0].tagName) ? 2 : 1;
  return (
    blocks.length > shown ||
    blocks
      .slice(0, shown)
      .some((block) => block.scrollHeight > block.clientHeight + 1)
  );
}

/** A details message reads in the chat as its opening brief, and opens whole.
 * In a thread or a view the address never names, such as media's comments, it
 * expands in place. In a conversation on a page that addresses its views'
 * layers, the view's `LayerReader` draws it from its id, over the view's
 * composer; elsewhere this row opens it in a dialog. */
export function DetailsMessage({
  messageId,
  channelId,
  author,
  createdAt,
  preview,
  keepMounted,
  onExpand,
  children,
}: {
  messageId: string;
  channelId: string;
  author: string;
  createdAt: number;
  /** The whole message as the chat renders it; only its brief shows. */
  preview: ReactNode;
  /** Pins the row in a virtualized list while it draws the reader. */
  keepMounted?: ((messageId: string) => () => void) | undefined;
  /** Expanding or folding in place, which is reading intent. */
  onExpand?: (() => void) | undefined;
  /** The reader's body. */
  children: ReactNode;
}) {
  const view = useComposerScope();
  const address = useContext(LayerAddressContext);
  const [local, setLocal] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const inPlace = !!view && (!!view.local || view.rootId !== undefined);
  const addressed = !!address && !!view && !inPlace;
  const show = () =>
    inPlace
      ? toggle(true)
      : addressed
        ? address.show({ messageId, channelId, rootId: view.rootId })
        : setLocal(true);
  const close = () => setLocal(false);
  const toggle = (next: boolean) => {
    onExpand?.();
    setExpanded(next);
  };
  useEffect(
    () => (local ? keepMounted?.(messageId) : undefined),
    [local, keepMounted, messageId],
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  // Expanded, nothing is held back; the toggle stays for Show less.
  useLayoutEffect(() => {
    const element = clip.current;
    if (!element || expanded) return;
    const measure = () => setClipped(holdsBack(element));
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [expanded]);
  const time = formatItemTimestamp(createdAt, { withTime: true });
  const reader = <div className={styles.detailsReader}>{children}</div>;
  return (
    <div className={styles.detailsPreview} data-clipped={clipped || undefined}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Show more is the keyboard path; this only widens the pointer target. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Show more is the keyboard path; this only widens the pointer target. */}
      <div
        ref={clip}
        className={expanded ? styles.detailsBody : styles.detailsClip}
        onClick={(event) => {
          // Links, mentions and selected text keep their own meaning.
          if (
            !clipped ||
            expanded ||
            (event.target instanceof Element &&
              event.target.closest("a, button, [role=button]")) ||
            !getSelection()?.isCollapsed
          )
            return;
          show();
        }}
      >
        {preview}
      </div>
      {clipped && (
        <span className={styles.detailsMore}>
          <Button
            ref={trigger}
            variant="link"
            size="inline"
            {...(inPlace
              ? { "aria-expanded": expanded }
              : { "aria-haspopup": "dialog" as const })}
            onClick={expanded ? () => toggle(false) : show}
          >
            {expanded ? "Show less" : "Show more"}
          </Button>
        </span>
      )}
      {local && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
          title={author}
          description={time}
          bodyLayout="flex"
          finalFocus={trigger}
        >
          <section
            className={styles.detailsDialogScroll}
            aria-label="Message"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll owner must support keyboard scrolling.
            tabIndex={0}
          >
            {reader}
          </section>
        </Dialog>
      )}
    </div>
  );
}
