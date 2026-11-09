import { fileURLToPath } from "node:url";
import { test as base, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";

const test = base.extend({
  syncUrl: [
    async ({ browserName }, use) => {
      if (!["chromium", "webkit"].includes(browserName))
        throw new Error("Unsupported sync test engine");
      const server = await createServer({
        root: fileURLToPath(new URL("../../", import.meta.url)),
        configFile: false,
        envDir: false,
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      try {
        await use(
          `${server.resolvedUrls.local[0]}tests/fixtures/artifact-sync.html`,
        );
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
});
async function open(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.artifactSyncTest);
  await page.evaluate(() => window.artifactSyncTest.open("collection-owner"));
}

// Real Web Locks and window teardown establish ownership. IndexedDB keeps shared progress.
test("syncs a follower-only collection and transfers a shared collection on window close", async ({
  page,
  context,
  syncUrl,
}) => {
  await open(page, syncUrl);
  await page.evaluate(() => window.artifactSyncTest.openCollection("main"));
  await expect
    .poll(() => page.evaluate(() => window.artifactSyncTest.checkpoint("main")))
    .not.toBeNull();
  const follower = await context.newPage();
  await open(follower, syncUrl);
  await follower.evaluate(() =>
    window.artifactSyncTest.openCollection("archive"),
  );
  await expect
    .poll(() =>
      follower.evaluate(() => window.artifactSyncTest.checkpoint("archive")),
    )
    .not.toBeNull();
  await follower.evaluate(() => window.artifactSyncTest.openCollection("main"));
  await expect
    .poll(() =>
      follower.evaluate(async () => {
        const locks = await navigator.locks.query();
        return { held: locks.held.length, pending: locks.pending.length };
      }),
    )
    .toEqual({ held: 2, pending: 1 });
  expect(await page.evaluate(() => window.artifactSyncTest.captures)).toEqual([
    "main",
  ]);
  expect(
    await follower.evaluate(() => window.artifactSyncTest.captures),
  ).toEqual(["archive"]);
  const before = await follower.evaluate(() =>
    window.artifactSyncTest.checkpoint("main"),
  );
  await page.close();
  await expect
    .poll(() => follower.evaluate(() => window.artifactSyncTest.captures))
    .toEqual(["archive", "main"]);
  await expect
    .poll(() =>
      follower.evaluate(() => window.artifactSyncTest.checkpoint("main")),
    )
    .not.toBe(before);
  expect(
    (await follower.evaluate(() => window.artifactSyncTest.read("main")))
      .preference,
  ).toEqual({ pinned: false });
});
