import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { animationsSettled } from "./animations.mjs";
import { readJournal } from "./reading.mjs";

test.use({
  productionBroker: true,
  readState: true,
  dmLabels: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// The browser boundary is the mounted app's sidebar, retained conversation,
// composer draft and search navigation across authoritative snapshot refreshes.
// Archive-state and participant matrices live in ChannelInventory.test.tsx.
test("archived one-to-one DMs leave the sidebar while history and open drafts survive", async ({
  page,
  app,
}, testInfo) => {
  const old = app.append(
    "primary",
    "dm-peer",
    "Preserved DM history",
    false,
    false,
  );
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const dm = sidebar.locator('[data-channel-id="dm-peer"]');
  const group = sidebar.locator('[data-channel-id="dm-group"]');
  await dm.click();
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const history = conversation.locator(`[data-message-id="${old.id}"]`);
  await expect(history).toContainText("Preserved DM history");
  const composer = conversation.getByRole("textbox", { name: /^Message / });
  await composer.fill("Keep this draft");
  // Archive evidence hides only a read DM; earn the real read first.
  const readThrough = async () =>
    (await readJournal(page))?.state.frontiers["dm-peer"] ?? 0;
  await expect.poll(readThrough).toBeGreaterThanOrEqual(old.created_at);

  const archiveReads = () =>
    app.report.queries.filter(({ filter }) => filter.kinds?.includes(13535))
      .length;
  expect(archiveReads()).toBe(1);
  const refresh = async (keys) => {
    const before = archiveReads();
    app.setArchivedIdentities(keys);
    app.relay.disconnect("primary");
    await expect.poll(archiveReads).toBeGreaterThan(before);
    await expect
      .poll(() => app.relay.hasRoute("primary", "dm-peer"))
      .toBe(true);
    expect(archiveReads()).toBe(before + 1);
  };
  await refresh([app.participants[0]]);
  await expect(dm).toHaveCount(0);
  await expect(group).toBeVisible();
  await expect(history).toContainText("Preserved DM history");
  await expect(composer).toHaveText("Keep this draft");
  await page.screenshot({
    path: testInfo.outputPath("archived-light-wide.png"),
  });

  // Hold replacement evidence across a real, unrelated membership revocation.
  // The retained relay-wide archive list must prevent even a temporary row.
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  const completed = Promise.withResolvers();
  let heldReads = 0;
  const holdArchive = async (route) => {
    const archive = route
      .request()
      .postDataJSON()
      .some((filter) => filter.kinds?.includes(13535));
    if (archive) {
      heldReads++;
      started.resolve();
      await released.promise;
    }
    await route.continue();
    if (archive) completed.resolve();
  };
  await page.evaluate(() => {
    window.archivedDmAppeared = false;
    window.archiveRowObserver = new MutationObserver(() => {
      window.archivedDmAppeared ||= !!document.querySelector(
        '[data-channel-id="dm-peer"]',
      );
    });
    window.archiveRowObserver.observe(document, {
      childList: true,
      subtree: true,
    });
  });
  await page.route("**/api/relay/primary/query", holdArchive);
  const beforeRevocation = archiveReads();
  try {
    app.relay.disconnect("primary");
    await started.promise;
    app.removeViewer("beta");
    await expect(sidebar.locator('[data-channel-id="beta"]')).toHaveCount(0);
    await expect(dm).toHaveCount(0);
    expect(heldReads).toBe(1);
    expect(await page.evaluate(() => window.archivedDmAppeared)).toBe(false);
  } finally {
    released.resolve();
    await completed.promise;
    await page.unroute("**/api/relay/primary/query", holdArchive);
    await page.evaluate(() => window.archiveRowObserver.disconnect());
  }
  await expect.poll(archiveReads).toBe(beforeRevocation + 1);
  await expect.poll(() => app.relay.hasRoute("primary", "dm-peer")).toBe(true);
  expect(archiveReads()).toBe(beforeRevocation + 1);

  // Reopening history from search must not override archive presentation.
  await sidebar.locator('[data-channel-id="alpha"]').click();
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search Buzz" });
  await search.getByRole("combobox", { name: "Search Buzz" }).fill("Alice");
  await search
    .getByRole("option")
    .filter({ hasText: "Alice Fixture" })
    .first()
    .click();
  await expect(history).toContainText("Preserved DM history");
  await expect(composer).toHaveText("Keep this draft");
  await expect(dm).toHaveCount(0);

  await page.reload();
  await expect(history).toContainText("Preserved DM history");
  await expect(dm).toHaveCount(0);
  await expect(group).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("buzz-appearance.v1", "dark");
  });
  await page.reload();
  await page.setViewportSize({ width: 1000, height: 850 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect(history).toContainText("Preserved DM history");
  await expect(dm).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("archived-dark-narrow-large-text.png"),
  });

  await refresh([]);
  await expect(dm).toBeVisible();
  await expect(history).toContainText("Preserved DM history");
  // An archived participant may still post. Keep unread content reachable
  // from the sidebar until the actual conversation read lifecycle clears it.
  await sidebar.locator('[data-channel-id="alpha"]').click();
  await expect(history).toHaveCount(0);
  await expect.poll(() => app.relay.hasRoute("primary", "dm-peer")).toBe(true);
  const incoming = app.append(
    "primary",
    "dm-peer",
    "Unread from archived Alice",
    true,
    false,
  );
  await expect(dm.locator("[data-channel-unread]")).toBeVisible();
  await refresh([app.participants[0]]);
  await expect(dm).toBeVisible();
  await expect(dm.locator("[data-channel-unread]")).toBeVisible();
  // Opening quiets the row at once, but leaving before read dwell must keep
  // the still-unread DM reachable. Pause time so dwell cannot elapse.
  const arrival = conversation.locator(`[data-message-id="${incoming.id}"]`);
  const base = Date.now();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 1_000);
  await dm.click();
  await expect(arrival).toContainText("Unread from archived Alice");
  await sidebar.locator('[data-channel-id="alpha"]').click();
  await expect(arrival).toHaveCount(0);
  await page.clock.resume();
  await expect(dm).toBeVisible();
  expect(await readThrough()).toBeLessThan(incoming.created_at);
  await dm.click();
  await expect(arrival).toContainText("Unread from archived Alice");
  await expect.poll(readThrough).toBeGreaterThanOrEqual(incoming.created_at);
  await expect(dm).toHaveCount(0);
  expect(app.histories.get("primary/dm-peer")).toContainEqual(old);
  expect(
    app.report.publications.filter(({ event }) =>
      [9002, 9008, 9009, 9010].includes(event.kind),
    ),
  ).toEqual([]);
});

