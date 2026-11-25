// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { App } from "./App";
import { launchVisible } from "./launch";
import { createServices, type AppServices } from "./services";
import { keypair, signed } from "../features/relay/testing";

// The notifications service sends its one automatic permission request only
// while the app tells it the person has landed: in the shell with a community,
// the launch screen gone. This proves that wiring. What the service then does
// with it lives in features/notifications/service.test.ts.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  Channel: class {
    id = 1;
    onmessage = () => {};
  },
}));
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
  ],
}));
const member = keypair();
const relay = "https://relay-a.example";
const relaySelf = keypair().pubkey;
const membership = { id: relay, name: "relay-a.example" };
const profile = { name: "Ada", picture: "", about: "" };
let services: AppServices | undefined;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
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
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.mocked(isTauri).mockReturnValue(true);
  // A key is already on this device, so the first-run gate is open.
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return member.pubkey;
    if (command === "identity_legacy_available") return false;
    if (command === "get_os_idle_seconds") return 0;
    if (command === "relay_sign")
      return signed(member, (args as { event: EventTemplate }).event);
    if (command === "relay_http") return relayAnswer(args);
    if (command === "deep_link_take") return [];
    if (command === "deep_link_watch") return null;
    if (command === "plugin_catalog")
      return {
        status: "ready",
        externalPluginsPaused: false,
        catalog: {
          profile: "fixture",
          location: "fixture",
          plugins: [
            {
              manifest: {
                id: "buzz.channels",
                name: "Channels",
                apiVersion: 1,
              },
              source: "bundled",
              revision: "bundled",
              enabled: true,
              previous: null,
              reloadable: false,
              error: null,
            },
          ],
        },
      };
    // Other native owners may initialize, but no actual native operations run.
    throw new Error(`Fixture native capability unavailable: ${command}`);
  });
});
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  document.getElementById("buzz-launch")?.remove();
  document.getElementById("root")?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** The relay answers discovery and reads, with nothing in them. */
function relayAnswer(args: unknown) {
  const request = args as { community: string; path: string };
  const answer = (status: number, value?: unknown) => ({
    status,
    headers: {},
    body: value === undefined ? "" : JSON.stringify(value),
  });
  if (request.community !== relay) return answer(404);
  if (request.path === "/")
    return answer(200, { name: "Buzz Relay", self: relaySelf });
  if (request.path === "/query") return answer(200, []);
  return answer(404);
}
function start(container?: HTMLElement) {
  const current = createServices();
  services = current;
  const entered = vi.spyOn(current.notifications, "setEntered");
  render(<App services={current} />, container ? { container } : undefined);
  return { current, entered };
}

it("does not report entry on the community landing, reports it once a community is joined, and withdraws it when the last one goes", async () => {
  const { current, entered } = start();
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  // The viewer is known and the launch screen is gone: only a community is
  // missing.
  expect(current.communities.snapshot()).toMatchObject({
    viewer: member.pubkey,
    memberships: [],
  });
  expect(launchVisible()).toBe(false);
  expect(entered).not.toHaveBeenCalled();
  act(() => current.communities.joined(membership, profile));
  await waitFor(() => expect(entered.mock.calls).toEqual([[true]]));
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).not.toBeInTheDocument();
  await act(() => current.communities.leave(relay));
  expect(current.communities.snapshot().memberships).toEqual([]);
  await waitFor(() => expect(entered.mock.calls).toEqual([[true], [false]]));
});

it("on a launch with a community, reports entry only once the launch screen has gone", async () => {
  localStorage.setItem(
    `buzz-client.v1:${member.pubkey}`,
    JSON.stringify({ profile, memberships: [membership], selected: relay }),
  );
  // The launch screen as index.html provides it, held by content the test
  // owns: the screen stays while required content is still pending.
  const launch = document.createElement("div");
  launch.id = "buzz-launch";
  const root = document.createElement("div");
  root.id = "root";
  const pending = document.createElement("div");
  pending.dataset.buzzLaunchPending = "required";
  const container = document.createElement("div");
  root.append(pending, container);
  document.body.append(launch, root);
  const { current, entered } = start(container);
  try {
    // The shell presented its page beneath the launch screen, with the
    // viewer and the community both known.
    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("opened"),
    );
    expect(current.communities.snapshot()).toMatchObject({
      viewer: member.pubkey,
      memberships: [{ id: relay }],
    });
    expect(launchVisible()).toBe(true);
    expect(entered).not.toHaveBeenCalled();
  } finally {
    act(() => pending.remove());
  }
  await waitFor(() => expect(entered.mock.calls).toEqual([[true]]));
  expect(launchVisible()).toBe(false);
});
