import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { clickRow, open, settle } from "./timeline.mjs";

// Browser-only: the inline thread and details are dialogs on the conversation
// visit. Only real history events, layout around a composer and the composer's
// draft storage across a remount prove them. Address parsing and the setting
// are covered by their unit tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
});

const roots = (app) =>
  app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
const viewThread = (page, root) =>
  page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
const threadHeading = (page) =>
  page.getByRole("heading", { name: "Thread", exact: true });
const sheet = (page) =>
  page
    .locator("[data-details-sheet-surface]")
    .filter({ has: threadHeading(page) });
// A details sheet holds no thread of its own.
const detailsSheet = (page) =>
  page
    .locator("[data-details-sheet-surface]")
    .filter({ hasNot: threadHeading(page) });
const threadTab = (page, root) =>
  page.locator(`[role="tab"][data-tab-value="thread:alpha:${root.id}"]`);
const reply = (scope) =>
  scope.getByRole("textbox", { name: "Reply to thread", exact: true });
const side = (page) => page.locator("[data-panel-workspace]");
const filler = "More of it follows here. ".repeat(30);
/** A peer's details message: in `root`'s thread, or the channel's own. */
const details = (app, text, root) =>
  app.append(
    "primary",
    "alpha",
    `${text}\n\n${filler}`,
    true,
    false,
    root?.id,
    undefined,
    [["audience", "details"]],
  );
const showMore = (scope, text) =>
  scope
    .locator("[data-message-id]")
    .filter({ hasText: text })
    .getByRole("button", { name: "Show more", exact: true });
const close = (scope) =>
  scope.getByRole("button", { name: "Close", exact: true }).first();
/** In a thread, Show more expands the details in place: no sheet or dialog
 * opens over the view, so its reply box stays in reach, and Show less folds
 * them back. `dialogs` counts the dialogs the view itself is drawn in. */
