// A workspace's aside sits over the history's end edge, left of its scrollbar.
// Docked, the history's content and the composer keep to the width beside it;
// when the reader is narrow, it floats over the history while open.
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  historyCounts: { alpha: 640, beta: 3 },
  viewport: { width: 1280, height: 800 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
// The host's box around the plugin's content.
const aside = (page) => page.locator("[data-workspace-aside]");
const plan = (page) => page.getByRole("region", { name: "Fixture dashboard" });

async function openReader(page, params) {
  await expect
    .poll(() =>
      page.evaluate(async (params) => {
        const result = await window.fixtureNavigation
          ?.open({
            version: 1,
            kind: "page",
            pluginId: "fixture.session",
            pageId: "reader",
            route: { version: 1, params: { channelId: "alpha", ...params } },
          })
          .catch(() => undefined);
        return result?.status;
      }, params),
    )
    .toBe("opened");
}

async function openAside(page, params = {}) {
  await openReader(page, { aside: "tall", ...params });
  await expect(plan(page)).toBeVisible();
}

// The history, its list, the aside and the composer, in viewport pixels.
const layout = (page) =>
  history(page).evaluate((element) => {
    const box = (node) => {
      const { top, right, bottom, left, width, height } =
        node.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    const widget = document.querySelector("[data-workspace-aside]");
    const region = widget.querySelector("[data-fixture-aside-scroll]");
    return {
      history: box(element),
      scrollbar: element.offsetWidth - element.clientWidth,
      list: box(element.querySelector("ol")),
      aside: box(widget),
      reader: box(widget.previousElementSibling),
      composer: box(element.parentElement.querySelector("form")),
      region: {
        bottom: region.getBoundingClientRect().bottom,
        scrollHeight: region.scrollHeight,
        clientHeight: region.clientHeight,
        scrollTop: region.scrollTop,
      },
    };
  });

// The offset past the latest message, less any trailing card's growth.
const past = (region) =>
  region.evaluate((element) => {
    const content = element.querySelector(
      '[aria-label="Fixture card"]',
    )?.parentElement;
    const card = -Number.parseFloat(content?.style.bottom || "0");
    return (
      element.scrollTop -
      Math.max(0, element.scrollHeight - element.clientHeight - card)
    );
  });

test("a docked aside keeps the history and composer beside it", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openAside(page);
  const region = history(page);
  await settle(page, region);
  const at = await layout(page);
  expect(at.aside.width).toBe(320);
  expect(at.list.right).toBeLessThanOrEqual(at.aside.left);
  expect(at.composer.right).toBeLessThanOrEqual(at.aside.left + 1);
  // The composer stays centered under the history's rows. It spans the
  // frame and the list the scrollport, so a classic scrollbar moves the
  // list's center by half its width.
  expect(
    Math.abs(
      at.composer.left +
        at.composer.width / 2 -
        (at.list.left + at.list.width / 2) -
        at.scrollbar / 2,
    ),
  ).toBeLessThanOrEqual(2);
  // A tall plan runs from the history's top to the reader's bottom, beside
  // the composer, and scrolls itself.
  expect(Math.abs(at.aside.top - at.history.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(at.aside.bottom - at.reader.bottom)).toBeLessThanOrEqual(1);
  expect(at.aside.bottom).toBeGreaterThan(at.composer.bottom);
  expect(at.region.scrollHeight).toBeGreaterThan(at.region.clientHeight);

  // Wheeling over the plan scrolls only the plan.
  const offset = await region.evaluate((element) => element.scrollTop);
  await plan(page).hover();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 120);
  await expect
    .poll(async () => (await layout(page)).region.scrollTop)
    .toBeGreaterThan(100);
  expect(await region.evaluate((element) => element.scrollTop)).toBe(offset);

  // Scrolled to its end, the plan's card ends inside the box and the window.
  await plan(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const end = await layout(page);
  expect(end.region.scrollTop).toBeGreaterThanOrEqual(
    end.region.scrollHeight - end.region.clientHeight - 1,
  );
  expect(end.region.bottom).toBeLessThan(end.aside.bottom);
  expect(end.aside.bottom).toBeLessThanOrEqual(page.viewportSize().height);
  await expect(plan(page).getByText("End of plan")).toBeInViewport();

  // The page's control hides it, and the rows take the width back.
  await page.getByRole("button", { name: "Hide plan" }).click();
  await expect(plan(page)).toBeHidden();
  await expect
    .poll(async () =>
      history(page).evaluate(
        (element) => element.querySelector("ol").getBoundingClientRect().right,
      ),
    )
    .toBeGreaterThan(at.aside.left + 100);
});

test("the history's scrollbar stays at the reader's end, right of a docked aside", {
  tag: "@classic-scrollbars",
}, async ({ page, app }) => {
  test.skip(
    process.platform !== "linux" && !process.env.BUZZ_CLASSIC_SCROLLBARS,
    "Set BUZZ_CLASSIC_SCROLLBARS=1 on a Mac whose scrollbars take space",
  );
  await open(page, app);
  await openAside(page);
  const region = history(page);
  await settle(page, region);
  const at = await layout(page);
  // The history spans the reader, and its scrollport runs under the aside.
  expect(Math.abs(at.history.right - at.reader.right)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(at.aside.right - (at.history.right - at.scrollbar)),
  ).toBeLessThanOrEqual(1);
  // The scrollbar beside the aside belongs to the history.
  expect(at.scrollbar).toBeGreaterThan(0);
  expect(
    await region.evaluate(
      (element, { x, y }) => element === document.elementFromPoint(x, y),
      {
        x: at.history.right - at.scrollbar / 2,
        y: (at.aside.top + at.aside.bottom) / 2,
      },
    ),
  ).toBe(true);
});

test("the wheel beside or below a short docked plan scrolls the history", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openAside(page, { aside: "short" });
  const region = history(page);
  await settle(page, region);
  const at = await layout(page);
  const card = await plan(page).boundingBox();
  // The box sizes to the plan's card, which leaves the column below it empty.
  expect(at.aside.bottom).toBeLessThan(at.history.bottom - 100);
  for (const point of [
    // Below the card.
    { x: card.x + card.width / 2, y: at.aside.bottom + 60 },
    // In the card's margin, inside the aside's box.
    { x: at.aside.left + 3, y: card.y + card.height / 2 },
  ]) {
    const before = await region.evaluate((element) => element.scrollTop);
    await page.mouse.move(point.x, point.y);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
    await expect
      .poll(() => region.evaluate((element) => element.scrollTop))
      .toBeLessThan(before - 100);
  }
});

test("an aside's popover escapes over the history", async ({ page, app }) => {
  await open(page, app);
  await openAside(page);
  await settle(page, history(page));
  await plan(page).getByRole("button", { name: "Details" }).click();
  const popup = page.getByText("Step details escape the Plan");
  await expect(popup).toBeVisible();
  const shown = await popup.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const x = box.left + 8;
    const y = box.top + box.height / 2;
    return {
      left: box.left,
      asideLeft: document
        .querySelector("[data-workspace-aside]")
        .getBoundingClientRect().left,
      // It sits above the history's rows under it.
      onTop: node.contains(document.elementFromPoint(x, y)),
    };
  });
  expect(shown.left).toBeLessThan(shown.asideLeft - 20);
  expect(shown.onTop).toBe(true);
});

