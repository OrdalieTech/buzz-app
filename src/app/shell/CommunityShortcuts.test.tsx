// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../../features/communities/service";
import {
  createShortcutBindings,
  SHORTCUT_BINDINGS_KEY,
} from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import { CommunityShortcuts } from "./CommunityShortcuts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function setup(selected: string | null, ids = ["a", "b"]) {
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
  let snapshot = {
    selected,
    memberships: ids.map((id) => ({ id })),
  };
  const listeners = new Set<() => void>();
  const communities = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
  return {
    onSelect,
    /** The service saved a new switcher order. */
    reorder(ids: string[]) {
      act(() => {
        snapshot = { ...snapshot, memberships: ids.map((id) => ({ id })) };
        for (const listener of listeners) listener();
      });
    },
  };
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

it("numbers the switcher's communities from 1, leaving Personal space unnumbered", () => {
  const { onSelect } = setup(null);
  expect(press("1")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("a");
  expect(press("2")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("b");
  // No third community: the key is left alone.
  expect(press("3")).toBe(false);
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it("numbers the first nine of more communities", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `c${index + 1}`);
  const { onSelect } = setup("c1", ids);
  expect(press("9")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("c9");
});

it("leaves every number alone with no communities", () => {
  const { onSelect } = setup(null, []);
  expect(press("1")).toBe(false);
  expect(onSelect).not.toHaveBeenCalled();
});

it("keeps a saved rebind on a number over the number's default", () => {
  localStorage.setItem(
    SHORTCUT_BINDINGS_KEY,
    JSON.stringify({ "next-community": { key: "1", mod: true } }),
  );
  const { onSelect } = setup("a");
  expect(press("1")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("b");
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("follows a reordered switcher at once, for numbers and steps alike", () => {
  const { onSelect, reorder } = setup("a");
  reorder(["b", "a"]);
  expect(press("1")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("b");
  expect(press("2")).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("a");
  // The selected community is now last, so the next step wraps.
  expect(press("]", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(press("[", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("b");
});

it("steps to the next and previous community with wrapping, on either bracket key", () => {
  const { onSelect } = setup("b");
  expect(press("}", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(press("[", true)).toBe(true);
  expect(onSelect).toHaveBeenLastCalledWith("a");
});