// Browser HTTP availability and the live socket can recover independently.
// A fifth failed attempt proves the initial four-attempt window exhausted.
// Keep native animation time real; unit tests control retry deadlines.
test("archive visibility recovers after HTTP retries exhaust on a live connection", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.archiveOutage = { failing: false, attempts: 0 };
    window.fetch = (input, init) => {
      if (
        String(input).endsWith("/api/relay/primary/query") &&
        init?.body?.includes('"kinds":[13535]')
      ) {
        window.archiveOutage.attempts++;
        if (window.archiveOutage.failing)
          return Promise.reject(
            new TypeError("Fixture archive network outage"),
          );
      }
      return fetch(input, init);
    };
  });
  app.setArchivedIdentities([app.participants[0]]);
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const dm = sidebar.locator('[data-channel-id="dm-peer"]');
  await expect(sidebar.locator('[data-channel-id="dm-group"]')).toBeVisible();
  await expect(dm).toHaveCount(0);
  const primarySockets = () =>
    app.relay.sockets.filter((socket) => socket.community === "primary");
  const before = await page.evaluate(() => {
    window.archiveOutage.failing = true;
    return window.archiveOutage.attempts;
  });
  app.setArchivedIdentities([]);
  app.relay.disconnect("primary");
  await expect.poll(() => app.relay.hasRoute("primary", "dm-peer")).toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.archiveOutage.attempts))
    .toBeGreaterThanOrEqual(before + 5);
  const sockets = primarySockets().length;
  await expect(dm).toHaveCount(0);
  await page.evaluate(() => {
    window.archiveOutage.failing = false;
  });
  await expect(dm).toBeVisible();
  await animationsSettled(sidebar, { subtree: true });
  await expect(dm).toBeVisible();
  expect(primarySockets()).toHaveLength(sockets);
});
