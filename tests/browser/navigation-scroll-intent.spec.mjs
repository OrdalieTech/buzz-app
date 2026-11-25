import { communitySwitcher, selectCommunity } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  largeSidebar: true,
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// Workspace migration POSTs two decodes to this URL (readPreferences in
// session.ts): the legacy workspaces first, as a bare event array, then the
// current preferences, wrapped with the legacy workspaces they merge. The
// journeys below let the legacy read finish and hold the current decode. A
// legacy read that fails leaves the current decode bare too, and nothing then
// tells the two apart. This also runs in the page, so it closes over nothing.
const isCurrentPrimaryDecode = (url, body) =>
  url.endsWith("/api/relay/primary/sidebar-preferences") &&
  JSON.parse(body ?? "null")?.legacy !== undefined;

for (const cachedStartup of [false, true]) {
  for (const action of [
    "untouched",
    "scrolled",
    "returned to top",
    "scroll event pending",
  ]) {
    test(`delayed sidebar restoration respects ${action} viewport (cached startup: ${cachedStartup})`, async ({
      page,
      app,
    }) => {
      await open(page, app);
      const sidebar = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      // Establish both the settled roster and preferences before saving the
      // warm layout that this journey optionally restores on startup.
      await expect(
        sidebar.locator('[data-sidebar-section="solo"]').getByRole("button", {
          name: "New Solo chat",
          exact: true,
        }),
      ).toBeEnabled();
      const panel = page.getByRole("complementary", {
        name: "Sidebar",
        exact: true,
      });
      await expect(panel).not.toHaveAttribute("aria-busy", "true");
      // Save a nonzero position, then cold-load that community with preferences held.
      await sidebar.evaluate((element) => {
        element.scrollTop = 900;
        element.dispatchEvent(new Event("scroll"));
      });
      await selectCommunity(page, "Personal space");
      await expect(communitySwitcher(page, "Personal space")).toBeVisible();
      // Preserve delayed-first-layout coverage on a genuine cold launch too.
      // Without a saved roster/preferences record, the first layout waits for
      // fresh preferences; the cached case intentionally restores immediately.
      await page.evaluate(async (keep) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("buzz-channel-heads-v1", 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction("startup", "readwrite");
          const store = tx.objectStore("startup");
          const request = store.getAll();
          request.onsuccess = () => {
            for (const row of request.result) {
              if (!keep) store.delete(row.key);
            }
          };
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, cachedStartup);
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const pendingRoutes = [];
      // The app gives up on a preferences read after 10 s (readPreferences in
      // session.ts), and the failed read ends the delay just as release()
      // would. A slow WebKit runner can reach the wheel below about 10 s after
      // the reload, and the saved position then lands first: 900 + 1800. This
      // test is about a held read, not that deadline. Playwright's clock
      // doesn't cover AbortSignal.timeout, so until Primary's current
      // preferences decode is issued, 10 s deadlines outlast the test; the
      // first such request restores the originals, leaving later deadlines
      // real. The legacy decode that precedes it is neither counted nor held,
      // and doesn't restore. Its read has a 5 s deadline of its own
      // (readLegacyWorkspaces), which a loaded runner misses without any hold,
      // so 5 s deadlines are stretched for the same window. (Deadlines created
      // before the current decode keep their stretched timer after the
      // restore, and if that decode never fires the patch dies with the page.)
      // Each stretched 10 s signal is tagged through AbortSignal.any, so the
      // guard below fails if the held request's signal didn't carry one (a
      // moved or renamed deadline), instead of the test silently flaking
      // again.
      const stretchDeadlines = (isCurrentDecode) => {
        const { timeout, any } = AbortSignal;
        const realFetch = window.fetch;
        const stretched = new WeakSet();
        const stretch = { currentDecodes: 0, stretchedDecodes: 0 };
        window.__sidebarDeadlineStretch = stretch;
        const restore = () => {
          AbortSignal.timeout = timeout;
          AbortSignal.any = any;
          window.fetch = realFetch;
        };
        AbortSignal.timeout = (ms) => {
          if (ms !== 10_000 && ms !== 5_000)
            return timeout.call(AbortSignal, ms);
          const signal = timeout.call(AbortSignal, 120_000);
          if (ms === 10_000) stretched.add(signal);
          return signal;
        };
        AbortSignal.any = (signals) => {
          const inputs = [...signals];
          const signal = any.call(AbortSignal, inputs);
          if (inputs.some((input) => stretched.has(input)))
            stretched.add(signal);
          return signal;
        };
        window.fetch = function (input, init) {
          const url = input instanceof Request ? input.url : String(input);
          if (isCurrentDecode(url, init?.body)) {
            stretch.currentDecodes++;
            const signal =
              init?.signal ??
              (input instanceof Request ? input.signal : undefined);
            if (signal && stretched.has(signal)) stretch.stretchedDecodes++;
            restore();
          }
          return realFetch.call(this, input, init);
        };
      };
      await page.addInitScript(
        `(${stretchDeadlines})(${isCurrentPrimaryDecode})`,
      );
      await page.route("**/api/relay/primary/sidebar-preferences", (route) => {
        const request = route.request();
        if (!isCurrentPrimaryDecode(request.url(), request.postData()))
          return route.continue();
        const pending = held.then(() => route.continue());
        pendingRoutes.push(pending);
        return pending;
      });
      try {
        await page.reload();
        await selectCommunity(page, "Primary");
        await expect
          .poll(() => sidebar.locator("[data-channel-id]").count())
          .toBeGreaterThan(100);
        await expect
          .poll(
            () => pendingRoutes.length,
            "Primary's legacy read finished, so its current decode carried the legacy workspaces and was held",
          )
          .toBeGreaterThan(0);
        await expect(panel).toHaveAttribute("aria-busy", "true");
        await expect(
          page.getByText("Updating sidebar details…", { exact: true }),
        ).toHaveCount(0);
        // Device preferences now restore the saved position before the held
        // network refresh. Subsequent user intent must still win over that refresh.
        await expect
          .poll(() => sidebar.evaluate((element) => element.scrollTop))
          .toBe(cachedStartup ? 900 : 0);
        if (action === "scroll event pending") {
          // Model compositor movement visible before the main-thread scroll
          // callback. The restoration must inspect the current position too.
          await page.evaluate(() => {
            document.addEventListener(
              "scroll",
              (event) => {
                if (
                  event.target instanceof HTMLElement &&
                  event.target.getAttribute("aria-label") ===
                    "Subscribed channels"
                )
                  event.stopImmediatePropagation();
              },
              true,
            );
          });
        }
        if (action !== "untouched") {
          await sidebar.hover({ position: { x: 10, y: 100 } });
          await page.mouse.wheel(0, cachedStartup ? 900 : 1800);
          await expect
            .poll(() => sidebar.evaluate((element) => element.scrollTop))
            .toBe(1800);
        }
        if (action === "returned to top") {
          await page.mouse.wheel(0, -1800);
          await expect
            .poll(() => sidebar.evaluate((element) => element.scrollTop))
            .toBe(0);
        }
        // Every held current decode carried a stretched deadline.
        expect(
          await page.evaluate(() => window.__sidebarDeadlineStretch),
          "Primary's held preferences decode carried the stretched 10 s deadline",
        ).toEqual({
          currentDecodes: pendingRoutes.length,
          stretchedDecodes: pendingRoutes.length,
        });
        const beforeRefresh = await sidebar.boundingBox();
        const refreshed = page.waitForResponse(
          (response) =>
            isCurrentPrimaryDecode(
              response.url(),
              response.request().postData(),
            ) && response.ok(),
        );
        release();
        await refreshed;
        // DOM settlement follows preference application and its layout effects;
        // the HTTP response alone is not a restoration barrier.
        await expect(panel).not.toHaveAttribute("aria-busy", "true");
        await expect
          .poll(() => sidebar.evaluate((element) => element.scrollTop))
          .toBe(
            action === "untouched"
              ? 900
              : action === "returned to top"
                ? 0
                : 1800,
          );
        expect(await sidebar.boundingBox()).toEqual(beforeRefresh);
      } finally {
        release();
        await Promise.all(pendingRoutes);
        await page.unroute("**/api/relay/primary/sidebar-preferences");
      }
    });
  }
}
