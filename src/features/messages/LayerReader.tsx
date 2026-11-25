import { useContext, useRef } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  useComposerExpected,
  useComposerHost,
  useComposerScope,
} from "./composer-overlay";
import { DetailsReader } from "./DetailsReader";
import { ComposerSheet } from "./ComposerSheet";
import styles from "./Messages.module.css";
import { LayerAddressContext, type OpenLayer, layerInView } from "./view-layer";

/** The layer of the view it is mounted in, when the address names one: a
 * details message, read from its id so it opens whether or not its row is on
 * screen, or a panel. It is a sheet over that view's composer (a panel's at
 * full height), or a centered dialog when the view has no composer on screen.
 * A thread's reply box arrives with its root, so a layer over a thread that
 * will show one waits for it rather than opening elsewhere first. The address owns whether it is
 * open. */
export function LayerReader({ channelId }: { channelId: string }) {
  const view = useComposerScope();
  const address = useContext(LayerAddressContext);
  const open = address?.open;
  if (!address || !view || !open || !layerInView(open, channelId, view))
    return null;
  // Each layer is its own reader: a replacement mounts fresh.
  return <Layer key={open.messageId ?? open.target} open={open} />;
}

function Layer({ open }: { open: OpenLayer }) {
  const view = useComposerScope();
  const address = useContext(LayerAddressContext);
  const host = useComposerHost(view?.handle);
  // A thread's reply box on its way: the thread says whether one is coming.
  const expected = useComposerExpected(view?.handle);
  // Close hands focus back to what opened the layer, when it is still there.
  const opener = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  if (!address || !view) return null;
  // The layer reads at once, and draws once its thread's reply box is there.
  const waiting = !host && expected;
  const onOpenChange = (next: boolean) => {
    if (!next) address.dismiss(open);
  };
  if (open.target === undefined)
    return (
      <DetailsReader channelId={open.channelId} messageId={open.messageId}>
        {({ title, avatar, time, body }) =>
          waiting ? null : host ? (
            <ComposerSheet
              open
              onOpenChange={onOpenChange}
              host={host}
              title={title}
              leading={avatar}
              description={time}
              finalFocus={opener}
            >
              {body}
            </ComposerSheet>
          ) : (
            <Dialog
              open
              onOpenChange={onOpenChange}
              title={title}
              description={time}
              bodyLayout="flex"
              visit
              finalFocus={opener}
            >
              <section
                className={styles.detailsDialogScroll}
                aria-label="Message"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll owner must support keyboard scrolling.
                tabIndex={0}
              >
                {body}
              </section>
            </Dialog>
          )
        }
      </DetailsReader>
    );
  const drawn = address.renderPanel(open);
  if (!drawn || waiting) return null;
  return host ? (
    <ComposerSheet
      open
      onOpenChange={onOpenChange}
      host={host}
      title={drawn.title}
      readerOnly
      onOpenAsTab={drawn.openAsTab}
    >
      {drawn.content}
    </ComposerSheet>
  ) : (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={drawn.title}
      size="wide"
      visit
    >
      {drawn.content}
    </Dialog>
  );
}
