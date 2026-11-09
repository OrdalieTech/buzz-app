import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";
import {
  useCallback,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { behindActiveOverlay, observeOverlays } from "../overlayLayer";
import { hoverOpenTiming } from "./hoverIntent";

export type PreviewCardProps = {
  /** The one interactive element that anchors and reveals this preview. */
  trigger: ReactElement;
  /** Context that supplements, but never replaces, the trigger's destination. */
  children: ReactNode;
  open?: boolean;
  onOpenChange?: BasePreviewCard.Root.Props["onOpenChange"];
  side?: BasePreviewCard.Positioner.Props["side"];
  /** Distance from the anchor; defaults to 8px. */
  sideOffset?: BasePreviewCard.Positioner.Props["sideOffset"];
  /** Alignment along the anchor's edge; defaults to its start. */
  align?: BasePreviewCard.Positioner.Props["align"];
  /** Optional content anchor when the trigger owns a wider hit area. */
  anchor?: BasePreviewCard.Positioner.Props["anchor"];
  /** A preview in the same group is already open: move to this one at once. */
  warm?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  /** Optional anchor that makes the whole card open the trigger's destination. */
  link?: ReactElement;
  /** First supplemental control or scrollport, reachable with Tab. Not used with link. */
  actionRef?: RefObject<HTMLElement | null>;
  /** Keep within the viewport when space is tight; defaults to interactive previews. */
  sticky?: boolean;
};

const focusableActions =
  "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

/** Whether a point lies on one of the element's line boxes, 1px inside. */
function isOver(element: Element, x: number, y: number) {
  for (const box of element.getClientRects()) {
    if (
      x >= box.left + 1 &&
      x <= box.right - 1 &&
      y >= box.top + 1 &&
      y <= box.bottom - 1
    )
      return true;
  }
  return false;
}

/**
 * A non-modal, portal-rendered preview of a resolved object.
 *
 * Base UI owns the hover/focus timing, anchored positioning, viewport collision,
 * and portal lifecycle. The preview stays supplemental: it does not take focus
 * automatically. A destination card can be reached with Tab.
 */
export function PreviewCard({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  sideOffset = 8,
  align = "start",
  anchor,
  warm = false,
  className,
  id,
  link,
  actionRef,
  sticky = !!actionRef,
  "aria-label": label,
}: PreviewCardProps) {
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const [boundary, setBoundary] = useState<HTMLElement>();
  const rememberTrigger = useCallback((element: HTMLAnchorElement | null) => {
    triggerRef.current = element;
    setBoundary(
      element?.closest<HTMLElement>("[data-overlay-boundary]") ?? undefined,
    );
  }, []);
  const actions = useRef<BasePreviewCard.Root.Actions>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // Where the trigger was when opening began, or at the last scroll since.
  const triggerPlace = useRef<DOMRect | null>(null);
  // The latest pointer position while the preview is mounted.
  const pointer = useRef<{ x: number; y: number; time: number } | null>(null);
  // A hover close was refused because the pointer never left the trigger.
  const heldLeave = useRef(false);
  // The card reopened during its exit, keeping its place in the top layer.
  const rejoin = useRef(false);
  const promote = useCallback((positioner: HTMLDivElement) => {
    // Join the top layer after the hovered row's floating actions, but not
    // above an unrelated interactive overlay. The portal is never inside one.
    // Base UI still owns placement, timing, focus and unmounting.
    const update = () => {
      const trigger = triggerRef.current;
      if (trigger && behindActiveOverlay(trigger)) positioner.hidePopover?.();
      else if (rejoin.current && popupRef.current?.hasAttribute("data-open")) {
        // The reopening has committed, with any row actions that the same
        // pointer move showed again. Join again, after them. A manual
        // popover keeps focus through this.
        rejoin.current = false;
        positioner.hidePopover?.();
        positioner.showPopover?.();
      } else positioner.showPopover?.();
    };
    update();
    const stopObserving = observeOverlays(update);
    // Hover cannot see its trigger scroll away from a still pointer: the
    // preview would stay open, follow the trigger out of its scroller and
    // take the wheel. Keyboard focus keeps its preview, because focusing a
    // clipped trigger scrolls it into view. A scroll that leaves the trigger
    // in place, such as scroll anchoring while rows above it are re-measured,
    // moves nothing relative to the pointer and keeps the preview.
    const closeOnScroll = ({ target }: Event) => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !(target instanceof Node) || !target.contains(trigger))
        return;
      // Only an opening or open preview reads layout here: a timeline holds
      // many triggers, and every one of them hears each scroll.
      const before = triggerPlace.current;
      const place = before && trigger.getBoundingClientRect();
      triggerPlace.current = place;
      const keyboard = ":focus-visible, :has(:focus-visible)";
      if (
        popup?.hasAttribute("data-open") &&
        !trigger.matches(keyboard) &&
        !popup.matches(keyboard) &&
        (!before ||
          !place ||
          Math.abs(place.x - before.x) >= 1 ||
          Math.abs(place.y - before.y) >= 1)
      )
        actions.current?.close();
    };
    // While hit-testing is suppressed, the trigger cannot hear the pointer
    // leave. Close a held preview once the pointer is off both surfaces.
    const trackPointer = (event: PointerEvent) => {
      pointer.current = {
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
      };
      const trigger = triggerRef.current;
      if (
        heldLeave.current &&
        trigger &&
        !isOver(trigger, event.clientX, event.clientY) &&
        !(event.target instanceof Node && positioner.contains(event.target))
      ) {
        heldLeave.current = false;
        actions.current?.close();
      }
    };
    document.addEventListener("scroll", closeOnScroll, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointermove", trackPointer, {
      capture: true,
      passive: true,
    });
    return () => {
      stopObserving();
      heldLeave.current = false;
      pointer.current = null;
      document.removeEventListener("scroll", closeOnScroll, true);
      document.removeEventListener("pointermove", trackPointer, true);
    };
  }, []);
  const focusedTrigger = useRef<HTMLElement | null>(null);
  const closingPopup = useRef<HTMLDivElement | null>(null);
  const restoreFocus = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    // Pointer entry may never focus a child of a non-focusable trigger wrapper.
    const candidates = [
      focusedTrigger.current,
      trigger,
      ...trigger.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, [tabindex]",
      ),
    ];
    for (const candidate of candidates) {
      if (!candidate || !trigger.contains(candidate)) continue;
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
  };
  return (
    <BasePreviewCard.Root
      open={open}
      actionsRef={actions}
      onOpenChange={(next, details) => {
        // Scrolling can briefly stop the trigger from hit-testing under a
        // still pointer: the virtualized timeline sets pointer-events: none
        // while it scrolls. WebKit then reports a mouseleave that the
        // pointer never made. Keep the preview while the pointer is still
        // on the trigger, as Base UI once did for Safari (mui/base-ui#869).
        const event = details.event;
        const trigger = triggerRef.current;
        const last = pointer.current;
        const point =
          last && event && last.time >= event.timeStamp
            ? last
            : event instanceof MouseEvent
              ? { x: event.clientX, y: event.clientY }
              : null;
        heldLeave.current =
          !next &&
          details.reason === "trigger-hover" &&
          event?.type === "mouseleave" &&
          !!trigger &&
          !!point &&
          isOver(trigger, point.x, point.y);
        if (heldLeave.current) {
          details.cancel();
          return;
        }
        onOpenChange?.(next, details);
        if (details.isCanceled) return;
        triggerPlace.current = next
          ? (triggerRef.current?.getBoundingClientRect() ?? null)
          : null;
        closingPopup.current =
          !next &&
          details.reason === "escape-key" &&
          popupRef.current?.contains(document.activeElement)
            ? popupRef.current
            : null;
        rejoin.current =
          next && !!popupRef.current?.hasAttribute("data-closed");
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        // Retain the closing element through unmount, as finalFocus.ts does.
        // Escape grants return-focus ownership only until the user moves it.
        const popup = closingPopup.current;
        closingPopup.current = null;
        const active = popup?.ownerDocument.activeElement ?? null;
        if (
          popup &&
          (active === popup.ownerDocument.body || popup.contains(active))
        )
          restoreFocus();
      }}
    >
      <BasePreviewCard.Trigger
        render={trigger}
        {...hoverOpenTiming.preview}
        {...(warm && { delay: 0 })}
        ref={rememberTrigger}
        // Base UI marks every open popup's trigger data-popup-open; this tells
        // a preview's trigger apart.
        data-preview-card-trigger=""
        onMouseEnter={() => {
          heldLeave.current = false;
        }}
        onFocus={(event) => {
          focusedTrigger.current = event.target as HTMLElement;
        }}
        onKeyDown={(event) => {
          if (
            (link || actionRef) &&
            event.key === "Tab" &&
            !event.shiftKey &&
            popupRef.current?.hasAttribute("data-open") &&
            !popupRef.current.closest("[data-anchor-hidden]")
          ) {
            event.preventDefault();
            (actionRef
              ? (popupRef.current.querySelector<HTMLElement>(
                  focusableActions,
                ) ?? actionRef.current)
              : popupRef.current
            )?.focus();
          }
        }}
      />
      <BasePreviewCard.Portal>
        <BasePreviewCard.Positioner
          collisionBoundary={boundary}
          side={side}
          // Keep supplemental controls reachable when no side has enough room.
          sticky={sticky}
          anchor={anchor}
          align={align}
          sideOffset={sideOffset}
          positionMethod="fixed"
          popover="manual"
          ref={promote}
          className="buzz-preview-card-positioner"
        >
          <BasePreviewCard.Popup
            id={id}
            data-buzz-ui=""
            ref={popupRef}
            onKeyDown={(event) => {
              if ((link || actionRef) && event.key === "Tab") {
                if (actionRef) {
                  const buttons = Array.from(
                    event.currentTarget.querySelectorAll<HTMLElement>(
                      focusableActions,
                    ),
                  );
                  const boundary = event.shiftKey ? buttons[0] : buttons.at(-1);
                  if (document.activeElement !== boundary) return;
                }
                // The portal is at the end of the document. Resume from its
                // trigger so Tab order follows the link's position in prose.
                restoreFocus();
                if (event.shiftKey) event.preventDefault();
              }
            }}
            className={["buzz-preview-card", className]
              .filter(Boolean)
              .join(" ")}
            render={link}
            role={link ? "link" : actionRef ? "dialog" : "tooltip"}
            aria-modal={actionRef ? false : undefined}
            data-interactive={actionRef ? "" : undefined}
            tabIndex={link ? 0 : undefined}
            data-destination={link ? "" : undefined}
            aria-label={label}
          >
            {children}
          </BasePreviewCard.Popup>
        </BasePreviewCard.Positioner>
      </BasePreviewCard.Portal>
    </BasePreviewCard.Root>
  );
}
