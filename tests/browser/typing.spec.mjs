import { test, expect } from "./fixture.mjs";
import { open, end, edge, keyScroll } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
});
test("Messages receives scoped typing through authenticated live traffic and expires it without publishing", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await expect
    .poll(() =>
      app.report.liveRequests.some((r) =>
        r.filters.some((filter) => filter["#h"]?.includes("alpha")),
      ),
    )
    .toBe(true);
  // Visible typing is presentation; the persistent live region announces it.
  const indicator = page
    .locator('[aria-hidden="true"]')
    .filter({ hasText: /(?:is|are) typing$/ });
  const announcement = page.getByRole("status", {
    name: "Conversation activity",
  });
  await expect(announcement).toBeEmpty();
  app.activity({ age: 9 });
  await expect(indicator).toHaveCount(0);
  app.activity();
  await expect(indicator).toContainText("is typing");
  app.activity({ author: 1 });
  await expect(indicator).toContainText("are typing");
  await expect(announcement).toContainText("are typing");
  await expect(indicator).not.toContainText("…");
  // Browser-only contracts: real geometry and the OS motion preference.
  const composer = page.getByRole("form", { name: "Send a message to Alpha" });
  const bounds = await indicator.boundingBox();
  const composerBounds = await composer.boundingBox();
  expect(bounds.y + bounds.height).toBeLessThan(composerBounds.y);
  const dots = indicator.locator('[aria-hidden="true"] > span');
  await expect(dots).toHaveCount(3);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(dots.first()).not.toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dots.first()).toHaveCSS("animation-name", "none");
  await page.screenshot({ path: testInfo.outputPath("messages-typing.png") });
  app.activity({ kind: 9 });
  await expect(indicator).toContainText("is typing");
  app.activity({ kind: 9, author: 1 });
  await expect(indicator).toHaveCount(0);
  app.activity(); // same-second late pulse cannot resurrect completion
  await expect(indicator).toHaveCount(0);
  await expect(announcement).toBeEmpty();
  // Typing completion precedes the appended messages' virtual-list layout.
  await expect(
    page.getByText("Fixture completion", { exact: true }),
  ).toHaveCount(2);
  await end(page);
  const root = app.histories
    .get("primary/alpha")
    .find((e) => e.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  app.activity({ root: root.id });
  await expect(
    thread.getByRole("status", { name: "Conversation activity" }),
  ).toContainText("is typing");
  await expect(indicator).toHaveCount(1);
  await expect(
    page
      .locator("[data-composer-dock]", { has: composer })
      .locator("..")
      .getByRole("status", { name: "Conversation activity" }),
  ).toBeEmpty();
  await page.screenshot({
    path: testInfo.outputPath("messages-thread-typing.png"),
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 800, height: 700 });
  // Stress the real label's CSS with an unbroken name, without adding profile
  // fixture/network machinery to a presentation-only regression.
  const label = indicator.locator(":scope > span").last();
  await label.evaluate((el) => {
    el.textContent = `${"LongDisplayName".repeat(30)} is typing`;
  });
  await expect(label).toHaveCSS("text-overflow", "ellipsis");
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  const narrowBounds = await indicator.boundingBox();
  const threadComposer = await thread.getByRole("form").boundingBox();
  expect(narrowBounds.x).toBeGreaterThanOrEqual(threadComposer.x);
  expect(narrowBounds.x + narrowBounds.width).toBeLessThanOrEqual(
    threadComposer.x + threadComposer.width,
  );
  expect(narrowBounds.y + narrowBounds.height).toBeLessThan(threadComposer.y);
  await page.screenshot({
    path: testInfo.outputPath("messages-thread-typing-dark-narrow.png"),
  });
  // Real browser timer, signed timestamp TTL, no polling transport or fixture cleanup.
  await expect(indicator).toHaveCount(0, { timeout: 10000 });
  await expect(
    thread.getByRole("status", { name: "Conversation activity" }),
  ).toBeEmpty();
  expect(app.report.publications).toEqual([]);
});

