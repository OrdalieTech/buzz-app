// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ShortcutsService } from "../../features/shortcuts/service";
import type { PluginModule } from "../../plugins/api";
import { PluginRuntime } from "../../plugins/runtime";
import * as finderPlugin from "./index";
import { topInterest } from "./interest";
import { queryEvents } from "../../../tests/fixtures/finder-data";
import type { RelayEvent } from "../../features/relay/events";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  message,
  metadata,
  roster,
} from "../../features/relay/testing";

const viewer = "a".repeat(64);
const communityOrigin = "https://relay.example.org";
const scope = `${communityOrigin}:${viewer}`;
const contexts: Context[] = [];
const sessions: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
});
afterEach(async () => {
  cleanup();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dispose of sessions.splice(0)) dispose();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mount(
  relay: unknown = {
    snapshot: () => ({ status: "connecting" }),
    subscribe: () => () => {},
  },
) {
  const ctx = new Context();
  contexts.push(ctx);
  const modules: Record<string, PluginModule> = { "buzz.finder": finderPlugin };
  const runtime = new PluginRuntime(ctx, async (plugin) => {
    const module = modules[plugin.manifest.id];
    if (!module) throw new Error(`No module for ${plugin.manifest.id}`);
    return module;
  });
  ctx.effect(() => () => runtime.dispose());
  const listeners = new Set<() => void>();
  let entry: { id: string; target: unknown } = {
    id: "home",
    target: { kind: "home" },
  };
  // Stable between changes, as the real navigation snapshot is.
  let snapshot = { entry };
  // The real dispatcher, so typing guards apply as in the app.
  const shortcuts = new ShortcutsService(ctx, window);
  let Overlay: ComponentType = () => null;
  ctx.provide("relay", relay as never);
  ctx.provide("navigation", {
    open: vi.fn(async () => ({ status: "opened" })),
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as never);
  ctx.provide("pages", {
    registerOverlay(overlay: { component: ComponentType }) {
      Overlay = overlay.component;
    },
  } as never);
  const navigate = (next: typeof entry) => {
    entry = next;
    snapshot = { entry };
    for (const listener of listeners) listener();
  };
  const enable = async (...ids: string[]) => {
    await act(() =>
      runtime.reconcile(
        ids.map((id) => ({
          manifest: { id, name: id, apiVersion: 1 as const },
          enabled: true,
          source: "bundled" as const,
          revision: "bundled",
          previous: null,
          reloadable: false,
          error: null,
        })),
      ),
    );
    await vi.waitFor(() =>
      expect(
        shortcuts.snapshot().some((entry) => entry.key === "buzz.finder/open"),
      ).toBe(true),
    );
  };
  await enable("buzz.finder");
  // Load the lazy dialog first, so its import time can't race the waits.
  await import("./FinderDialog");
  return {
    visit: (id: string, channelId: string) =>
      navigate({
        id,
        target: {
          kind: "conversation",
          scope: { viewer, communityOrigin },
          channelId,
        },
      }),
    leave: () => navigate({ id: `home-${entry.id}`, target: { kind: "home" } }),
    notify: () => {
      for (const listener of listeners) listener();
    },
    show: () => render(<Overlay />),
  };
}

const selectedTab = async () =>
  (await screen.findByRole("tab", { selected: true })).textContent;
const type = (value: string) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value } });

test("counts each visit to a conversation once", async () => {
  const { visit, notify } = await mount();
  visit("v1", "busy");
  // Navigation also notifies for attempts and other changes to one visit.
  notify();
  notify();
  visit("v2", "quiet");
  visit("v3", "quiet");
  expect(topInterest(scope, 5)).toEqual(["quiet", "busy"]);
});

