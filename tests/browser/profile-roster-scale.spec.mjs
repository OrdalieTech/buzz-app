import { generateSecretKey, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Main-thread cost of a large profile cache. A 9,000-member channel grows the
// cache to almost its 10,240 cap: the mention menu loads every member's
// profile, and leaving the channel shrinks the cache back to 1,024. A profile
// publish refolds the cache and wakes every listener, and the open menu
// re-ranks its whole roster, so this records the frame gaps of both steps.
const MEMBERS = 9_000;
const keys = Array.from({ length: MEMBERS }, () => generateSecretKey());
const members = keys.map((key) => getPublicKey(key));
const memberSet = new Set(members);
test.use({
  productionBroker: true,
  historyCounts: { alpha: 1, beta: 1 },
  sessionMembers: { alpha: members },
});

const probe = () => {
  const gaps = [];
  let last = performance.now();
  const tick = (now) => {
    gaps.push(now - last);
    last = now;
    window.__rosterFrames.handle = requestAnimationFrame(tick);
  };
  window.__rosterFrames = { gaps, handle: requestAnimationFrame(tick) };
};
const take = (page) =>
  page.evaluate(() => {
    const { gaps, handle } = window.__rosterFrames;
    cancelAnimationFrame(handle);
    return gaps;
  });
const summary = (gaps) => {
  const sorted = [...gaps].sort((a, b) => a - b);
  const round = (value) => Math.round(value * 10) / 10;
  return {
    frames: gaps.length,
    max: round(sorted.at(-1) ?? 0),
    p95: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    over33ms: gaps.filter((gap) => gap > 33.4).length,
    over50ms: gaps.filter((gap) => gap > 50).length,
    // Time past one 60 Hz frame, summed over the frames that missed it.
    jankMs: round(
      gaps.reduce((total, gap) => total + Math.max(0, gap - 16.7), 0),
    ),
  };
};
// Let a deferred shrink task and its publish run, then paint twice.
const drain = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
          100,
        ),
      ),
  );

test("the mention menu reads a 9,000-member roster once and leaving it stays smooth", async ({
  page,
  app,
}) => {
  test.setTimeout(240_000);
  for (const [index, key] of keys.entries())
    app.serveProfile(key, {
      name: `Member ${String(index).padStart(5, "0")}`,
    });
  const requested = new Map();
  let lastProfileResponse = 0;
  page.on("response", (response) => {
    if (!new URL(response.url()).pathname.endsWith("/query")) return;
    const filters = response.request().postDataJSON() ?? [];
    const roster = filters
      .filter((filter) => filter.kinds?.includes(0))
      .flatMap((filter) => filter.authors ?? [])
      .filter((id) => memberSet.has(id));
    if (!roster.length) return;
    for (const id of roster) requested.set(id, (requested.get(id) ?? 0) + 1);
    lastProfileResponse = Date.now();
  });
  await open(page, app);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await page.evaluate(probe);
  const typed = Date.now();
  await composer.fill("@");
  await expect(
    page.getByRole("listbox", { name: "Mention suggestions" }),
  ).toBeVisible();
  await expect.poll(() => requested.size, { timeout: 120_000 }).toBe(MEMBERS);
  // The last page's answer reached the page; let the app apply and paint it.
  await drain(page);
  const loadMs = lastProfileResponse - typed;
  const load = summary(await take(page));
  await composer.press("Escape");
  await composer.fill("");

  await page.evaluate(probe);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message #Beta", exact: true })
    .waitFor();
  await drain(page);
  const leave = summary(await take(page));

  const reads = app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(0) &&
      filter.authors?.some((id) => memberSet.has(id)),
  ).length;
  // Each member is read once: a page accepted but not yet published still
  // counts as loaded.
  expect([...requested.values()].filter((count) => count > 1)).toEqual([]);
  app.report.measurements.push({
    scenario: "profile roster scale",
    members: MEMBERS,
    rosterReads: reads,
    loadMs,
    load,
    leave,
  });
});