for (const scope of ["channel", "thread"]) {
  test(`${scope} typing preserves viewport bounds and the visible bottom through completion and expiry`, async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() =>
        app.report.liveRequests.some((r) =>
          r.filters.some((filter) => filter["#h"]?.includes("alpha")),
        ),
      )
      .toBe(true);
    const root = app.histories
      .get("primary/alpha")
      .find((e) => e.content === "Thread root 0");
    if (scope === "thread") {
      // Seed enough signed upstream replies to exercise a genuinely scrolling thread.
      for (let i = 0; i < 30; i++) app.reply(root.id);
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      // One nested descendant is collapsed; the root plus 32 direct replies mount.
      await expect(
        page
          .getByRole("region", { name: "Thread messages", exact: true })
          .locator("[data-message-id]"),
      ).toHaveCount(33);
    } else {
      await end(page);
    }
    const history = page.getByRole("region", {
      name: scope === "thread" ? "Thread messages" : "Channel message history",
      exact: true,
    });
    const composer = page.getByRole("form", {
      name: scope === "thread" ? "Reply to thread" : "Send a message to Alpha",
      exact: true,
    });
    // Activity floats beside the composer's dock, not inside it.
    const indicator = page
      .locator("[data-composer-dock]", { has: composer })
      .locator("..")
      .locator('[aria-hidden="true"]')
      .filter({ hasText: /is typing$/ });
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    if (scope === "thread") {
      // Opening can race the final signed fixture replies under parallel load.
      // Establish the bottom-reading precondition with real browser input before
      // capturing geometry; the assertions below verify typing keeps it there.
      // ThreadPanel re-pins only on a snapshot change, so a wheel that stopped
      // short would have no other way down: edge() waits for the gesture's
      // scrollend and asserts the bottom before the exact poll below.
      await edge(page, 1, history);
    }
    await expect.poll(gap).toBeLessThan(2);
    expect(
      await history.evaluate((el) => el.scrollHeight - el.clientHeight),
    ).toBeGreaterThan(100);
    // Real layout proves the channel and thread share the same composer gap.
    await edge(page, -1, history);
    const jump = history.locator("button[data-jump-to-latest]");
    await expect(jump).toBeVisible();
    await expect
      .poll(async () => {
        const button = await jump.boundingBox();
        const form = await composer.boundingBox();
        return form.y - button.y - button.height;
      })
      .toBe(12);
    // The shadow needs room inside the overflow clip, not just a correct button gap.
    const jumpBounds = await jump.boundingBox();
    const historyBounds = await history.boundingBox();
    expect(
      historyBounds.y + historyBounds.height - jumpBounds.y - jumpBounds.height,
    ).toBe(12);
    await jump.click();
    await expect(jump).toBeHidden();
    await expect.poll(gap).toBeLessThan(2);
    const bottomInset = await history.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).paddingBottom),
    );
    const idle = await history.boundingBox();
    const idleComposer = await composer.boundingBox();
    // The viewport meets the composer, but the final message has scrollable
    // breathing room. It must disappear with content, not remain a fixed strip.
    expect(Math.abs(idle.y + idle.height - idleComposer.y)).toBeLessThan(1);
    const endPadding = 32; // Room for the floating typing row and its gap.
    const tailGap = async () => {
      const tail = await history
        .locator("[data-message-id]")
        .last()
        .boundingBox();
      return idleComposer.y - tail.y - tail.height;
    };
    await expect.poll(tailGap).toBeGreaterThanOrEqual(endPadding - 1);
    await history.focus();
    await keyScroll(page, "PageUp", history);
    await expect(history).toBeFocused();
    expect(await gap()).toBeGreaterThan(100);
    expect(await history.boundingBox()).toEqual(idle);
    expect(await composer.boundingBox()).toEqual(idleComposer);
    // With the end spacer off-screen, an actual message reaches the lower edge.
    expect(
      await history.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll("[data-message-id]")].some(
          (row) => {
            const rect = row.getBoundingClientRect();
            return rect.top < bounds.bottom && rect.bottom >= bounds.bottom;
          },
        );
      }),
    ).toBe(true);
    // End must keep the reader's focus, even after the reply editor has held
    // a native caret. WebKit must not route it back into that blurred editor.
    await keyScroll(page, "End", history);
    await expect(history).toBeFocused();
    await expect.poll(gap).toBeLessThan(2);
    await expect.poll(tailGap).toBeGreaterThanOrEqual(endPadding - 1);
    await page.screenshot({
      path: testInfo.outputPath(`${scope}-composer-no-gap.png`),
    });
    const stable = async () => {
      expect(await history.boundingBox()).toEqual(idle);
      expect(await composer.boundingBox()).toEqual(idleComposer);
      await expect.poll(gap).toBeLessThan(2);
      await expect.poll(tailGap).toBeGreaterThanOrEqual(endPadding - 1);
      const tail = await history
        .locator("[data-message-id]")
        .last()
        .boundingBox();
      expect(tail.y).toBeGreaterThanOrEqual(idle.y - 2);
      expect(tail.y + tail.height).toBeLessThanOrEqual(
        idle.y + idle.height - bottomInset + 2,
      );
    };
    await expect(indicator).toHaveCount(0);
    const target = scope === "thread" ? { root: root.id } : {};
    app.activity(target);
    await expect(indicator).toContainText("is typing");
    const typingBounds = await indicator.boundingBox();
    // Activity now floats over history rather than reserving an idle strip.
    // It must stay inside the conversation and above the composer without
    // changing either viewport or the user's bottom-reading position.
    expect(typingBounds.y).toBeGreaterThanOrEqual(idle.y);
    expect(typingBounds.y + typingBounds.height).toBeLessThan(idleComposer.y);
    const tailBounds = await history
      .locator("[data-message-id]")
      .last()
      .boundingBox();
    expect(
      typingBounds.y - tailBounds.y - tailBounds.height,
    ).toBeGreaterThanOrEqual(2);
    await stable();
    app.activity({ ...target, kind: 9 });
    await expect(indicator).toHaveCount(0);
    await stable();
    // A different signer is outside the first signer's quiet period.
    app.activity({ ...target, author: 1 });
    await expect(indicator).toContainText("is typing");
    await stable();
    await expect(indicator).toHaveCount(0, { timeout: 10000 });
    await stable();
    expect(app.report.publications).toEqual([]);
  });
}