test("adding and removing the aside keeps the reader at the latest message", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openReader(page, {});
  const region = history(page);
  await settle(page, region);
  expect(Math.abs(await past(region))).toBeLessThanOrEqual(1);
  // The same scroller stays mounted throughout.
  await region.evaluate((element) => {
    window.asideScroller = element;
  });
  const same = () =>
    region.evaluate((element) => element === window.asideScroller);
  // As a plugin does when its content arrives, without a navigation.
  await page.evaluate(() => window.fixtureAside("tall"));
  await expect(plan(page)).toBeVisible();
  await settle(page, region);
  expect(Math.abs(await past(region))).toBeLessThanOrEqual(1);
  expect(await same()).toBe(true);
  await page.evaluate(() => window.fixtureAside(null));
  await expect(aside(page)).toHaveCount(0);
  await settle(page, region);
  expect(Math.abs(await past(region))).toBeLessThanOrEqual(1);
  expect(await same()).toBe(true);
});

test("a narrow reader floats the aside over the history while the page opens it", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openAside(page);
  const region = history(page);
  await settle(page, region);
  const docked = (await layout(page)).list.width;
  // Narrowing closes it, and the history takes the full width.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(plan(page)).toBeHidden();
  const show = page.getByRole("button", { name: "Show plan" });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  // The page hears that the aside floats.
  await expect(show).toHaveAttribute("data-aside-floating", "true");
  const closed = await layout(page);
  expect(
    Math.abs(closed.history.right - closed.reader.right),
  ).toBeLessThanOrEqual(1);
  const full = await region.evaluate((element) => element.clientWidth);

  // Opened, it floats over the history's end edge, not the composer, takes
  // no width, holds focus, and scrolls its own content. WebKit doesn't focus
  // a clicked button, so the control opens it from the keyboard.
  await show.focus();
  await page.keyboard.press("Enter");
  await expect(plan(page)).toBeVisible();
  await expect(aside(page)).toBeFocused();
  await settle(page, region);
  const at = await layout(page);
  expect(at.aside.top).toBeGreaterThanOrEqual(at.history.top);
  expect(at.aside.bottom).toBeLessThanOrEqual(at.history.bottom);
  expect(at.aside.bottom).toBeLessThanOrEqual(at.composer.top);
  expect(at.aside.right).toBeLessThanOrEqual(at.history.right - at.scrollbar);
  expect(await region.evaluate((element) => element.clientWidth)).toBe(full);
  const offset = await region.evaluate((element) => element.scrollTop);
  await plan(page).hover();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 120);
  await expect
    .poll(async () => (await layout(page)).region.scrollTop)
    .toBeGreaterThan(100);
  expect(await region.evaluate((element) => element.scrollTop)).toBe(offset);

  // Scrolled to its end, the plan's card ends inside the box and the window.
  await plan(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const end = await layout(page);
  expect(end.region.scrollTop).toBeGreaterThanOrEqual(
    end.region.scrollHeight - end.region.clientHeight - 1,
  );
  expect(end.region.bottom).toBeLessThan(end.aside.bottom);
  expect(end.aside.bottom).toBeLessThanOrEqual(page.viewportSize().height);
  await expect(plan(page).getByText("End of plan")).toBeInViewport();

  // Escape closes only the overlay and returns focus to the page's control.
  await page.keyboard.press("Escape");
  await expect(plan(page)).toBeHidden();
  await expect(show).toBeFocused();
  // A press on the history closes it too.
  await show.click();
  await expect(plan(page)).toBeVisible();
  await region.click({ position: { x: 40, y: 40 } });
  await expect(plan(page)).toBeHidden();

  // Widening docks it again, restoring the docked state.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(plan(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide plan" })).toHaveAttribute(
    "data-aside-floating",
    "false",
  );
  await expect
    .poll(async () => (await layout(page)).list.width)
    .toBeCloseTo(docked, 0);
  await settle(page, region);
  expect(Math.abs(await past(region))).toBeLessThanOrEqual(1);
});