const expandsInPlace = async (page, scope, text, dialogs = 0) => {
  const row = scope.locator("[data-message-id]").filter({ hasText: text });
  const whole = () =>
    row
      .getByText(filler.trim())
      .evaluate((element) => element.scrollHeight <= element.clientHeight + 1);
  await expect.poll(whole).toBe(false);
  await row.getByRole("button", { name: "Show more", exact: true }).click();
  const less = row.getByRole("button", { name: "Show less", exact: true });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect.poll(whole).toBe(true);
  await expect(detailsSheet(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(dialogs);
  await less.click();
  await expect.poll(whole).toBe(false);
};

test.describe("Side panel", () => {
  test.use({ threadPlacement: "side" });

  test("a thread still opens in its tab", async ({ page, app }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toBeVisible();
    await expect(reply(side(page))).toBeFocused();
    await expect(sheet(page)).toHaveCount(0);
  });

  test("details in a thread tab expand in place beside its reply box", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toBeVisible();
    details(app, "Tab findings", root);
    await expandsInPlace(page, side(page), "Tab findings");
    await expect(reply(side(page))).toBeVisible();
    // Expanded, a wide table scrolls inside the bubble, not past its edge,
    // even one that was hidden while collapsed.
    const cell = "a long cell that will not wrap ".repeat(6);
    details(
      app,
      `Wide findings\n\nHidden until expanded.\n\n| A | B |\n| - | - |\n| ${cell} | ${cell} |`,
      root,
    );
    const wide = side(page)
      .locator("[data-message-id]")
      .filter({ hasText: "Wide findings" });
    await wide.getByRole("button", { name: "Show more", exact: true }).click();
    await expect(
      wide.getByRole("button", { name: "Show less", exact: true }),
    ).toBeVisible();
    const right = (locator) =>
      locator.evaluate((element) => element.getBoundingClientRect().right);
    expect(await right(wide.getByRole("table"))).toBeLessThanOrEqual(
      await right(wide.locator("[data-bubble]")),
    );
    // A wheel scrolls it; a clipped table with overflow hidden would not.
    const table = wide.getByRole("table");
    await table.hover();
    await expect
      .poll(async () => {
        await page.mouse.wheel(200, 0);
        return table.evaluate((element) => element.scrollLeft);
      })
      .toBeGreaterThan(0);
  });
});

test.describe("Inline", () => {
  test.use({ threadPlacement: "inline" });

  test("a thread opens over the composer and follows the dialog contract", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const beta = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .locator('button[data-channel-id="beta"]');
    const alpha = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .locator('button[data-channel-id="alpha"]');
    await beta.click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta" }),
    ).toBeVisible();
    await alpha.click();
    await settle(page);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    await expect(reply(sheet(page))).toBeFocused();
    await expect(threadTab(page, root)).toHaveCount(0);
    // Back closes the dialog and stays in the channel; Forward reopens it.
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha" }),
    ).toBeVisible();
    await page.goForward();
    await expect(sheet(page)).toBeVisible();
    // X retires it: Back leaves the channel with no redundant Alpha stop.
    await close(sheet(page)).click();
    await expect(sheet(page)).toHaveCount(0);
    await page.goBack();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta" }),
    ).toBeVisible();
    await page.goForward();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha" }),
    ).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    // Opening another thread replaces the inline one; Escape closes it.
    await clickRow(page, viewThread(page, roots(app)[1]));
    await expect(sheet(page).getByText("Unread reply 1")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
  });

  test("the conversation's jump control hides under the sheet, not the sheet's own", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const display = (locator) =>
      locator.evaluate(
        (button) => getComputedStyle(button.closest("[data-visible]")).display,
      );
    const conversationJump = page.locator(
      "[data-channel-timeline] button[data-jump-to-latest]",
    );
    await expect.poll(() => display(conversationJump)).not.toBe("none");
    await clickRow(page, viewThread(page, roots(app)[0]));
    await expect(sheet(page)).toBeVisible();
    await expect.poll(() => display(conversationJump)).toBe("none");
    const sheetJump = sheet(page).locator("button[data-jump-to-latest]");
    await expect.poll(() => display(sheetJump)).not.toBe("none");
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    await expect.poll(() => display(conversationJump)).not.toBe("none");
  });

  test("details in the inline thread expand in place: Back closes the thread", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page)).toBeVisible();
    details(app, "Nested findings", root);
    await expandsInPlace(page, sheet(page), "Nested findings", 1);
    await expect(reply(sheet(page))).toBeVisible();
    // Opening long details at the latest reply keeps their start in view,
    // rather than following the latest reply past it.
    app.append(
      "primary",
      "alpha",
      `Long findings\n\n${`${filler}\n\n`.repeat(6)}`,
      true,
      false,
      root.id,
      undefined,
      [["audience", "details"]],
    );
    // The pointer still rests where the last Show more was. The new reply can
    // land under it, and its hover actions then cover its own Show more.
    await page.mouse.move(0, 0);
    await showMore(sheet(page), "Long findings").click();
    await expect(sheet(page).getByText("Long findings")).toBeInViewport();
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
  });

  test("a thread sheet opens around the fixed composer and draws its thread in one frame", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [, long] = roots(app);
    for (let index = 0; index < 30; index++) app.reply(long.id, false, false);
    const composer = page.locator("[data-message-composer]").first();
    const before = await composer.boundingBox();
    // The thread's reads land well after the open motion ends, as a slow
    // relay's would.
    await page.route("**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (filters.some((filter) => filter["#e"]?.includes(long.id)))
        await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    // Every frame from the click on: whether the thread shows, and what of
    // it is there to show.
    await page.evaluate(() => {
      const frames = [];
      window.__sheetFrames = frames;
      const sample = () => {
        const surface = document.querySelector("[data-details-sheet-surface]");
        const body = surface?.querySelector("[data-sheet-body]");
        if (body)
          frames.push({
            shown: getComputedStyle(body).opacity === "1",
            rows: body.querySelectorAll(
              "[data-message-scroller] [data-message-id]",
            ).length,
            reply: !!surface.querySelector(
              '[data-message-composer] [role="textbox"]',
            ),
            positioning: !!body.querySelector("[data-positioning]"),
            composerTop: document
              .querySelector("[data-composer-above], [data-composer-covered]")
              ?.getBoundingClientRect().top,
          });
        // Until well after it shows: a loaded machine can take seconds to
        // get there, so the frames are not capped by count.
        const shown = frames.findIndex((frame) => frame.shown);
        if (shown < 0 || frames.length - shown < 30)
          requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await clickRow(page, viewThread(page, long));
    await expect(reply(sheet(page))).toBeFocused();
    // Focus can land before the next frame is sampled: wait for the frames
    // after the thread first shows.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const frames = window.__sheetFrames;
          const shown = frames.findIndex((frame) => frame.shown);
          return shown >= 0 && frames.length - shown >= 30;
        }),
      )
      .toBe(true);
    const frames = await page.evaluate(() => window.__sheetFrames);
    const first = frames.findIndex((frame) => frame.shown);
    expect(first).toBeGreaterThan(0);
    // Hidden until it is ready, then drawn whole: rows, reply box and
    // position all land in the frame it first shows.
    expect(frames[first]).toMatchObject({ reply: true, positioning: false });
    expect(frames[first].rows).toBeGreaterThan(10);
    for (const frame of frames.slice(first))
      expect(frame).toMatchObject({ shown: true, reply: true });
    // The view's composer holds still while the sheet rises around it.
    for (const frame of frames.slice(0, first))
      if (frame.composerTop !== undefined)
        expect(Math.abs(frame.composerTop - before.y)).toBeLessThan(1);
  });

  test("a thread sheet starts at its header's edge and fades into its own surface", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [short, long] = roots(app);
    await clickRow(page, viewThread(page, short));
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    // The first row's name starts where the header's material ends: the
    // row's own top padding lies under that fade, not below it.
    const lead = (surface) =>
      Math.abs(
        surface
          .querySelector("[data-message-scroller] [data-message-author]")
          .getBoundingClientRect().top -
          surface
            .querySelector("header .buzz-dialog-bar-material")
            .getBoundingClientRect().bottom,
      );
    await expect.poll(() => sheet(page).evaluate(lead)).toBeLessThan(4);
    const room = (element) =>
      Number.parseFloat(getComputedStyle(element).maxHeight) -
      element.getBoundingClientRect().height;
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    for (let index = 0; index < 30; index++) app.reply(long.id, false, false);
    await clickRow(page, viewThread(page, long));
    await expect(sheet(page).getByText("Unread reply 1")).toBeVisible();
    // A long one takes the maximum and reads up from its reply box.
    await expect.poll(() => sheet(page).evaluate(room)).toBeLessThan(1);
    await sheet(page)
      .locator("[data-message-scroller]")
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    await expect(
      sheet(page).getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
    // Scrolled to its start, a long one leads as a short one does.
    await expect.poll(() => sheet(page).evaluate(lead)).toBeLessThan(4);
    // The panel-colored composer fade would paint a darker strip over the
    // raised sheet; the sheet's own edge material replaces it.
    expect(
      await sheet(page)
        .locator("[data-thread-history-frame] + *")
        .evaluate((element) => getComputedStyle(element, "::before").content),
    ).toBe("none");
  });

  test("details in the conversation read over its composer", async ({
    page,
    app,
  }) => {
    await open(page, app);
    details(app, "Channel findings");
    const timeline = page.locator("[data-channel-timeline]");
    await showMore(timeline, "Channel findings").click();
    const reader = detailsSheet(page);
    await expect(reader).toBeVisible();
    await expect(reader).toBeFocused();
    // The composer stays usable above the reader.
    const composer = page.getByRole("textbox", { name: "Message #Alpha" });
    await composer.click();
    await composer.pressSequentially("Thanks");
    await expect(reader).toBeVisible();
    await page.goBack();
    await expect(reader).toHaveCount(0);
    await page.goForward();
    await expect(detailsSheet(page)).toBeVisible();
    await page.reload();
    await expect(detailsSheet(page)).toBeVisible();
    await detailsSheet(page).focus();
    await page.keyboard.press("Escape");
    await expect(detailsSheet(page)).toHaveCount(0);
    await page.goForward();
    await expect(detailsSheet(page)).toHaveCount(0);
  });

  test("Move to side panel hands the thread, its draft and the reply it answers to a tab", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(reply(sheet(page))).toBeFocused();
    // The draft is aimed at a reply, not at the thread.
    const parent = sheet(page)
      .locator("[data-message-id]")
      .filter({ hasText: "Unread reply 0" });
    const parentId = await parent.getAttribute("data-message-id");
    await hoverMessage(parent);
    await parent.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(
      sheet(page).getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await expect(reply(sheet(page))).toBeFocused();
    await page.keyboard.type("Half-written reply");
    await sheet(page)
      .getByRole("button", { name: "Move to side panel", exact: true })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(threadTab(page, root)).toBeVisible();
    await expect(reply(side(page))).toHaveText("Half-written reply");
    await expect(
      side(page).getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    // The handoff retired the inline visit: Back never shows both.
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    // A thread that has a tab opens there, never inline beside it.
    await clickRow(page, viewThread(page, root));
    await expect(threadTab(page, root)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(sheet(page)).toHaveCount(0);
    await expect(reply(side(page))).toHaveText("Half-written reply");
    // Sent from the tab, the draft still answers the reply it was aimed at.
    await reply(side(page)).press("Enter");
    await expect
      .poll(() =>
        app.report.publications
          .find(({ event }) => event?.content === "Half-written reply")
          ?.event.tags.filter(([key]) => key === "e"),
      )
      .toEqual([
        ["e", root.id, "", "root"],
        ["e", parentId, "", "reply"],
      ]);
  });

  // On a cold start the open channel is listed from saved membership until
  // its roster read settles, and the session reads no thread of it before
  // then. Only a real reload restores that listing with the thread's address.
  test("a thread restored before its channel is confirmed waits, then shows", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = roots(app);
    await clickRow(page, viewThread(page, root));
    await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
    let release;
    const roster = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = [route.request().postDataJSON()].flat();
      if (filters.some((filter) => filter?.kinds?.includes(39002))) {
        requested = true;
        await roster;
      }
      return route.continue().catch(() => {});
    });
    try {
      await page.reload();
      await expect.poll(() => requested).toBe(true);
      // The sheet is drawn once the saved channel is open. A thread mounted
      // on it would be refused at once, so settled geometry is past that.
      await expect(sheet(page)).toBeVisible();
      await settle(page);
      await expect(sheet(page).locator("[data-message-waiting]")).toHaveCount(
        1,
      );
      // The waiting sheet draws no placeholders.
      await expect(sheet(page).locator("[data-message-loading]")).toHaveCount(
        0,
      );
      await expect(sheet(page).getByRole("alert")).toHaveCount(0);
      release();
      await expect(sheet(page).getByText("Unread reply 0")).toBeVisible();
      await expect(sheet(page).locator("[data-message-waiting]")).toHaveCount(
        0,
      );
    } finally {
      release();
    }
  });
});

test.describe("Sending", () => {
  test.use({ productionBroker: false, sendChannels: ["alpha"] });

  test("a send from the composer closes the details read over it", async ({
    page,
    app,
  }) => {
    await open(page, app);
    details(app, "Channel findings");
    await showMore(
      page.locator("[data-channel-timeline]"),
      "Channel findings",
    ).click();
    await expect(detailsSheet(page)).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message #Alpha" });
    await composer.click();
    await composer.pressSequentially("Thanks, merging");
    await composer.press("Enter");
    await expect(detailsSheet(page)).toHaveCount(0);
    await expect(
      page.locator("[data-channel-timeline]").getByText("Thanks, merging"),
    ).toBeVisible();
    // Like ✕, the send retired the visit: Forward does not reopen it.
    await page.goForward();
    await expect(detailsSheet(page)).toHaveCount(0);
  });
});
