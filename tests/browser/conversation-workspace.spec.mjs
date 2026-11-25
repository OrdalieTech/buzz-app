import { test, expect } from "./fixture.mjs";
import { anchor, expectAnchor, open, settle, wheel } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 20 },
  viewport: { width: 1200, height: 650 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const thread = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });
const gap = (region) =>
  region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
const reselect = (page) =>
  page.getByRole("button", { name: "Reselect transcript" }).click();
const jump = (page) =>
  page.getByRole("button", { name: "Jump retained transcript" });

async function select(page, params) {
  expect(
    await page.evaluate(
      (params) =>
        window.fixtureNavigation.open({
          version: 1,
          kind: "page",
          pluginId: "fixture.session",
          pageId: "reader",
          route: { version: 1, params },
        }),
      params,
    ),
  ).toEqual({ status: "opened" });
}

async function expectBottom(page, region) {
  await expect.poll(() => gap(region)).toBeLessThan(4);
  await settle(page, region);
  expect(await gap(region)).toBeLessThan(4);
}

async function readEarlier(page, region) {
  await region.hover();
  // Linux WebKit can finish a wheel gesture short of the requested distance.
  let distance = await gap(region);
  for (let gesture = 0; gesture < 4; gesture++) {
    await wheel(page, -450, region);
    const next = await gap(region);
    expect(next, "reading gesture moves away from bottom").toBeGreaterThan(
      distance,
    );
    if (next > 200) return;
    distance = next;
  }
  expect(distance, "reading position is above bottom").toBeGreaterThan(200);
}

