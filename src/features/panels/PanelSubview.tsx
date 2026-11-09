import { PanelLocalTab, usePanelTabHost } from "./PanelWorkspace";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ArrowLeftIcon, XIcon } from "../../shared/design-system/icons";
import styles from "./Panels.module.css";

const Host = createContext<{
  element: HTMLDivElement | null;
  cover(covered: boolean): void;
  close(): void;
} | null>(null);

/** Local details keep their feature's authorization/lifetime, but share panel chrome.
 * The covered card keeps its dimensions, scroll position, and mounted controls. */
export function PanelSubviewHost({
  children,
  close,
}: {
  children: ReactNode;
  close(): void;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [covered, setCovered] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const wasCovered = useRef(false);
  const cover = useCallback((next: boolean) => {
    if (next && !trigger.current)
      trigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    setCovered(next);
  }, []);
  useLayoutEffect(() => {
    if (!covered && wasCovered.current) {
      if (trigger.current?.isConnected)
        trigger.current.focus({ preventScroll: true });
      trigger.current = null;
    }
    wasCovered.current = covered;
  }, [covered]);
  return (
    <Host.Provider value={{ element, cover, close }}>
      <div ref={setElement} className={styles.subviewStage}>
        <div
          className={styles.subviewBase}
          data-covered={covered || undefined}
          inert={covered}
          aria-hidden={covered || undefined}
        >
          {children}
        </div>
      </div>
    </Host.Provider>
  );
}

export function PanelSubview(props: {
  title: string;
  backLabel: string;
  /** `keepOwner`: a tabbed host is clearing the owner's detail tabs. */
  onBack(options?: { keepOwner?: boolean }): void;
  children: ReactNode;
}) {
  const tabbed = !!usePanelTabHost();
  return tabbed ? (
    <PanelLocalTab title={props.title} close={props.onBack}>
      {props.children}
    </PanelLocalTab>
  ) : (
    <InlinePanelSubview {...props} />
  );
}

function InlinePanelSubview({
  title,
  backLabel,
  onBack,
  children,
}: {
  title: string;
  backLabel: string;
  onBack(): void;
  children: ReactNode;
}) {
  const host = useContext(Host);
  const cover = host?.cover;
  const element = host?.element;
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (element === null) return;
    cover?.(true);
    back.current?.focus({ preventScroll: true });
    return () => cover?.(false);
  }, [cover, element]);
  const content = (
    <section
      className={host ? styles.subview : styles.inlineSubview}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.shiftKey) {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <PanelHeader
        title={title}
        navigation={
          <IconButton
            ref={back}
            size="toolbar"
            aria-label={backLabel}
            onClick={onBack}
            icon={<ArrowLeftIcon size={18} aria-hidden="true" />}
          />
        }
        actions={
          host && (
            <IconButton
              size="toolbar"
              aria-label={`Close ${title.toLowerCase()} panel`}
              onClick={host.close}
              icon={<XIcon size={18} aria-hidden="true" />}
            />
          )
        }
      />
      <div className={styles.content}>{children}</div>
    </section>
  );
  return host
    ? host.element
      ? createPortal(content, host.element)
      : null
    : content;
}
