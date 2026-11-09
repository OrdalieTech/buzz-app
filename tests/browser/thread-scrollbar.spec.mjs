import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { settlePanelMotion } from "./navigation.mjs";

// Real hit testing and native scrollbar input cannot be exercised in jsdom.
test.use({
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 30, beta: 1 },
});

async function openThread(page, app) {
  await open(page, app);
  const history = page.getByRole("region", { name: "Channel message history" });
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  await history
    .locator(`[data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const handle = page.getByRole("separator", {
    name: "Resize main and secondary panels",
  });
  await expect(handle).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await settlePanelMotion(page);
  await settle(page, history);
  return { history, handle };
}

test("thread divider leaves the channel edge available and still resizes", async ({
  page,
  app,
}) => {
  const { history, handle } = await openThread(page, app);
  const feed = await history.boundingBox();
  const grip = await handle.boundingBox();
  // Cover the entire scrollbar edge, including overlay scrollbars. The painted
  // capsule remains centered on the border; only its input area moves inward.
  expect(grip.x).toBeGreaterThanOrEqual(feed.x + feed.width);
  const edge = { x: feed.x + feed.width - 3, y: feed.y + feed.height / 2 };
  expect(
    await page.evaluate(
      ({ x, y }) =>
        !!document.elementFromPoint(x, y)?.closest("[data-panel-resize]"),
      edge,
    ),
  ).toBe(false);
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  try {
    await expect(handle).not.toHaveAttribute("data-resizing");
  } finally {
    await page.mouse.up();
  }
  const width = () =>
    handle.evaluate(
      (element) => element.parentElement.getBoundingClientRect().width,
    );
  const initial = await width();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  try {
    await expect(handle).toHaveAttribute("data-resizing", "");
    await page.mouse.move(
      grip.x + grip.width / 2 - 64,
      grip.y + grip.height / 2,
      { steps: 8 },
    );
  } finally {
    await page.mouse.up();
  }
  await expect.poll(width).toBeCloseTo(initial + 64, 0);
  await handle.press("ArrowRight");
  await expect.poll(width).toBeCloseTo(initial + 48, 0);
  await handle.dblclick();
  await expect.poll(width).toBeCloseTo(initial, 0);
});

test(
  "channel scrollbar thumb drags with a thread open and closed",
  { tag: "@classic-scrollbars" },
  async ({ page, app }, testInfo) => {
    test.skip(
      process.platform !== "linux" && !process.env.BUZZ_CLASSIC_SCROLLBARS,
      "Set BUZZ_CLASSIC_SCROLLBARS=1 on a Mac whose scrollbars take space",
    );
    const { history, handle } = await openThread(page, app);
    const readings = [];
    for (const threadOpen of [true, false]) {
      // The closing dock can stop rewrapping rows before its grid transition
      // ends. Wait for that motion before measuring the scrollbar's x position.
      await settlePanelMotion(page);
      await settle(page, history);
      const before = await history.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const gutter = element.offsetWidth - element.clientWidth;
        return {
          gutter,
          scrollTop: element.scrollTop,
          overflow: element.scrollHeight - element.clientHeight,
          x: rect.right - gutter / 2,
          y:
            rect.top +
            ((element.scrollTop + element.clientHeight / 2) *
              element.clientHeight) /
              element.scrollHeight,
        };
      });
      expect(
        before.gutter,
        "requires a real classic scrollbar",
      ).toBeGreaterThan(0);
      expect(before.overflow).toBeGreaterThan(200);
      expect(before.scrollTop).toBeGreaterThan(200);
      await page.mouse.move(before.x, before.y);
      await page.mouse.down();
      try {
        if (threadOpen)
          await expect(handle).not.toHaveAttribute("data-resizing");
        await page.mouse.move(before.x, before.y - 120, { steps: 12 });
      } finally {
        await page.mouse.up();
      }
      await expect
        .poll(() => history.evaluate((element) => element.scrollTop))
        .toBeLessThan(before.scrollTop - 100);
      await settle(page, history);
      readings.push({
        threadOpen,
        before,
        after: await history.evaluate((element) => element.scrollTop),
      });
      await testInfo.attach(
        threadOpen ? "thread-open-scrollbar" : "thread-closed-scrollbar",
        { body: await page.screenshot(), contentType: "image/png" },
      );
      if (threadOpen) {
        await page
          .locator(
            '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
          )
          .click();
        await expect(handle).toBeHidden();
      }
    }
    await testInfo.attach("scrollbar-drag", {
      body: JSON.stringify(readings, null, 2),
      contentType: "application/json",
    });
  },
);