for (const scope of ["channel", "thread"]) {
  test(`a growing ${scope} composer lifts history with it at the bottom`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const history = page.getByRole("region", {
      name: scope === "thread" ? "Thread messages" : "Channel message history",
      exact: true,
    });
    if (scope === "thread") {
      const root = app.histories
        .get("primary/alpha")
        .find((e) => e.content === "Thread root 0");
      for (let i = 0; i < 30; i++) app.reply(root.id);
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect(history.locator("[data-message-id]")).toHaveCount(33);
    }
    await edge(page, 1, history);
    // Created after the app's observers, so it reports each resize as painted.
    await history.evaluate((element) => {
      window.composerGrowth = [];
      new ResizeObserver(() =>
        window.composerGrowth.push({
          viewport: element.clientHeight,
          gap: element.scrollHeight - element.clientHeight - element.scrollTop,
        }),
      ).observe(element);
    });
    // Wrapped text and new lines grow the composer, shrinking history above it.
    await page
      .getByRole("textbox", {
        name: scope === "thread" ? "Reply to thread" : "Message #Alpha",
        exact: true,
      })
      .click();
    await page.keyboard.type("Lorem ipsum dolor sit amet. ".repeat(8));
    for (const line of ["Second line", "Third line"]) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(line);
    }
    const growth = () => page.evaluate(() => window.composerGrowth);
    await expect
      .poll(async () => new Set((await growth()).map((s) => s.viewport)).size)
      .toBeGreaterThan(2);
    for (const sample of await growth())
      expect(sample.gap, `bottom at viewport ${sample.viewport}`).toBeLessThan(
        2,
      );
  });
}
