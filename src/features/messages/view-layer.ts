import { createContext, type ReactNode } from "react";
import type { ComposerView } from "./composer-overlay";

/** The dialog open on top of a view, and the view: its channel, and the
 * thread it was opened in, if any. A details message names its message; a
 * panel names its target and the thread of the message it was opened from. */
export type OpenLayer = Readonly<
  { channelId: string; rootId?: string | undefined } & (
    | { messageId: string; target?: undefined; threadId?: undefined }
    | { target: string; threadId?: string | undefined; messageId?: undefined }
  )
>;
export type PanelLayer = Extract<OpenLayer, { target: string }>;
/** What a page draws for an open panel layer. */
export type PanelLayerContent = Readonly<{
  title: string;
  content: ReactNode;
  /** Close the layer and open the panel as a tab. */
  openAsTab(): void;
}>;
/** A page whose address carries the open layer: opening and closing it are
 * navigation. Without one, a details message opens in place and panels open
 * as tabs. */
export type LayerAddress = Readonly<{
  open: OpenLayer | undefined;
  show(layer: OpenLayer): void;
  /** Explicit close of `layer`, as ✕, Escape or a send do: retires its
   * visit. Nothing closes when another layer has taken its place since. */
  dismiss(layer: OpenLayer): void;
  /** Draws an open panel layer; the page owns its panels. */
  renderPanel(layer: PanelLayer): PanelLayerContent | undefined;
}>;
export const LayerAddressContext = createContext<LayerAddress | undefined>(
  undefined,
);

/** Whether `open` is shown in `view` of `channelId`. */
export const layerInView = (
  open: OpenLayer | undefined,
  channelId: string,
  view: ComposerView,
) =>
  !!open &&
  view.shown &&
  !view.local &&
  open.channelId === channelId &&
  open.rootId === view.rootId;
