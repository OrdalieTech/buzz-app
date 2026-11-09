// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AccountActionsService } from "../../features/account-actions/service";
import { SidebarScopeService } from "../../features/channel-navigation/sidebar-scope-service";
import { provideNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import { createNotificationPreferences } from "../../features/notifications/preferences";
import { NotificationsService } from "../../features/notifications/service";
import type { StatusInput, UserStatus } from "../../features/relay/user-status";
import { SettingsCardsService } from "../../features/settings/service";
import { ShortcutsService } from "../../features/shortcuts/service";
import { PluginRuntime } from "../../plugins/runtime";
import * as focusPlugin from "./index";
import { FOCUS_KEY } from "./state";
import { FOCUS_STATUS } from "./status";

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  localStorage.clear();
});

const scope = { viewer: "a".repeat(64), communityOrigin: "wss://one.example" };
const conversation = (channelId: string): OpenTarget => ({
  version: 1,
  kind: "conversation",
  scope,
  channelId,
});

function setup(initial?: StatusInput) {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => focusPlugin);
  ctx.effect(() => () => runtime.dispose());
  const navigation = provideNavigation(ctx).navigation;
  const show = vi.fn(async () => {});
  const notifications = new NotificationsService(
    ctx,
    navigation,
    {
      label: "Test",
      permission: async () => "granted",
      requestPermission: async () => "granted",
      show,
      dispose() {},
    },
    createNotificationPreferences(),
    () => true,
    () => {},
  );
  notifications.selectViewer(scope.viewer);
  const shortcuts = new ShortcutsService(ctx, undefined);
  const settingsCards = new SettingsCardsService(ctx);
  let published: UserStatus | undefined = initial && {
    ...initial,
    userId: scope.viewer,
    updatedAt: 1,
  };
  const save = vi.fn(async (input: StatusInput) => {
    published =
      input.text || input.emoji
        ? { ...input, userId: scope.viewer, updatedAt: 2 }
        : undefined;
  });
  const relayListeners = new Set<() => void>();
  const sidebarScope = new SidebarScopeService(ctx);
  const accountActions = new AccountActionsService(ctx);
  ctx.provide("relay", {
    snapshot: () => ({
      status: "ready",
      cached: false,
      scope: "wss://one.example:viewer",
      viewer: scope.viewer,
      session: {
        readRemote: async () => [],
        statuses: {
          writable: true,
          save,
          current: async () => published,
          snapshot: () => new Map(published ? [[scope.viewer, published]] : []),
        },
        channels: {
          list: () => ({
            channels: [
              { id: "solo", channelType: "solo" },
              { id: "team", channelType: "stream" },
            ],
          }),
        },
      },
    }),
    subscribe: (listener: () => void) => {
      relayListeners.add(listener);
      return () => relayListeners.delete(listener);
    },
  });
  const plugin = {
    manifest: { id: "buzz.focus", name: "Focus", apiVersion: 1 as const },
    enabled: true,
    source: "bundled" as const,
    revision: "bundled",
    previous: null,
    reloadable: false,
    error: null,
  };
  return {
    ctx,
    save,
    notifications,
    sidebarScope,
    shortcuts,
    settingsCards,
    accountActions,
    alert: (sourceKey: string, channelId: string) =>
      notifications.admit(
        "mention",
        "Mentions",
        { sourceKey, target: conversation(channelId) },
        () => true,
        () => true,
      ),
    enable: () => runtime.reconcile([plugin]),
    // The manager passes the runtime only the enabled plugins.
    disable: () => runtime.reconcile([]),
  };
}

it("adds a profile-menu action and leaves alerts and the sidebar alone while off", async () => {
  const t = setup();
  t.enable();
  await vi.waitFor(() =>
    expect(t.accountActions.snapshot().map((a) => a.title)).toEqual(["Focus"]),
  );
  expect(t.sidebarScope.snapshot()).toEqual([]);
  expect(t.notifications.gated(conversation("team"))).toBe(true);
});

