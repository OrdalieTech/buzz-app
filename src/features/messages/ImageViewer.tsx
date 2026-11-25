import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MediaReviewFrame } from "./MediaReviewFrame";
import { ImageReviewStage } from "./ImageReviewStage";
import { safeMessageUrl } from "../relay/message-content";
import type { Attachment } from "../relay/contracts";
import type { RelayData, RelaySnapshot } from "../relay/service";

export type ImageViewerProps = Readonly<{
  /** An https image URL, relay-hosted media included. Anything else, or media
   * the session cannot read, shows nothing and calls `onClose`. */
  src: string;
  /** Title in the viewer's header. */
  name?: string | undefined;
  /** Escape, the backdrop and the close button ask the caller to unmount it. */
  onClose(): void;
}>;

/** The fullscreen image viewer for an image that is not a message attachment.
 * `media` is the session's resolver, so relay-hosted media gets its signed read. */
export function ImageViewer({
  src,
  name,
  onClose,
  media,
}: ImageViewerProps & { media(url: string): string | undefined }) {
  const frame = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const url = safeMessageUrl(src);
  const source = url && media(url);
  // A source that fails to load or decode shows the stage's unavailable
  // status, keeping the viewer and its Close; a new source tries again.
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (!source) onClose();
  }, [source, onClose]);
  if (!url || !source) return null;
  const title = name?.trim() || "Image";
  const attachment: Attachment = { url, name: title, kind: "image" };
  return (
    <MediaReviewFrame
      title={title}
      label="Image viewer"
      isVideo={false}
      video={video}
      frame={frame}
      origin={undefined}
      close={onClose}
    >
      <ImageReviewStage
        attachments={[attachment]}
        selectedUrl={url}
        select={() => {}}
        media={() => (failed === source ? undefined : source)}
        onImageError={setFailed}
        onOpenLink={() => false}
      />
    </MediaReviewFrame>
  );
}

const noRelay = () => () => {};
const noSnapshot = () => undefined;

/** Resolves media through `relay` as it changes. A community's media needs
 * its session's signed read, so while that session cannot give one
 * (connecting, disconnected, or after the selection moves to another
 * community) it resolves to nothing and the viewer closes. Every community
 * origin seen while open stays relay media, so a switch never reclassifies
 * the previous one's media as external. Other https images load directly. */
export function RelayImageViewer({
  relay,
  ...props
}: ImageViewerProps & { relay: RelayData | undefined }) {
  const snapshot: RelaySnapshot | undefined = useSyncExternalStore(
    relay?.subscribe ?? noRelay,
    relay?.snapshot ?? noSnapshot,
  );
  const ready = snapshot?.origin;
  const selected = relay?.selected?.();
  const seen = useRef(new Set<string>()).current;
  for (const origin of [ready, selected]) if (origin) seen.add(origin);
  const isMedia = (origin: string, url: string) =>
    url.startsWith(`${origin}/media/`);
  return (
    <ImageViewer
      {...props}
      media={(url) => {
        if (ready && isMedia(ready, url) && (!selected || selected === ready))
          return snapshot?.session.media(url);
        for (const origin of seen) if (isMedia(origin, url)) return undefined;
        return url;
      }}
    />
  );
}
