import { test, expect } from "./fixture.mjs";
import { activate, open } from "./timeline.mjs";

// Browser-only, as inline-openings.spec: real history events and sheet
// layout. The fixture plugins add a third-party link panel that matches
// every link and drills into a child, and a Solo chat to link to.
test.use({
  threadPlacement: "inline",
  pluginFixtures: true,
  productionBroker: true,
  dmLabels: true,
  agentPeers: true,
  soloChannels: ["beta"],
  channelWriteKinds: [9, 9000, 9007],
  historyCounts: { alpha: 2, beta: 2 },
});

const sheets = (page) => page.locator("[data-details-sheet-surface]");
const titled = (page, name) =>
  sheets(page).and(page.getByRole("dialog", { name, exact: true }));
const side = (page) => page.locator("[data-panel-workspace]");
// The visit's target, as the browser history entry records it.
const address = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry.target);

test("a plugin's link panel opens inline and drills in with a visit of its own", async ({
  page,
  app,
}) => {
  await open(page, app);
  app.append("primary", "alpha", "See [the notes](https://example.org/notes)");
  await activate(page.getByRole("link", { name: "the notes" }));
  const panel = titled(page, "Wrong panel");
  await expect(panel).toBeVisible();
  await expect(side(page).getByRole("tab")).toHaveCount(0);
  await panel.getByRole("button", { name: "Open child detail" }).click();
  await expect
    .poll(async () => (await address(page)).layer?.target)
    .toBe("https://example.org/notes:detail");
  await expect(titled(page, "Wrong panel")).toBeVisible();
  await page.goBack();
  await expect
    .poll(async () => (await address(page)).layer?.target)
    .toBe("https://example.org/notes");
  await expect(titled(page, "Wrong panel")).toBeVisible();
  await page.goBack();
  await expect(sheets(page)).toHaveCount(0);
  // The panel has no address, so Open as tab returns to the visit beneath
  // it, which had no tabs. Its tab still opens, selected.
  await page.goForward();
  await titled(page, "Wrong panel")
    .getByRole("button", { name: "Open as tab", exact: true })
    .click();
  await expect(sheets(page)).toHaveCount(0);
  await expect(
    side(page).getByRole("tab", { name: "Wrong panel", selected: true }),
  ).toBeVisible();
  await expect(
    side(page).getByRole("button", { name: "Open child detail" }),
  ).toBeVisible();
});

test("a Solo chat link goes to the chat instead of opening its tab", async ({
  page,
  app,
}) => {
  await open(page, app);
  app.append(
    "primary",
    "alpha",
    "Please review [the chat](buzz://channel/beta)",
  );
  await activate(page.getByRole("link", { name: "the chat" }));
  await expect.poll(async () => (await address(page)).channelId).toBe("beta");
  await expect(
    page.getByRole("article", { name: "Conversation", exact: true }),
  ).not.toContainText("Please review the chat");
  await expect(side(page).getByRole("tab")).toHaveCount(0);
  await page.goBack();
  await expect.poll(async () => (await address(page)).channelId).toBe("alpha");
});