it("resumes a saved Focus, lets only Solo alert, and releases everything on End", async () => {
  const until = Math.floor(Date.now() / 1000) + 600;
  localStorage.setItem(FOCUS_KEY, JSON.stringify({ until }));
  const t = setup();
  t.enable();
  await vi.waitFor(() => expect(t.sidebarScope.snapshot()).toHaveLength(1));
  expect(t.notifications.gated(conversation("solo"))).toBe(true);
  expect(t.notifications.gated(conversation("team"))).toBe(false);
  expect(
    t.notifications.gated({ version: 1, kind: "settings", section: "about" }),
  ).toBe(false);
  const Banner = t.sidebarScope.snapshot()[0]?.banner;
  if (!Banner) throw new Error("No banner");
  render(<Banner />);
  expect(screen.getByText(/^Focusing until/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "End" }));
  expect(t.sidebarScope.snapshot()).toEqual([]);
  expect(t.notifications.gated(conversation("team"))).toBe(true);
  expect(localStorage.getItem(FOCUS_KEY)).toBeNull();
});

it("⌥F starts Focus for the shortcut length set in Settings", async () => {
  const t = setup();
  t.enable();
  await vi.waitFor(() =>
    expect(t.settingsCards.snapshot().map((card) => card.title)).toEqual([
      "Focus",
    ]),
  );
  const shortcut = t.shortcuts.snapshot().find((item) => item.id === "toggle");
  expect(shortcut?.binding).toEqual([
    { key: "f", alt: true },
    { key: "ƒ", alt: true },
  ]);
  const before = Math.floor(Date.now() / 1000);
  act(() => shortcut?.run());
  // One hour unless Settings says otherwise.
  const until = focusUntil();
  expect(until - before).toBeGreaterThanOrEqual(3599);
  expect(until - before).toBeLessThanOrEqual(3601);
  act(() => shortcut?.run());
  expect(localStorage.getItem(FOCUS_KEY)).toBeNull();
  const Card = t.settingsCards.snapshot()[0]?.component;
  if (!Card) throw new Error("No settings card");
  render(<Card active={() => true} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: /Default length/ }));
  await user.click(await screen.findByRole("option", { name: "2 hours" }));
  act(() => shortcut?.run());
  expect(focusUntil() - before).toBeGreaterThanOrEqual(7199);
});

it("disabling the plugin mid-Focus releases everything and keeps Focus for next time", async () => {
  localStorage.setItem(
    FOCUS_KEY,
    JSON.stringify({ until: Math.floor(Date.now() / 1000) + 600 }),
  );
  const t = setup({ text: "Lunch", emoji: "🥪" });
  t.enable();
  await vi.waitFor(() =>
    expect(t.save).toHaveBeenLastCalledWith(
      expect.objectContaining(FOCUS_STATUS),
    ),
  );
  expect(await t.alert("team-1", "team")).toBe(false);
  act(() => t.disable());
  await vi.waitFor(() => expect(t.sidebarScope.snapshot()).toEqual([]));
  expect(t.notifications.gated(conversation("team"))).toBe(true);
  expect(await t.alert("team-2", "team")).toBe(true);
  // 🔭 expires on its own; nothing restores it from a disabled plugin.
  expect(t.save).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(localStorage.getItem(FOCUS_KEY) ?? "{}").until,
  ).toBeDefined();
});

it("closing the app keeps Focus and its status for next time", async () => {
  localStorage.setItem(
    FOCUS_KEY,
    JSON.stringify({ until: Math.floor(Date.now() / 1000) + 600 }),
  );
  const t = setup({ text: "Lunch", emoji: "🥪" });
  t.enable();
  await vi.waitFor(() => expect(t.save).toHaveBeenCalledTimes(1));
  await t.ctx.fiber.dispose();
  expect(t.save).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(localStorage.getItem(FOCUS_KEY) ?? "{}").until,
  ).toBeDefined();
});

function focusUntil(): number {
  return JSON.parse(localStorage.getItem(FOCUS_KEY) ?? "{}").until ?? 0;
}
