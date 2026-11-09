// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OnboardingBees } from "./OnboardingBees";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("animates only a visible area and resumes when a zero-size surface gains dimensions", () => {
  let width = 0;
  let height = 0;
  let resized = () => {};
  const frame = vi.fn(() => 1);
  const cancel = vi.fn();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => width,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => height,
  );
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("requestAnimationFrame", frame);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  render(<OnboardingBees />);
  expect(frame).not.toHaveBeenCalled();
  width = 800;
  height = 600;
  act(resized);
  expect(frame).toHaveBeenCalledOnce();
  width = 0;
  act(resized);
  expect(cancel).toHaveBeenLastCalledWith(1);
  expect(frame).toHaveBeenCalledOnce();
  width = 800;
  act(resized);
  expect(frame).toHaveBeenCalledTimes(2);
});
