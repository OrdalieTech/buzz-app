import { closeSettings, settingsDialog } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ pluginFixtures: true });

test("a link preview that needs setup draws a card that opens its plugin's Settings, then swaps for real cards", async ({
  page,
  app,
}) => {
  await open(page, app);
  const message = app.append(
    "primary",
    "alpha",
    "Tracker https://tracker.example/ENG-1 and https://tracker.example/ENG-2",
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const setups = row.getByRole("button", {
    name: "Set up Tracker for previews tracker.example · Open Settings",
    exact: true,
  });
  await expect(setups).toHaveCount(2);
  await expect(setups.first()).toContainText("Set up Tracker for previews");
  await expect(row.locator("[data-tracker-card]")).toHaveCount(0);
  await row.screenshot({ path: test.info().outputPath("needs-setup.png") });

  await setups.first().click();
  const settings = settingsDialog(page);
  await expect(settings).toBeVisible();
  await settings
    .getByRole("button", { name: "Sign in to Tracker", exact: true })
    .click();
  await expect(settings.getByText("Signed in to Tracker")).toBeVisible();
  await closeSettings(page);

  await expect(setups).toHaveCount(0);
  await expect(row.locator("[data-tracker-card]")).toHaveText([
    "Tracker issue /ENG-1",
    "Tracker issue /ENG-2",
  ]);
  await row.screenshot({ path: test.info().outputPath("ready.png") });

  await page.evaluate(() => window.fixtureLinkSetup?.("checking"));
  await expect(row.locator("[data-tracker-card]")).toHaveCount(0);
  await expect(setups).toHaveCount(0);
  await page.evaluate(() => window.fixtureLinkSetup?.("needs-setup"));
  await expect(setups).toHaveCount(2);

  const previews = row.getByRole("group", { name: "Link previews" });
  await setups.first().focus();
  await page.evaluate(() => window.fixtureLinkSetup?.("checking"));
  await expect(setups).toHaveCount(0);
  await expect(previews).toBeFocused();
  await page.evaluate(() => window.fixtureLinkSetup?.("needs-setup"));
  await setups.last().focus();
  await page.evaluate(() => window.fixtureLinkSetup?.("ready"));
  await expect(row.locator("[data-tracker-card]")).toHaveCount(2);
  await expect(previews).toBeFocused();
});
