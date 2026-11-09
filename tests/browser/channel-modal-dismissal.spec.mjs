import { openChannelDetails } from "./channel-details.mjs";
import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { fixtureRelayUrl } from "../relay-config.ts";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only contract: confirmation hit-testing over a retained Canvas tab,
// inside-origin drags, backdrop pointer focus return and Settings survival.
// Cancellation matrices and writes stay in mounted component/domain tests.
test("Canvas confirmation backdrop dismisses only the top layer and retains the draft", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(
    ({ viewer, relay }) => {
      localStorage.setItem("buzz-appearance.v1", "dark");
      localStorage.setItem(
        `buzz-view.v1:${JSON.stringify([`${relay}:${viewer}`, "canvas-draft-v1:alpha"])}`,
        JSON.stringify({ content: "Local draft", base: "a".repeat(64) }),
      );
    },
    { viewer: app.viewer, relay: fixtureRelayUrl },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await openChannelDetails(page);
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  const workspace = page.locator("[data-panel-workspace]");
  const settingsTab = workspace.getByRole("tab", {
    name: "Channel settings",
    exact: true,
  });
  const trigger = page.getByRole("button", {
    name: "Channel actions",
    exact: true,
  });
  const openCanvas = async () => {
    await trigger.click();
    await page
      .getByRole("menuitem", { name: "View canvas", exact: true })
      .click();
  };
  const openEdit = async () => {
    await openCanvas();
    await expect(
      editor.getByRole("article", { name: "Saved Canvas" }),
    ).toBeVisible();
    await editor.getByRole("tab", { name: "Edit", exact: true }).click();
  };
  await openCanvas();
  const editor = workspace.getByRole("tabpanel", {
    name: "Canvas",
    exact: true,
  });
  const text = editor.getByRole("textbox", { name: "Canvas Markdown" });
  await expect(
    editor.getByRole("article", { name: "Saved Canvas" }),
  ).toBeVisible();
  await editor.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(text).toHaveValue("Local draft");
  const reload = editor.getByRole("button", { name: "Reload saved Canvas" });
  await reload.click();
  const confirmation = page.getByRole("dialog", {
    name: "Reload saved Canvas?",
    exact: true,
  });
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await expect(confirmation).toHaveCSS("backdrop-filter", "none");
  await expect(confirmation).toHaveCSS("background-color", "rgb(40, 40, 40)");
  await confirmation.getByRole("heading").click();
  await expect(confirmation).toBeVisible();
  const bounds = await confirmation.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + 30, bounds.y + 25);
  await page.mouse.down();
  await page.mouse.move(8, 8);
  await page.mouse.up();
  await expect(confirmation).toBeVisible();
  await confirmation.screenshot({
    path: testInfo.outputPath("canvas-reload-confirmation.png"),
  });
  await page.mouse.click(8, 8);
  await expect(confirmation).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(reload).toBeFocused();
  await expect(text).toHaveValue("Local draft");
  await page.mouse.click(8, 8);
  await expect(editor).toBeVisible();
  await expect(text).toHaveValue("Local draft");
  await workspace
    .getByRole("button", { name: "Close Canvas tab", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await expect(settingsTab).toBeFocused();
  await expect(settings).toBeVisible();
  await openEdit();
  await expect(text).toHaveValue("Local draft");
  expect(app.report.lifecyclePublications ?? []).toEqual([]);
});
