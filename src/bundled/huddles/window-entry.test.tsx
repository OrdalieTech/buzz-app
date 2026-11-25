// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { subscribeSavedDownloads } from "../../features/messages/native-download";

const host = vi.hoisted(() => ({
  channels: [] as { onmessage?: (update: unknown) => void }[],
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (update: unknown) => void;
    constructor() {
      host.channels.push(this);
    }
  },
  invoke: host.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: host.listen }));

it("refreshes file cards from the watch channel, which also carries the call", async () => {
  stubAvatarBrowserApis();
  host.invoke.mockResolvedValue(undefined);
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("./window-entry");
  });
  await waitFor(() =>
    expect(host.invoke).toHaveBeenCalledWith("huddle_window_watch", {
      updates: host.channels[0],
    }),
  );
  const update = (message: unknown) =>
    act(async () => host.channels[0]?.onmessage?.(message));

  // The Huddle capability has no event permission: a card must not ask for it.
  const card = vi.fn();
  subscribeSavedDownloads(card);
  expect(host.listen).not.toHaveBeenCalled();
  await update("savedDownloads");
  expect(card).toHaveBeenCalledTimes(1);

  await update({
    view: {
      id: "call",
      title: "Design review",
      phase: "connected",
      muted: true,
      level: 0,
      dark: true,
      participants: [],
      discussionOpen: false,
    },
  });
  expect(
    await screen.findByRole("button", { name: "Unmute" }),
  ).toBeInTheDocument();
  expect(document.documentElement).toHaveClass("dark");
  expect(card).toHaveBeenCalledTimes(1);
});
