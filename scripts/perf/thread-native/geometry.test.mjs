import { expect, test } from "vitest";
import { fitWindow, REFERENCE_WINDOW, threadCapture } from "./geometry.mjs";

const display = (width, height, visible, scale = 2) => ({
  frame: { width, height },
  visible,
  scale,
});

test("keeps the reference window verbatim when the usable display holds it", () => {
  const screen = display(1728, 1117, {
    x: 0,
    y: 37,
    width: 1728,
    height: 1000,
  });
  expect(fitWindow(screen)).toEqual({ ...REFERENCE_WINDOW, fitted: false });
});

test("shifts before shrinking and fits smaller displays inside visible bounds", () => {
  // 1512x982 with notch + bottom Dock: shifts x left to keep full 1504 width,
  // shrinks height to fit above the Dock.
  const mbp14 = display(1512, 982, { x: 0, y: 37, width: 1512, height: 875 });
  expect(fitWindow(mbp14)).toEqual({
    x: 8,
    y: 37,
    width: 1504,
    height: 875,
    fitted: true,
  });

  // 1440x900 with menu bar + bottom Dock: fits cleanly inside 1440x810.
  const compact = display(1440, 900, { x: 0, y: 25, width: 1440, height: 810 });
  expect(fitWindow(compact)).toEqual({
    x: 0,
    y: 25,
    width: 1440,
    height: 810,
    fitted: true,
  });
});

test("rejects displays smaller than the minimum usable area", () => {
  const small = display(1200, 800, { x: 0, y: 25, width: 1200, height: 705 });
  expect(() => fitWindow(small)).toThrow("below the 1280x700 minimum");
});

test("rounds fractional and odd-origin crops inward to even pixels", () => {
  // 1x display with odd left/top and fractional width/height: rounding inward
  // avoids NV12 shifting odd origins down into the neighboring pane.
  const screen = display(
    1440,
    900,
    { x: 0, y: 25, width: 1440, height: 810 },
    1,
  );
  const plan = threadCapture(
    [0, 25, 1440, 810],
    [901.2, 85.1, 531.6, 599.7],
    screen,
    1,
  );
  expect(plan.crop).toEqual({ x: 902, y: 112, width: 530, height: 596 });
  expect(plan.focus).toEqual([1421, 440]);
  expect(plan.center).toEqual([1167, 410]);
});

test("rejects a thread pane overhanging the visible display", () => {
  const screen = display(
    1440,
    900,
    { x: 0, y: 25, width: 1440, height: 810 },
    2,
  );
  expect(() =>
    threadCapture([18, 51, 1504, 810], [934.2, 85, 562.8, 600], screen, 2),
  ).toThrow("extends outside visible display");
});