async function openReplyTab(app, region) {
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  await region
    .locator(`[data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  return root.content;
}

test("a workspace opens at the end on selection and reselect, and restores reading on Back and Forward", async ({
  page,
  app,
}) => {
  const region = history(page);
  await open(page, app);
  await readEarlier(page, region);

  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);
  await readEarlier(page, region);
  await reselect(page);
  await expectBottom(page, region);

  const replyTab = await openReplyTab(app, region);
  const side = page.locator("[data-panel-workspace]");
  const main = page.getByRole("tablist", { name: "Transcript fixture tabs" });
  await side.getByRole("tab", { name: replyTab }).press("Alt+Shift+ArrowLeft");
  const moved = main.getByRole("tab", { name: replyTab });
  await expect(moved).toHaveAttribute("aria-selected", "true");
  await reselect(page);
  await expect(
    main.getByRole("tab", { name: "Transcript fixture" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(moved).toBeVisible();
  await expectBottom(page, region);

  await readEarlier(page, region);
  const alpha = await anchor(page);

  await select(page, { channelId: "beta" });
  await expectBottom(page, region);
  await readEarlier(page, region);
  const beta = await anchor(page);

  await page.goBack();
  await expectAnchor(page, alpha);
  await page.goForward();
  await expectAnchor(page, beta);
});

test("reselect uncovers the transcript and keeps the narrow reply dock available", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.setViewportSize({ width: 900, height: 650 });
  const region = history(page);
  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);

  const replyTab = await openReplyTab(app, region);
  const side = page
    .locator("[data-panel-workspace]")
    .getByRole("tab", { name: replyTab });
  await expect(side).toBeVisible();
  await expect(region).toHaveCount(0);

  await side.focus();
  await expect(side).toBeFocused();
  // A plugin command can issue a request without taking focus from the dock.
  await jump(page).evaluate((button) => button.click());
  await expectBottom(page, region);
  const toggle = page.getByRole("button", { name: "Toggle tab pane" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(side).toBeVisible();
});

test("a gesture retires a queued latest request before new messages arrive", async ({
  page,
  app,
}) => {
  const region = history(page);
  await open(page, app);
  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);
  await readEarlier(page, region);

  const scroller = await region.elementHandle();
  // The fixture click commits the request synchronously. Send the input in
  // the same browser task, before the timeline's deferred scroll can run.
  await jump(page).evaluate((button, element) => {
    button.click();
    element.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
    );
  }, scroller);
  await settle(page, region);
  const reading = await anchor(page);
  expect(await gap(region)).toBeGreaterThan(200);

  app.append("primary", "alpha", "A message arrived while reading");
  await expect(
    region.getByRole("button", { name: "1 new message" }),
  ).toBeVisible();
  await settle(page, region);
  await expectAnchor(page, reading);
  expect(await gap(region)).toBeGreaterThan(200);
});

test.describe("thread workspace", () => {
  test.use({ exactMessages: true });

  test("reselect moves the retained reader to the end and an explicit reply still wins", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = thread(page);
    const target = { channelId: "alpha", threadId: app.exact.root.id };
    await select(page, target);
    await expectBottom(page, region);
    await readEarlier(page, region);
    await jump(page).click();
    await expectBottom(page, region);
    await readEarlier(page, region);

    const messageId = app.exact.replies.at(-20).id;
    await select(page, { ...target, messageId });
    await expect(
      region.locator(`[data-message-id="${messageId}"]`),
    ).toBeInViewport();
    await settle(page, region);
    expect(await gap(region)).toBeGreaterThan(200);
  });
});

test.describe("trailing card", () => {
  const card = (page) => page.getByRole("article", { name: "Fixture card" });
  // The card scrolls in its own sheet over the history.
  const sheet = (page) => card(page).locator("xpath=../..");
  const toggle = (page) => card(page).getByRole("button", { name: /brief/ });
  // The history, the sheet and the card, in viewport pixels.
  const place = (page) =>
    page.evaluate(() => {
      const card = document.querySelector('[aria-label="Fixture card"]');
      const sheet = card.parentElement.parentElement;
      const feed = document.querySelector("[data-message-scroller]");
      const rows = feed.querySelectorAll("[data-message-id]");
      const bounds = sheet.getBoundingClientRect();
      // The host's card box: the fixture's own margin is inside it.
      const box = card.parentElement.getBoundingClientRect();
      const style = getComputedStyle(feed);
      const left = feed.getBoundingClientRect().left + feed.clientLeft;
      const inner =
        feed.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      return {
        feedTop: feed.scrollTop,
        sheetTop: sheet.scrollTop,
        sheetMax: sheet.scrollHeight - sheet.clientHeight,
        spacer: sheet.firstElementChild.getBoundingClientRect().height,
        // The top of the card's box, where the spacer above it ends, below
        // the sheet's top.
        cardTop:
          sheet.firstElementChild.getBoundingClientRect().bottom - bounds.top,
        sheetBottom: bounds.bottom,
        footerBottom: card.querySelector("footer").getBoundingClientRect()
          .bottom,
        latestBottom: rows[rows.length - 1].getBoundingClientRect().bottom,
        cardScreenTop: box.top,
        // The card shares the history's measure and centre.
        offCentre:
          (box.left + box.right) / 2 -
          (left + Number.parseFloat(style.paddingLeft) + inner / 2),
      };
    });
  // Where Full brief grows the card to: 60px below the view's top.
  const full = (at) => Math.min(Math.max(0, at.spacer - 60), at.sheetMax);
  async function overCard(page, y = 30) {
    await card(page).hover({ position: { x: 60, y } });
  }
  // At Rest; at the latest message, unless `reading` earlier history.
  async function expectRest(page, region, reading = false) {
    await settle(page, sheet(page));
    await settle(page, region);
    const at = await place(page);
    expect(at.sheetTop).toBe(0);
    if (!reading) {
      expect(await gap(region)).toBeLessThan(2);
      expect(at.latestBottom).toBeLessThanOrEqual(at.cardScreenTop + 1);
    }
    await expect(toggle(page)).toHaveText("Full brief");
    return at;
  }

  test("a wheel over the card grows it, then slides it up, and the history stays", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(page)).toHaveText("Full brief");
    const rest = await expectRest(page, region);
    expect(Math.abs(rest.offCentre)).toBeLessThanOrEqual(1);
    // Its controls sit at the history's bottom edge.
    expect(Math.abs(rest.footerBottom - rest.sheetBottom)).toBeLessThanOrEqual(
      1,
    );

    await overCard(page);
    await wheel(page, 150, sheet(page));
    const grown = await place(page);
    expect(grown.sheetTop).toBeGreaterThan(50);
    expect(grown.sheetTop).toBeLessThan(grown.spacer);
    expect(grown.feedTop).toBe(rest.feedTop);
    expect(grown.footerBottom).toBe(rest.footerBottom);
    await expect(toggle(page)).toHaveText("Hide brief");

    // Above a growing card, the history scrolls and the card stays.
    const { x } = await card(page).boundingBox();
    await page.mouse.move(x + 60, grown.cardScreenTop - 40, { steps: 4 });
    await wheel(page, -300, region);
    const read = await place(page);
    expect(read.feedTop).toBeLessThan(rest.feedTop);
    expect(read.sheetTop).toBe(grown.sheetTop);

    // Past Full, the card slides up off the view's top.
    await overCard(page);
    await wheel(page, 3000, sheet(page));
    const slid = await place(page);
    expect(slid.cardTop).toBeLessThan(0);
    expect(slid.feedTop).toBe(read.feedTop);

    // Back down, the wheel stops at Rest and leaves the history.
    await overCard(page, 200);
    await wheel(page, -6000, sheet(page));
    const back = await expectRest(page, region, true);
    expect(back.feedTop).toBe(read.feedTop);

    // At Full, a new message shows Jump to latest in the gap above the card.
    // It returns the card to Rest below the message.
    await toggle(page).press("Enter");
    await expect(toggle(page)).toHaveText("Hide brief");
    await settle(page, sheet(page));
    app.append(
      "primary",
      "alpha",
      "Arrived while reading the card",
      true,
      false,
    );
    const pill = region.getByRole("button", { name: "1 new message" });
    await expect(pill).toBeInViewport();
    const { cardScreenTop } = await place(page);
    const at = await pill.boundingBox();
    expect(at.y).toBeGreaterThanOrEqual(cardScreenTop - 60);
    expect(at.y + at.height).toBeLessThanOrEqual(cardScreenTop);
    // Moving off the card, over the sheet's empty top, lets go of the sheet.
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, {
      steps: 4,
    });
    await pill.click();
    await expect(
      region.getByText("Arrived while reading the card"),
    ).toBeInViewport();
    await expectRest(page, region);
  });

  for (const brief of ["long", "short"])
    test(`Full brief grows the ${brief} card ${brief === "long" ? "to 60px below the top" : "to its end"}, and Hide brief returns`, async ({
      page,
      app,
    }) => {
      await open(page, app);
      const region = history(page);
      await select(page, { channelId: "alpha", trailing: brief });
      await expect(toggle(page)).toHaveText("Full brief");
      const rest = await expectRest(page, region);

      await toggle(page).press("Enter");
      await expect(toggle(page)).toHaveText("Hide brief");
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
      await settle(page, sheet(page));
      const shown = await place(page);
      expect(Math.abs(shown.sheetTop - full(shown))).toBeLessThanOrEqual(1);
      if (brief === "long")
        expect(Math.abs(shown.cardTop - 60)).toBeLessThanOrEqual(1);
      else expect(shown.cardTop).toBeGreaterThan(60);
      expect(shown.feedTop).toBe(rest.feedTop);
      expect(shown.footerBottom).toBe(rest.footerBottom);

      await toggle(page).press("Enter");
      await expectRest(page, region);
    });

  test("Full brief re-aims when the view shrinks during its scroll", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(page)).toHaveText("Full brief");
    const rest = await expectRest(page, region);
    // In the click's task, before its smooth scroll can arrive, the composer
    // grows, as its context row does when the card's draft lands.
    await page.evaluate(() => {
      document
        .querySelector('[aria-label="Fixture card"] button[aria-expanded]')
        .click();
      document.querySelector('[role="textbox"]').style.minHeight = "160px";
    });
    await expect(toggle(page)).toHaveText("Hide brief");
    await settle(page, sheet(page));
    const shown = await place(page);
    expect(shown.spacer).toBeLessThan(rest.spacer - 50);
    expect(Math.abs(shown.cardTop - 60)).toBeLessThanOrEqual(1);
  });

  test("Full brief re-aims when the card grows during its scroll", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "short" });
    await expect(toggle(page)).toHaveText("Full brief");
    const rest = await expectRest(page, region);
    // In the click's task, the card's content grows, as a loading brief does.
    await page.evaluate(() => {
      const card = document.querySelector('[aria-label="Fixture card"]');
      card.querySelector("button[aria-expanded]").click();
      card.style.paddingBottom = "300px";
    });
    await expect(toggle(page)).toHaveText("Hide brief");
    await settle(page, sheet(page));
    const shown = await place(page);
    expect(shown.sheetMax).toBeGreaterThan(rest.sheetMax + 250);
    // Where the card was going before it grew is short of its new Full.
    expect(full(shown)).toBeGreaterThan(rest.sheetMax + 1);
    expect(Math.abs(shown.sheetTop - full(shown))).toBeLessThanOrEqual(1);
  });

  test("Hide brief during Full brief's scroll returns the card to Rest", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(page)).toHaveText("Full brief");
    await expectRest(page, region);
    // Both in one task, before the first scroll lands.
    await page.evaluate(() => {
      const button = document.querySelector(
        '[aria-label="Fixture card"] button[aria-expanded]',
      );
      button.click();
      button.click();
    });
    await expectRest(page, region);
  });

  test("Full brief leaves a card too short to grow at Rest", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "none" });
    await expect(toggle(page)).toHaveText("Full brief");
    const rest = await expectRest(page, region);
    expect(rest.sheetMax).toBeLessThan(1);
    // No scroll follows, so the click itself settles the label.
    expect(
      await page.evaluate(() => {
        const button = document.querySelector(
          '[aria-label="Fixture card"] button[aria-expanded]',
        );
        button.click();
        return new Promise((resolve) =>
          requestAnimationFrame(() => resolve(button.textContent)),
        );
      }),
    ).toBe("Full brief");
    await expectRest(page, region);
  });

  test("a card that arrives after the history settles rests below the latest message", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha" });
    await expectBottom(page, region);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(page)).toHaveText("Full brief");
    await expectRest(page, region);
  });

  test("the card follows the message width setting", async ({ page, app }) => {
    await open(page, app);
    await select(page, { channelId: "alpha", trailing: "short" });
    await expect(toggle(page)).toHaveText("Full brief");
    // The card's box and the history's measure, left edge and width.
    const measures = () =>
      page.evaluate(() =>
        [
          document.querySelector('[aria-label="Fixture card"]').parentElement,
          // The history's top edge takes its measure.
          document.querySelector("[data-message-scroller]").firstElementChild,
        ].map((element) => {
          const { left, width } = element.getBoundingClientRect();
          return [Math.round(left), Math.round(width)];
        }),
      );
    const [, before] = await measures();
    // The setting changes the measure without resizing the history.
    await page.evaluate(() =>
      document.documentElement.style.setProperty(
        "--buzz-message-width",
        "30rem",
      ),
    );
    await expect
      .poll(async () => {
        const [card, rows] = await measures();
        return rows[1] < before[1] && card.join() === rows.join();
      })
      .toBe(true);
    // Compact density gives both the full width.
    await page.evaluate(() => {
      document.documentElement.dataset.messageDensity = "compact";
    });
    await expect
      .poll(async () => {
        const [card, rows] = await measures();
        return rows[1] > before[1] && card.join() === rows.join();
      })
      .toBe(true);
  });

  test("Full brief jumps without animation under reduced motion", async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(page)).toHaveText("Full brief");
    await expectRest(page, region);
    // Read in the click's task: an instant scroll has landed.
    const landed = await page.evaluate(() => {
      const card = document.querySelector('[aria-label="Fixture card"]');
      card.querySelector("button[aria-expanded]").click();
      return (
        card.parentElement.previousElementSibling.getBoundingClientRect()
          .bottom - card.parentElement.parentElement.getBoundingClientRect().top
      );
    });
    expect(Math.abs(landed - 60)).toBeLessThanOrEqual(1);
  });

  test("removing a grown card leaves no expanded state behind", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(page)).toHaveText("Full brief");
    await expectRest(page, region);
    await overCard(page);
    await wheel(page, 300, sheet(page));
    await expect(toggle(page)).toHaveText("Hide brief");

    await card(page).getByRole("button", { name: "Approve" }).click();
    await expect(card(page)).toHaveCount(0);
    expect(
      await region.evaluate((element) =>
        element.style.getPropertyValue("--timeline-trailing-rest"),
      ),
    ).toBe("");
    await settle(page, region);
    await readEarlier(page, region);
    await expect(
      region.getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeInViewport();
    // The next card starts collapsed.
    await select(page, { channelId: "alpha", trailing: "short" });
    await expect(toggle(page)).toHaveText("Full brief");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("keyboard selection stays above the card, and a grown card rests to show it", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = history(page);
    const focusedBottom = () =>
      page.evaluate(
        () => document.activeElement.getBoundingClientRect().bottom,
      );
    const focusedRow = () =>
      page.evaluate(
        () =>
          document.activeElement.closest("[data-message-id]")?.dataset
            .messageId,
      );
    await select(page, { channelId: "alpha", trailing: "long" });
    await expect(toggle(page)).toHaveText("Full brief");
    await expectRest(page, region);

    // The history can't scroll the newest message above a grown card.
    await toggle(page).press("Enter");
    await expect(toggle(page)).toHaveText("Hide brief");
    await settle(page, sheet(page));
    const input = page.getByRole("textbox", { name: "Message #Alpha" });
    await input.focus();
    await input.press("ArrowUp");
    await expect.poll(focusedRow).toBeTruthy();
    const rested = await expectRest(page, region);
    expect(await focusedBottom()).toBeLessThanOrEqual(rested.cardScreenTop + 1);

    // At Rest above the end, Arrow Down onto a row behind the card scrolls it
    // above the card.
    await readEarlier(page, region);
    await settle(page, region);
    const { cardScreenTop } = await place(page);
    const above = await region.evaluate((element, top) => {
      const rows = [...element.querySelectorAll("[data-message-id]")];
      const index = rows.findIndex(
        (row) => row.getBoundingClientRect().bottom > top + 1,
      );
      const row = rows[index - 1];
      const target = row.querySelector(":scope > [data-layout]") ?? row;
      target.tabIndex = -1;
      target.focus();
      return row.dataset.messageId;
    }, cardScreenTop);
    expect(await focusedRow()).toBe(above);
    await page.keyboard.press("ArrowDown");
    await expect.poll(focusedRow).not.toBe(above);
    await settle(page, region);
    expect(await focusedBottom()).toBeLessThanOrEqual(cardScreenTop + 1);
    expect((await place(page)).sheetTop).toBe(0);
  });

  test("the card's controls follow the history in keyboard order", async ({
    page,
    app,
    browserName,
  }) => {
    // macOS WebKit follows the host preference: Option-Tab includes every control.
    const back =
      browserName === "webkit" && process.platform === "darwin"
        ? "Shift+Alt+Tab"
        : "Shift+Tab";
    await open(page, app);
    const region = history(page);
    await select(page, { channelId: "alpha", trailing: "short" });
    await expect(toggle(page)).toHaveText("Full brief");
    await page.getByRole("textbox", { name: "Message #Alpha" }).focus();
    await page.keyboard.press(back);
    await expect(
      card(page).getByRole("button", { name: "Approve" }),
    ).toBeFocused();
    await page.keyboard.press(back);
    await expect(toggle(page)).toBeFocused();
    await page.keyboard.press(back);
    expect(
      await region.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  });

  test.describe(() => {
    // Without thread fixtures, the latest row is a top-level message.
    test.use({ threadUnread: false });

    test("a reveal of the latest message lands above the card", async ({
      page,
      app,
    }) => {
      await open(page, app);
      const region = history(page);
      await select(page, { channelId: "alpha", trailing: "long" });
      await expect(toggle(page)).toHaveText("Full brief");
      await expectRest(page, region);
      const messageId = await region.evaluate(
        (element) =>
          [...element.querySelectorAll("[data-message-id]")].at(-1).dataset
            .messageId,
      );
      await readEarlier(page, region);
      await overCard(page);
      await wheel(page, 150, sheet(page));
      await expect(toggle(page)).toHaveText("Hide brief");

      await select(page, { channelId: "alpha", trailing: "long", messageId });
      await expect(
        region.locator(`[data-message-id="${messageId}"]`),
      ).toBeInViewport();
      await expectRest(page, region);
    });

    test("a retained transcript's jump returns a grown card to Rest below the latest message", async ({
      page,
      app,
    }) => {
      await open(page, app);
      const region = history(page);
      await select(page, { channelId: "alpha", trailing: "long" });
      await expect(toggle(page)).toHaveText("Full brief");
      await expectRest(page, region);
      await readEarlier(page, region);
      await overCard(page);
      await wheel(page, 150, sheet(page));
      await expect(toggle(page)).toHaveText("Hide brief");

      await jump(page).click();
      await expectRest(page, region);
    });
  });

  test.describe(() => {
    test.use({ productionBroker: true });

    test("a send returns a grown card to Rest below the sent message", async ({
      page,
      app,
    }) => {
      await open(page, app);
      const region = history(page);
      await select(page, { channelId: "alpha", trailing: "long" });
      await expect(toggle(page)).toHaveText("Full brief");
      await expectRest(page, region);
      await overCard(page);
      await wheel(page, 3000, sheet(page));
      await expect(toggle(page)).toHaveText("Hide brief");

      const input = page.getByRole("textbox", { name: "Message #Alpha" });
      await input.fill("Sent below the card");
      await input.press("Enter");
      await expect(region.getByText("Sent below the card")).toBeInViewport();
      await expectRest(page, region);
    });
  });
});