test("a live resize beside an aside keeps the reader at rest", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openAside(page, { trailing: "long" });
  const region = history(page);
  await settle(page, region);
  expect(Math.abs(await past(region))).toBeLessThanOrEqual(1);
  // A window drag resizes faster than the timeline renders, undocking and
  // docking the aside and rewrapping the card as it goes.
  for (const [from, to] of [
    [1280, 860],
    [860, 1320],
  ]) {
    for (let step = 1; step <= 30; step++)
      await page.setViewportSize({
        width: Math.round(from + ((to - from) * step) / 30),
        height: 800,
      });
    await settle(page, region);
    expect(
      Math.abs(await past(region)),
      `at rest after resizing to ${to}`,
    ).toBeLessThanOrEqual(1);
  }
});

test.describe("in a thread", () => {
  test.use({
    readState: true,
    threadUnread: true,
    historyCounts: { alpha: 40, beta: 3 },
  });

  test("a thread target docks the aside over the thread's end edge", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    await openAside(page, { threadId: root.id });
    const thread = aside(page)
      .locator("xpath=preceding-sibling::*[1]")
      .locator("[data-message-scroller]");
    await expect(thread).toBeVisible();
    const at = await thread.evaluate((element) => {
      const box = (node) => node.getBoundingClientRect().toJSON();
      const widget = document.querySelector("[data-workspace-aside]");
      return {
        thread: box(element),
        scrollbar: element.offsetWidth - element.clientWidth,
        rows: box(element.querySelector("[data-thread-rows]")),
        composer: box(
          widget.previousElementSibling.querySelector(
            '[contenteditable="true"]',
          ),
        ),
        aside: box(widget),
        reader: box(widget.previousElementSibling),
      };
    });
    expect(at.aside.width).toBe(320);
    expect(at.rows.right).toBeLessThanOrEqual(at.aside.left);
    expect(Math.abs(at.thread.right - at.reader.right)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(at.aside.right - (at.thread.right - at.scrollbar)),
    ).toBeLessThanOrEqual(1);
    expect(at.aside.top).toBeGreaterThanOrEqual(at.thread.top - 1);
    expect(at.composer.right).toBeLessThanOrEqual(at.aside.left + 1);
    expect(at.aside.bottom).toBeLessThanOrEqual(at.reader.bottom + 1);
  });
});

test.describe("beside a narrow dock", () => {
  test.use({
    readState: true,
    threadUnread: true,
    historyCounts: { alpha: 40, beta: 3 },
    viewport: { width: 600, height: 800 },
  });

  test("a narrow dock covers the floating aside", async ({ page, app }) => {
    await open(page, app);
    await openReader(page, { aside: "tall" });
    const region = history(page);
    await settle(page, region);
    await page.getByRole("button", { name: "Show plan" }).click();
    await expect(plan(page)).toBeVisible();
    const box = await plan(page).boundingBox();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    const row = region.locator(`[data-message-id="${root.id}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.hover({ position: { x: 24, y: 8 } });
    // A click alone, as a press on the history would close the overlay.
    await row
      .getByRole("button", { name: /^View thread:/ })
      .dispatchEvent("click");
    const dock = page.locator("[data-panel-dock]");
    await expect(dock).toBeVisible();
    await dock.evaluate((element) =>
      Promise.allSettled(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
    // The dock paints over the overlay. Hit testing skips the covered, inert
    // reader, so the probe lifts that while it reads the paint order.
    expect(
      await page.evaluate(({ x, y }) => {
        const widget = document.querySelector("[data-workspace-aside]");
        const covered = widget.closest("[inert]");
        covered?.removeAttribute("inert");
        const hit = document.elementFromPoint(x, y);
        covered?.setAttribute("inert", "");
        return {
          open: !widget.hidden,
          covered: !!covered,
          docked: !!hit?.closest("[data-panel-dock]"),
        };
      }, center),
    ).toEqual({ open: true, covered: true, docked: true });
  });
});
