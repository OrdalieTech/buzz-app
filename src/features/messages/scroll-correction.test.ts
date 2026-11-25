// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { correctScrollTop } from "./scroll-correction";

const stubNavigator = (platform: string, vendor: string, maxTouchPoints = 0) =>
  vi.stubGlobal("navigator", { platform, vendor, maxTouchPoints });

function scroller(
  writes?: number[],
  range = { end: Number.POSITIVE_INFINITY },
) {
  const element = document.createElement("section");
  let top = 100;
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      // With `writes`, keep whole offsets, as WebKit does.
      writes?.push(value);
      top = Math.min(range.end, writes ? Math.trunc(value) : value);
    },
  });
  Object.defineProperty(element, "scrollHeight", { get: () => range.end });
  return element;
}

const overflow = (element: HTMLElement) => [
  element.style.getPropertyValue("overflow-y"),
  element.style.getPropertyPriority("overflow-y"),
];

beforeEach(() => {
  vi.useFakeTimers();
  stubNavigator("MacIntel", "Apple Computer, Inc.");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("interrupts Mac WebKit momentum for one task around the correction", () => {
  const element = scroller();
  element.style.setProperty("overflow-y", "scroll", "important");

  correctScrollTop(element, 40);

  expect(element.scrollTop).toBe(140);
  expect(overflow(element)).toEqual(["hidden", "important"]);
  vi.runAllTimers();
  expect(overflow(element)).toEqual(["scroll", "important"]);
});

it("restores the original declaration across overlapping corrections", () => {
  const element = scroller();

  correctScrollTop(element, 40);
  correctScrollTop(element, -10);

  expect(element.scrollTop).toBe(130);
  expect(overflow(element)).toEqual(["hidden", "important"]);
  vi.runAllTimers();
  expect(element.getAttribute("style")).toBe("");
});

it("keeps a declaration written after the correction", () => {
  const element = scroller();

  correctScrollTop(element, 40);
  element.style.overflowY = "auto";
  vi.runAllTimers();

  expect(element.style.getPropertyValue("overflow-y")).toBe("auto");
});

it.each([
  ["Chromium", "MacIntel", "Google Inc.", 0],
  ["desktop-mode iPad", "MacIntel", "Apple Computer, Inc.", 5],
  ["non-Mac WebKit", "Linux x86_64", "Apple Computer, Inc.", 0],
])("leaves %s momentum alone", (_, platform, vendor, touchPoints) => {
  stubNavigator(platform, vendor, touchPoints);
  const element = scroller();

  correctScrollTop(element, 40);

  expect(element.scrollTop).toBe(140);
  expect(element.getAttribute("style")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores a zero correction", () => {
  const element = scroller();

  correctScrollTop(element, 0);

  expect(element.scrollTop).toBe(100);
  expect(element.getAttribute("style")).toBeNull();
});

it("does not write again the fraction a whole-pixel scroller left", () => {
  const writes: number[] = [];
  const element = scroller(writes);

  correctScrollTop(element, 40.75);
  // The reader scrolls on, and the next measurement asks for the same fraction.
  element.scrollTop = 120;
  writes.length = 0;
  correctScrollTop(element, 0.75);

  expect(writes).toEqual([]);
  correctScrollTop(element, 12.75);
  expect(element.scrollTop).toBe(132);
});

it("asks again for a fraction the end of the scroll range refused", () => {
  const range = { end: 100 };
  const element = scroller(undefined, range);
  element.scrollTop = 99.5;

  correctScrollTop(element, 0.75);
  // A row below grows, and the next measurement asks for the rest.
  range.end = 101;
  correctScrollTop(element, 0.25);

  expect(element.scrollTop).toBe(100.25);
});
