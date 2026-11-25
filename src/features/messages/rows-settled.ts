import type { VirtualizerHandle } from "virtua";

/**
 * Whether Virtua holds the rendered size of every row from the one across the
 * viewport's top edge down to, not including, the held row. Rows wholly above
 * the viewport are Virtua's to keep in place.
 */
export function rowsSettled(
  virtualizer: Pick<
    VirtualizerHandle,
    "findItemIndex" | "getItemSize" | "scrollOffset"
  >,
  element: Element,
  list: Element,
  held: number,
) {
  // Virtua places each item at its offset, whatever its height, and in index
  // order. A row of no height shares the next row's offset, so walk up from
  // the last item and never reuse an index.
  const viewport = element.getBoundingClientRect().top;
  const items = new Map<number, number>();
  let next = Number.POSITIVE_INFINITY;
  for (const child of Array.from(list.children).reverse()) {
    const { top, height } = child.getBoundingClientRect();
    next = Math.min(
      next - 1,
      virtualizer.findItemIndex(
        top - viewport + virtualizer.scrollOffset + 0.5,
      ),
    );
    items.set(next, height);
  }
  for (
    let index = virtualizer.findItemIndex(virtualizer.scrollOffset);
    index < held;
    index++
  ) {
    const height = items.get(index);
    if (
      height === undefined ||
      Math.abs(height - virtualizer.getItemSize(index)) >= 0.5
    )
      return false;
  }
  return true;
}
