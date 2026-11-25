import { useImageGalleryMotion } from "./use-image-gallery-motion";
import { MIN_ZOOM, useImageViewport } from "./use-image-viewport";
import { useMediaControls } from "./use-media-controls";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CopyIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import type { Attachment } from "../relay/contracts";
import {
  isNativeMediaSource,
  isProxySource,
  safeOpenUrl,
} from "./attachment-source";
import styles from "./Messages.module.css";
import { MediaDownloadAction } from "./MediaDownloadAction";
import { copyImageToClipboard, supportsImageCopy } from "./image-copy";
import { copyNativeImage } from "./native-image-copy";
import { MediaContextMenu } from "./MediaContextMenu";

const ZOOM_STEP = 0.25;
const ZOOM_PRESETS = [0.5, 1, 1.5, 2];

type Point = Readonly<{ x: number; y: number }>;
// Pointer travel beyond this is a pan, not a click.
const CLICK_SLOP = 4;
// Touch: a swipe this far changes image (sideways) or closes (down); two taps
// this close in time and place are a double tap.
const SWIPE = 60;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 30;

/** The fingers on the stage: one swipes or pans, two pinch. */
type TouchGesture = {
  fingers: Map<number, Point>;
  origin: Point;
  offset: Point;
  zoomed: boolean;
  pinch?: { zoom: number; distance: number };
  moved: boolean;
};
const spread = (fingers: Map<number, Point>) => {
  const [a, b] = [...fingers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};
const middle = (fingers: Map<number, Point>) => {
  const points = [...fingers.values()];
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
};

type ImageReviewStageProps = {
  attachments: readonly Attachment[];
  selectedUrl: string;
  media(url: string): string | undefined;
  select(url: string): void;
  onOpenLink(url: string): boolean;
  /** The selected image's source failed to load or decode. */
  onImageError?(source: string): void;
  allowCopy?: boolean;
};

export function ImageReviewStage({
  attachments,
  selectedUrl,
  media,
  select,
  onOpenLink,
  onImageError,
  allowCopy = true,
}: ImageReviewStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const press = useRef<
    | {
        pointer: number;
        origin: Point;
        offset: Point;
        panning: boolean;
        // Cleared by pointer travel, a second contact, pressing off the image, or a
        // source change during the press.
        click: boolean;
      }
    | undefined
  >(undefined);
  const zoomHint = useId();
  const [dragging, setDragging] = useState(false);
  const touch = useRef<TouchGesture | undefined>(undefined);
  const lastTap = useRef<{ at: number; x: number; y: number } | undefined>(
    undefined,
  );
  // How far a one-finger swipe carries the fitted image.
  const [swipe, setSwipe] = useState<Point>();
  const selectedIndex = Math.max(
    0,
    attachments.findIndex((item) => item.url === selectedUrl),
  );
  const selected = attachments[selectedIndex] ?? attachments[0];
  const source = selected ? media(selected.url) : undefined;
  // A press that outlives its image must not zoom any later one, even when
  // navigation returns to the same source.
  useLayoutEffect(() => {
    void source;
    if (press.current) press.current.click = false;
  }, [source]);
  const nativeSource = source ? isNativeMediaSource(source) : false;
  const proxySource = source ? isProxySource(source) || nativeSource : false;
  const [downloadFeedbackVisible, setDownloadFeedbackVisible] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyNotice, setCopyNotice] = useState<"success" | "error">();
  const copyBusy = useRef(false);
  const copyNoticeTimer = useRef<number | undefined>(undefined);
  const selectedUrlRef = useRef(selectedUrl);
  selectedUrlRef.current = selectedUrl;
  const externalSource = source ? safeOpenUrl(source) && !proxySource : false;
  const canCopyImage =
    allowCopy && proxySource && (nativeSource || supportsImageCopy());
  const {
    zoom,
    offset,
    maxZoom,
    zoomTo: setBoundedZoom,
    toggleZoomAt,
    panTo,
    constrain,
  } = useImageViewport(stage, image, source);
  const fromCenter = (point: Point) => {
    const bounds = stage.current?.getBoundingClientRect();
    return bounds
      ? {
          x: point.x - bounds.left - bounds.width / 2,
          y: point.y - bounds.top - bounds.height / 2,
        }
      : point;
  };
  const copyFeedbackVisible = copying || copyNotice !== undefined;
  const feedbackVisible = copyFeedbackVisible || downloadFeedbackVisible;
  const idle = useMediaControls(stage, source, feedbackVisible);
  const pannable = zoom > 1;
  const nextZoom = ZOOM_PRESETS.find((preset) => preset > zoom) ?? MIN_ZOOM;
  const { departing, prepare } = useImageGalleryMotion(
    stage,
    image,
    selected?.url,
    source,
  );

  const clearCopyNoticeTimer = useCallback(() => {
    if (copyNoticeTimer.current === undefined) return;
    window.clearTimeout(copyNoticeTimer.current);
    copyNoticeTimer.current = undefined;
  }, []);
  const clearCopyNotice = useCallback(() => {
    clearCopyNoticeTimer();
    setCopyNotice(undefined);
  }, [clearCopyNoticeTimer]);
  const showCopyNotice = useCallback(
    (notice: "success" | "error") => {
      clearCopyNoticeTimer();
      setCopyNotice(notice);
      copyNoticeTimer.current = window.setTimeout(
        () => {
          copyNoticeTimer.current = undefined;
          setCopyNotice(undefined);
        },
        notice === "success" ? 4000 : 6000,
      );
    },
    [clearCopyNoticeTimer],
  );
  const copyImage = useCallback(async () => {
    if (copyBusy.current || !image.current) return;
    const copiedUrl = selectedUrl;
    copyBusy.current = true;
    setCopying(true);
    clearCopyNotice();
    try {
      // The broker path must invoke clipboard.write synchronously in the gesture.
      // Native media instead stays in the authenticated host boundary.
      if (nativeSource && source) await copyNativeImage(source);
      else await copyImageToClipboard(image.current);
      if (selectedUrlRef.current === copiedUrl) showCopyNotice("success");
    } catch {
      if (selectedUrlRef.current === copiedUrl) showCopyNotice("error");
    } finally {
      copyBusy.current = false;
      setCopying(false);
    }
  }, [clearCopyNotice, nativeSource, source, selectedUrl, showCopyNotice]);

  const choose = useCallback(
    (index: number) => {
      const item = attachments[index];
      if (!item || item.url === selected?.url) return;
      prepare(index > selectedIndex ? 1 : -1);
      setBoundedZoom(1);
      clearCopyNotice();
      const active = document.activeElement;
      const keepsNavigationFocus =
        (active === previousButton.current && index > 0) ||
        (active === nextButton.current && index < attachments.length - 1);
      if (!keepsNavigationFocus) stage.current?.focus({ preventScroll: true });
      select(item.url);
    },
    [
      attachments,
      setBoundedZoom,
      select,
      selected?.url,
      selectedIndex,
      prepare,
      clearCopyNotice,
    ],
  );
  useEffect(() => {
    if (attachments.length < 2) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return;
      const viewer = stage.current?.closest('[role="dialog"]') ?? stage.current;
      const target = event.target;
      // A disabled end-arrow or a click on the picture can leave focus on body.
      const modalHasBodyFocus =
        target === document.body &&
        viewer?.getAttribute("aria-modal") === "true" &&
        !viewer.closest('[inert], [aria-hidden="true"]');
      if (
        !viewer ||
        !(target instanceof Element) ||
        (!viewer.contains(target) && !modalHasBodyFocus) ||
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="menu"], [role="listbox"]',
        ) ||
        (target.closest('[role="dialog"]') &&
          target.closest('[role="dialog"]') !== viewer)
      )
        return;
      event.preventDefault();
      choose(selectedIndex + (event.key === "ArrowRight" ? 1 : -1));
    };
    // A dialog may stop arrow keys inside it, as the composer-attached sheet's
    // popup does, so listen at the viewer too. Its handled keys are
    // prevented, so the document only acts when focus is on the body.
    const viewer = stage.current?.closest<HTMLElement>('[role="dialog"]');
    viewer?.addEventListener("keydown", keydown);
    document.addEventListener("keydown", keydown);
    return () => {
      viewer?.removeEventListener("keydown", keydown);
      document.removeEventListener("keydown", keydown);
    };
  }, [attachments.length, selectedIndex, choose]);

  useEffect(() => clearCopyNoticeTimer, [clearCopyNoticeTimer]);

  if (!selected)
    return (
      <p className={styles.mediaReviewUnavailable} role="status">
        Image unavailable
      </p>
    );
  return (
    <MediaContextMenu
      kind="image"
      url={selected.url}
      source={source}
      name={selected.name}
      allowCopy={allowCopy}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: This groups gallery media and navigation, not form fields. */}
      <div
        ref={stage}
        role="group"
        aria-label="Image gallery"
        tabIndex={-1}
        data-controls-idle={idle || undefined}
        data-controls-revealed={feedbackVisible || undefined}
        data-review-zoomed={zoom !== 1 || undefined}
        className={`${styles.imageReviewStage} ${pannable ? styles.imageReviewPannable : ""} ${dragging ? styles.imageReviewDragging : ""}`}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") {
            const point = { x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
            const active: TouchGesture = touch.current ?? {
              fingers: new Map(),
              origin: point,
              offset,
              zoomed: zoom > 1,
              moved: false,
            };
            active.fingers.set(event.pointerId, point);
            if (active.fingers.size === 2) {
              active.pinch = { zoom, distance: spread(active.fingers) };
              active.moved = true;
              setSwipe(undefined);
            }
            touch.current = active;
            return;
          }
          if (event.button !== 0) return;
          if (press.current) {
            // Multi-touch is not a click; the first contact keeps the pan.
            press.current.click = false;
            return;
          }
          press.current = {
            pointer: event.pointerId,
            origin: { x: event.clientX, y: event.clientY },
            offset,
            panning: pannable,
            click: event.isPrimary && event.target === image.current,
          };
          // Capture so the release always ends this press, even off the stage.
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(pannable);
        }}
        onPointerMove={(event) => {
          const gesture = touch.current;
          if (event.pointerType === "touch") {
            if (!gesture?.fingers.has(event.pointerId)) return;
            gesture.fingers.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            if (gesture.pinch) {
              if (gesture.fingers.size < 2) return;
              setBoundedZoom(
                (gesture.pinch.zoom * spread(gesture.fingers)) /
                  gesture.pinch.distance,
                fromCenter(middle(gesture.fingers)),
              );
              return;
            }
            const dx = event.clientX - gesture.origin.x;
            const dy = event.clientY - gesture.origin.y;
            if (Math.hypot(dx, dy) > CLICK_SLOP) gesture.moved = true;
            if (!gesture.moved) return;
            if (gesture.zoomed)
              panTo({ x: gesture.offset.x + dx, y: gesture.offset.y + dy });
            else
              setSwipe(
                Math.abs(dx) > Math.abs(dy)
                  ? { x: dx, y: 0 }
                  : { x: 0, y: Math.max(0, dy) },
              );
            return;
          }
          const active = press.current;
          if (!active || active.pointer !== event.pointerId) return;
          const dx = event.clientX - active.origin.x;
          const dy = event.clientY - active.origin.y;
          if (Math.hypot(dx, dy) > CLICK_SLOP) active.click = false;
          if (active.panning)
            panTo({ x: active.offset.x + dx, y: active.offset.y + dy });
        }}
        onPointerUp={(event) => {
          const gesture = touch.current;
          if (event.pointerType === "touch") {
            if (!gesture?.fingers.delete(event.pointerId)) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            if (gesture.fingers.size > 0) return;
            touch.current = undefined;
            setSwipe(undefined);
            if (gesture.pinch) {
              // Pinched below fit springs back to fit.
              if (zoom < 1) setBoundedZoom(1);
              return;
            }
            const dx = event.clientX - gesture.origin.x;
            const dy = event.clientY - gesture.origin.y;
            if (!gesture.moved) {
              const previous = lastTap.current;
              const now = performance.now();
              if (
                previous &&
                now - previous.at < DOUBLE_TAP_MS &&
                Math.hypot(
                  event.clientX - previous.x,
                  event.clientY - previous.y,
                ) < DOUBLE_TAP_SLOP
              ) {
                lastTap.current = undefined;
                toggleZoomAt(event.clientX, event.clientY);
              } else
                lastTap.current = {
                  at: now,
                  x: event.clientX,
                  y: event.clientY,
                };
              return;
            }
            if (gesture.zoomed) return;
            if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy))
              choose(selectedIndex + (dx < 0 ? 1 : -1));
            else if (dy > SWIPE * 1.5 && dy > Math.abs(dx))
              // A swipe down closes the viewer, as Escape does.
              document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
              );
            return;
          }
          const active = press.current;
          if (active?.pointer !== event.pointerId) return;
          press.current = undefined;
          setDragging(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (active.click) toggleZoomAt(event.clientX, event.clientY);
        }}
        onLostPointerCapture={(event) => {
          if (event.pointerType === "touch") return;
          if (press.current?.pointer !== event.pointerId) return;
          press.current = undefined;
          setDragging(false);
        }}
        onPointerCancel={(event) => {
          if (event.pointerType === "touch") {
            touch.current = undefined;
            setSwipe(undefined);
            return;
          }
          if (press.current?.pointer !== event.pointerId) return;
          press.current = undefined;
          setDragging(false);
        }}
      >
        {[
          ...(departing && departing.url !== selected.url ? [departing] : []),
          {
            url: selected.url,
            source,
            transform: swipe
              ? `translate(${swipe.x}px, ${swipe.y}px) scale(${1 - Math.min(swipe.y, 400) / 2000})`
              : zoom === 1
                ? "none"
                : `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          },
        ].map((item) => {
          const current = item.url === selected.url;
          return item.source ? (
            <img
              key={item.url}
              ref={current ? image : undefined}
              data-review-media={current ? "" : undefined}
              data-gallery-departing={!current ? "" : undefined}
              data-review-chrome={!current ? "" : undefined}
              src={item.source}
              alt={current ? "Attachment preview" : ""}
              aria-describedby={current ? zoomHint : undefined}
              aria-hidden={!current || undefined}
              draggable={false}
              onLoad={current ? constrain : undefined}
              onError={
                current
                  ? () => item.source && onImageError?.(item.source)
                  : undefined
              }
              style={{ transform: item.transform }}
            />
          ) : (
            <p
              key={item.url}
              className={styles.mediaReviewUnavailable}
              role="status"
            >
              Image unavailable
            </p>
          );
        })}
        <p id={zoomHint} className="sr-only">
          Click the image to zoom.
        </p>
        <div
          className={styles.imageReviewToolbar}
          data-image-controls=""
          data-review-chrome=""
          onPointerDown={(event) => event.stopPropagation()}
        >
          {attachments.length > 1 && (
            <div className={styles.imageReviewSwitcher}>
              <IconButton
                size="sm"
                type="button"
                ref={previousButton}
                aria-label="Previous image"
                disabled={selectedIndex === 0}
                onClick={() => choose(selectedIndex - 1)}
                icon={<CaretLeftIcon size={18} aria-hidden="true" />}
              />
              <span aria-live="polite" aria-atomic="true">
                {selectedIndex + 1} / {attachments.length}
              </span>
              <IconButton
                size="sm"
                type="button"
                ref={nextButton}
                aria-label="Next image"
                disabled={selectedIndex === attachments.length - 1}
                onClick={() => choose(selectedIndex + 1)}
                icon={<CaretRightIcon size={18} aria-hidden="true" />}
              />
            </div>
          )}
          <div className={styles.imageReviewZoom}>
            <IconButton
              size="sm"
              type="button"
              aria-label="Zoom out"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => setBoundedZoom(zoom - ZOOM_STEP)}
              icon={<MinusIcon size={16} aria-hidden="true" />}
            />
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={`Image zoom: ${Math.round(zoom * 100)}%. Zoom to ${nextZoom * 100}%`}
              onClick={() => setBoundedZoom(nextZoom)}
            >
              {Math.round(zoom * 100)}%
            </Button>
            <IconButton
              size="sm"
              type="button"
              aria-label="Zoom in"
              disabled={zoom >= maxZoom}
              onClick={() => setBoundedZoom(zoom + ZOOM_STEP)}
              icon={<PlusIcon size={16} aria-hidden="true" />}
            />
          </div>
          {canCopyImage && (
            <IconButton
              hint="familiar"
              size="sm"
              type="button"
              aria-label="Copy image"
              title="Copy image"
              disabled={!canCopyImage}
              loading={copying}
              onClick={() => void copyImage()}
              icon={<CopyIcon size={17} aria-hidden="true" />}
            />
          )}
          {copyNotice && (
            <span role={copyNotice === "error" ? "alert" : "status"}>
              {copyNotice === "success"
                ? "Image copied"
                : "Couldn't copy image"}
            </span>
          )}
          {nativeSource && source && (
            <MediaDownloadAction
              key={JSON.stringify([selected.url, source, selected.name])}
              kind="image"
              source={source}
              name={selected.name ?? ""}
              onFeedbackVisible={setDownloadFeedbackVisible}
            />
          )}
          {proxySource && !nativeSource && (
            <IconButton
              nativeButton={false}
              role="link"
              render={<a href={source} download />}
              size="sm"
              aria-label="Download image"
              title="Download image"
              icon={<DownloadIcon size={17} />}
            />
          )}
          {source && externalSource && (
            <IconButton
              nativeButton={false}
              role="link"
              render={
                <a
                  href={source}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey)
                      return;
                    if (onOpenLink(source)) event.preventDefault();
                  }}
                />
              }
              size="sm"
              aria-label="Open image in browser"
              title="Open image in browser"
              icon={<ArrowSquareOutIcon size={17} />}
            />
          )}
        </div>
      </div>
    </MediaContextMenu>
  );
}
