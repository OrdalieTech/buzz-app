// @vitest-environment jsdom
import { expect, it } from "vitest";
import { rowsSettled } from "./rows-settled";

// Virtua's layout: each mounted item at its offset from its own sizes, in
// index order; findItemIndex gives the last index starting at or above an
// offset. `rendered` is each row's height in the DOM, `undefined` unmounted.
function layout(
  sizes: number[],
  rendered: (number | undefined)[],
  scrollOffset: number,
) {
  const starts = sizes.map((_, index) =>
    sizes.slice(0, index).reduce((sum, size) => sum + size, 0),
  );
  const virtualizer = {
    scrollOffset,
    getItemSize: (index: number) => sizes[index] ?? 0,
    findItemIndex: (offset: number) => {
      let found = 0;
      starts.forEach((start, index) => {
        if (start <= offset) found = index;
      });
      return found;
    },
  };
  const rect = (top: number, height: number) => ({ top, height }) as DOMRect;
  const element = document.createElement("section");
  element.getBoundingClientRect = () => rect(100, 600);
  const list = document.createElement("ol");
  rendered.forEach((height, index) => {
    if (height === undefined) return;
    const item = document.createElement("li");
    item.getBoundingClientRect = () =>
      rect(100 + (starts[index] ?? 0) - scrollOffset, height);
    list.append(item);
  });
  return (held: number) => rowsSettled(virtualizer, element, list, held);
}

it("settles when every row from the top edge to the held row is measured", () => {
  expect(layout([40, 40, 40, 40], [40, 40, 40, 40], 50)(3)).toBe(true);
});

it("waits for a row below the edge row that renders at another size", () => {
  expect(layout([40, 40, 40, 40, 40], [40, 40, 104, 40, 40], 50)(4)).toBe(
    false,
  );
});

it("waits for a row in the interval that is not mounted", () => {
  expect(layout([40, 40, 40, 40, 40], [40, 40, undefined, 40, 40], 50)(4)).toBe(
    false,
  );
});

it("leaves rows wholly above the viewport and from the held row down to Virtua", () => {
  expect(layout([40, 40, 40, 40, 40], [64, 40, 40, 40, 64], 50)(3)).toBe(true);
});

it("settles over folded rows of no height", () => {
  expect(layout([40, 40, 0, 0, 40, 40], [40, 40, 0, 0, 40, 40], 50)(5)).toBe(
    true,
  );
  expect(layout([40, 40, 40, 0, 40], [40, 40, 40, 0, 40], 50)(4)).toBe(true);
});

it("waits for a row Virtua still sizes at zero", () => {
  expect(layout([40, 40, 0, 40, 40], [40, 40, 40, 40, 40], 50)(4)).toBe(false);
});

it("checks from the first row at the channel start", () => {
  expect(layout([40, 40, 40], [40, 64, 40], 0)(2)).toBe(false);
  expect(layout([40, 40, 40], [40, 40, 40], 0)(2)).toBe(true);
});
