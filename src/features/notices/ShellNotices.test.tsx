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
import { afterEach, expect, it } from "vitest";
import type { PluginManager } from "../../plugins/manager";
import type { PluginManifest } from "../../plugins/api";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { NoticesService } from "./service";
import { ShellNotices } from "./ShellNotices";

afterEach(cleanup);

const manifest: PluginManifest = {
  id: "example.plugin",
  name: "Example drafts",
  apiVersion: 1,
};
const plugins: Pick<PluginManager, "subscribe" | "snapshot"> = (() => {
  const snapshot = {
    configuration: {
      status: "ready" as const,
      catalog: {
        profile: "",
        location: "",
        plugins: [
          {
            manifest,
            source: "external" as const,
            enabled: true,
            revision: "one",
            previous: null,
            reloadable: false,
            error: null,
          },
        ],
      },
      externalPluginsPaused: false,
    },
    hostOwned: [],
    activation: {},
    busy: false,
    error: null,
    refreshError: null,
  };
  return { subscribe: () => () => {}, snapshot: () => snapshot };
})();

it("draws a plugin's notice with its buttons and the plugin's name, and answers with the button clicked or none when dismissed", async () => {
  const root = new Context();
  const notices = new NoticesService(root);
  const plugin = root.extend({
    pluginOwner: { id: manifest.id, revision: "one" },
  });
  render(
    <ToastProvider>
      <ShellNotices notices={notices} plugins={plugins} />
    </ToastProvider>,
  );
  const content = {
    title: "Publish the draft?",
    actions: [
      { id: "yes", label: "Publish", prominent: true },
      { id: "no", label: "Not now" },
    ],
  };
  const show = () => {
    let closed: Promise<string | undefined> | undefined;
    act(() => {
      closed = plugin.notices?.show(content);
    });
    return closed;
  };
  const picked = show();
  const notice = await screen.findByRole("dialog", {
    name: "Publish the draft?",
  });
  expect(notice).toHaveTextContent("From Example drafts");
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await expect(picked).resolves.toBe("no");
  const dismissed = show();
  await screen.findByRole("dialog", { name: "Publish the draft?" });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await expect(dismissed).resolves.toBeUndefined();
  expect(notices.snapshot()).toEqual([]);
  await root.fiber.dispose();
});