test("⌘P searches the open conversation, else all of Buzz; ⌘⇧P switches inside Finder but leaves other text fields alone; closing returns focus there", async () => {
  const { visit, leave, show } = await mount();
  // Off Apple platforms, ⌘ is Ctrl.
  const press = (target: Element, shift = false) =>
    fireEvent.keyDown(target, {
      key: shift ? "P" : "p",
      code: "KeyP",
      ctrlKey: true,
      shiftKey: shift,
    });
  const composer = document.createElement("textarea");
  document.body.append(composer);
  visit("v1", "crew");
  show();
  // Not over another modal, but over one on its way out, such as Finder
  // itself just after Escape.
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  press(document.body);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  modal.setAttribute("data-closed", "");
  // ⌘P works while typing.
  composer.focus();
  press(composer);
  expect(await selectedTab()).toBe("This channel");
  modal.remove();
  const field = screen.getByRole("combobox");
  field.focus();
  press(field, true);
  expect(await selectedTab()).toBe("All of Buzz");
  press(field);
  expect(await selectedTab()).toBe("This channel");
  fireEvent.keyDown(field, { key: "Escape" });
  await vi.waitFor(() =>
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument(),
  );
  // Back where you were typing.
  await vi.waitFor(() => expect(composer).toHaveFocus());
  // Typing in the composer, ⌘⇧P is Spoiler's: Finder neither opens nor
  // takes the key.
  expect(press(composer, true)).toBe(true);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  leave();
  composer.blur();
  press(document.body);
  expect(await selectedTab()).toBe("All of Buzz");
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  // The dialog is gone once its focus return has run.
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  // Opened with nothing focused, it doesn't focus the first control.
  expect(document.body).toHaveFocus();
  composer.remove();
});

test("This channel follows the conversation on screen, keeping the text", async () => {
  const { show, visit, leave } = await mount();
  show();
  visit("v1", "crew");
  fireEvent.keyDown(document.body, { key: "p", code: "KeyP", ctrlKey: true });
  expect(await selectedTab()).toBe("This channel");
  type("ap");
  act(() => leave());
  expect(await selectedTab()).toBe("All of Buzz");
  expect(screen.getByRole("tab", { name: "This channel" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  act(() => visit("v2", "lab"));
  expect(await selectedTab()).toBe("This channel");
  expect(screen.getByRole("combobox")).toHaveValue("ap");
});

test("a reconnect keeps the index; another account drops it", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const me = keypair();
  const relayKey = keypair();
  const events = [
    metadata(relayKey, "crew", "crew"),
    roster(relayKey, "crew", [me.pubkey]),
    message(me, "crew", "Quartz plans", Math.floor(Date.now() / 1000) - 60),
  ];
  const connect = (viewer: string, found: readonly RelayEvent[]) => {
    const owner = createRelaySession({
      viewer,
      relayAuthor: relayKey.pubkey,
      media: () => undefined,
      query: async (filters) => queryEvents(found, filters),
    });
    sessions.push(owner.dispose);
    return owner.session;
  };
  const listeners = new Set<() => void>();
  let snapshot: Record<string, unknown> = { status: "connecting" };
  const publish = (next: Record<string, unknown>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const ready = (viewer: string, generation: number, found = events) => ({
    status: "ready",
    generation,
    viewer,
    scope: `${communityOrigin}:${viewer}`,
    session: connect(viewer, found),
  });
  const { show } = await mount({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
  act(() => publish(ready(me.pubkey, 1)));
  show();
  fireEvent.keyDown(document.body, { key: "p", code: "KeyP", ctrlKey: true });
  type("quartz");
  await screen.findByRole("option", { name: /Quartz plans/ });
  // The new session's relay has nothing; the row is the kept index's.
  act(() => publish({ status: "connecting", generation: 2 }));
  act(() => publish(ready(me.pubkey, 2, events.slice(0, 2))));
  expect(screen.getByRole("option", { name: /Quartz plans/ })).toBeVisible();
  act(() => publish(ready(keypair().pubkey, 3, [])));
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("option", { name: /Quartz plans/ }),
    ).not.toBeInTheDocument(),
  );
});
