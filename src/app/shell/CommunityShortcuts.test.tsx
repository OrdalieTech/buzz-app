// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../../features/communities/service";
import { createShortcutBindings } from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import { CommunityShortcuts } from "./CommunityShortcuts";

afterEach(cleanup);

function setup(selected: string | null) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const shortcuts = new ShortcutsService(
    root,
    window,
    createShortcutBindings(window),
  );
  const snapshot = {
    selected,
    memberships: [{ id: "a" }, { id: "b" }],
  };
  const communities = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    select: vi.fn(),
  } as unknown as Communities;
  const onSelect = vi.fn();
  render(
    <CommunityShortcuts
      communities={communities}
      shortcuts={shortcuts}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

// jsdom has no platform, so Control is the primary modifier here.
const press = (key: string, shift = false) => {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
};

it("switches to the community switcher's entries by number, Personal space first", () => {
  const onSelect = setup("a");
  expect(press("1")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(press("3")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("b");
  // No fourth entry: the key is left alone.
  expect(press("4")).toBe(false);
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it("steps to the next and previous community with wrapping, on either bracket key", () => {
  const onSelect = setup("b");
  expect(press("}", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(press("[", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("a");
});
