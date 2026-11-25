import { macWebKit } from "./mac-webkit";

const restores = new WeakMap<HTMLElement, () => void>();
// The part of each scroller's last correction that its offset did not take.
const remainders = new WeakMap<HTMLElement, number>();

/**
 * Applies an automatic scroll correction. Mac WebKit can leave the corrected
 * viewport unpainted while native momentum continues, so stop the momentum the
 * same way the Virtua patch does (patches/virtua@0.54.2.patch): hide vertical overflow for
 * one task. The scroller must keep its inline size (`scrollbar-gutter: stable`).
 *
 * A scroller keeps whole offsets (WebKit truncates scrollTop), so a caller
 * holding an exact position is left a fraction of a pixel short and asks for
 * that fraction again after every measurement. Writing it again moves nothing,
 * but any scroll write ends a wheel that Linux WebKit is still animating, and
 * the reader loses the rest of it. Skip the fraction the last correction left.
 */
export function correctScrollTop(element: HTMLElement, delta: number) {
  if (!delta) return;
  const left = remainders.get(element);
  if (left !== undefined && Math.abs(delta - left) < 0.001) return;
  if (macWebKit()) {
    // Corrections in one task share the original declaration.
    restores.get(element)?.();
    const { style } = element;
    const value = style.getPropertyValue("overflow-y");
    const priority = style.getPropertyPriority("overflow-y");
    style.setProperty("overflow-y", "hidden", "important");
    const restore = () => {
      clearTimeout(timer);
      restores.delete(element);
      if (
        style.getPropertyValue("overflow-y") === "hidden" &&
        style.getPropertyPriority("overflow-y") === "important"
      )
        value
          ? style.setProperty("overflow-y", value, priority)
          : style.removeProperty("overflow-y");
    };
    const timer = setTimeout(restore);
    restores.set(element, restore);
  }
  const target = element.scrollTop + delta;
  element.scrollTop = target;
  const remainder = target - element.scrollTop;
  // A shortfall at an end of the range is the range's, which content can move.
  const clamped =
    target < 0 || target > element.scrollHeight - element.clientHeight - 1;
  if (remainder && Math.abs(remainder) < 1 && !clamped)
    remainders.set(element, remainder);
  else remainders.delete(element);
}
