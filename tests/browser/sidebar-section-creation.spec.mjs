import { test, expect } from "./fixture.mjs";
import { openPage, settleShellToggle } from "./navigation.mjs";

// Browser ownership: real pointer collision/activation, menu-to-modal focus,
// relocation and cold reload through the production preference broker.
// Input/error permutations remain in the colocated component/store tests.
test.use({ productionBroker: true, savedSidebar: true, largeSidebar: false });

test("Channels offers empty-section creation with keyboard focus and confirmed persistence", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const trigger = page.getByRole("button", {
    name: "More actions for Channels",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem"),
  ).toHaveText(["Filter", "Sort", "Create section"]);
  await page
    .getByRole("menuitem", { name: "Create section", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Create section", exact: true })
    .click();
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.keyboard.type("Launch");
  await expect(field).toHaveValue("Launch");
  const creations = [];
  let lostResponse = false;
  let awaitingReconciliation = false;
  let failWriterRead = false;
  let writerReads = 0;
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      awaitingReconciliation &&
      Array.isArray(filters) &&
      filters.length === 5 &&
      filters.some((filter) => filter["#d"]?.includes("channel-sections"))
    ) {
      if (filters.every((filter) => filter.consistency === "strong")) {
        writerReads++;
        if (failWriterRead) {
          failWriterRead = false;
          // Relay recovery retries a transient failure such as a 502 about a
          // second later, which can remove Retry preferences while a slow
          // click is still landing. A denial leaves the retry to the user.
          app.report.relayFailures ??= [];
          app.report.relayFailures.push(route.request().url());
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: "Preference read unavailable" }),
          });
          return;
        }
        awaitingReconciliation = false;
      } else {
        // A replica is still behind the accepted write. Only writer routing
        // can reconcile this creation before the dialog discards its ID.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return;
      }
    }
    await route.continue();
  });
  const loseCreationResponse = async (route) => {
    creations.push(route.request().postDataJSON());
    // API forwarding pools sockets across the reload. Close each response so
    // the next mutation cannot reuse one as the fixture broker expires it.
    const response = await route.fetch({
      headers: { ...(await route.request().allHeaders()), connection: "close" },
    });
    expect(response.headers()["connection"]).toBe("close");
    if (!lostResponse && response.ok()) {
      // The real broker accepts and persists the write, but its response never
      // reaches the dialog. The retry must reconcile that exact creation.
      lostResponse = true;
      awaitingReconciliation = true;
      app.report.sidebarAssignmentFailures ??= [];
      app.report.sidebarAssignmentFailures.push(route.request().url());
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Section confirmation unavailable" }),
      });
    } else await route.fulfill({ response });
  };
  await page.route("**/sidebar-assignment", loseCreationResponse);
  await field.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(
    "Couldn't confirm the section was saved. Try again.",
  );
  expect(writerReads).toBe(1);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("readonly", "");
  await page.keyboard.type("es");
  await expect(field).toHaveValue("Launch");
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(creations).toHaveLength(2);
  expect(creations[1]).toEqual(creations[0]);
  await page.unroute("**/sidebar-assignment");
  await expect(trigger).toBeFocused();
  await expect(
    page.locator("summary").filter({ hasText: /^Launch$/ }),
  ).toBeVisible();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  const { blob } = app.report.sidebarPublications[0];
  expect(blob.assignments).toEqual({ beta: "work" });
  expect(Object.keys(blob.meta.a)).not.toContain("undefined");
  await page.reload();
  await openPage(page, "Messages");
  await expect(
    page.locator("summary").filter({ hasText: /^Launch$/ }),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-sidebar-section="group:work"] [data-channel-id="beta"]',
    ),
  ).toBeVisible();
  // An accepted creation must also appear if the user cancels instead of
  // retrying. Reopening the form must not hide that confirmed section.
  lostResponse = false;
  failWriterRead = true;
  await page.route("**/sidebar-assignment", loseCreationResponse);
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Create section", exact: true })
    .click();
  await field.fill("Cancel check");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Couldn't confirm the section was saved. Try again.",
  );
  expect(writerReads).toBe(2);
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).not.toContainText("403");
  // Recover preferences without replaying creation, then Cancel/reopen.
  await dialog.getByRole("button", { name: "Retry preferences" }).click();
  await expect(field).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  expect(writerReads).toBe(3);
  expect(creations).toHaveLength(3);
  const accepted = page
    .locator("summary")
    .filter({ hasText: /^Cancel check$/ });
  await expect(accepted).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(accepted).toBeVisible();
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Create section", exact: true })
    .click();
  await expect(field).toHaveValue("");
  await expect(accepted).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(creations).toHaveLength(3);
  expect(app.report.sidebarPublications).toHaveLength(2);
  await page.unroute("**/sidebar-assignment");
  await page.reload();
  await openPage(page, "Messages");
  await expect(accepted).toHaveCount(1);
  await expect(
    page.locator("summary").filter({ hasText: /^Launch$/ }),
  ).toHaveCount(1);
});

async function startDrag(page, locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Drag source missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const pointer = { x: box.x + box.width / 2 + 12, y: box.y + box.height / 2 };
  await page.mouse.move(pointer.x, pointer.y, { steps: 3 });
  return pointer;
}

async function dropOnCreate(page) {
  await revealCreate(page);
  const target = page.locator("[data-create-section-drop]");
  // Bring the actual target into view before releasing; at enlarged text its
  // lower edge can sit outside the narrow sidebar's scrollport.
  await target.hover();
  await expect(page.locator('[class*="channelDragOverlay"]')).toBeHidden();
  await page.mouse.up();
}

async function revealCreate(page) {
  const trigger = page.locator("[data-create-section-trigger]");
  const box = await trigger.boundingBox();
  if (!box) throw new Error("Create boundary missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 4,
  });
  await expect(page.locator("[data-create-section-drop]")).toBeVisible();
  // Observe completion rather than releasing into still-expanding geometry.
  await expect
    .poll(() =>
      page
        .locator("[data-create-section-drop]")
        .evaluate((node) => node.parentElement.style.height),
    )
    .toBe("auto");
}

test("only the top channel-section boundary reveals creation, latches, cancels and saves first", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const target = page.locator("[data-create-section-drop]");
  const row = page.locator('[data-channel-id="alpha"]');
  await expect(target).toHaveCount(0);
  const pointer = await startDrag(page, row);
  // The preview stays where the row was grabbed, under the pointer.
  const preview = page.locator('[class*="channelDragOverlay"]');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS("translate", "none");
  await expect
    .poll(async () => {
      const box = await preview.boundingBox();
      return !!box && box.y <= pointer.y && pointer.y <= box.y + box.height;
    })
    .toBe(true);
  await expect(target).toHaveCount(0);
  // Channels is not first when Work exists: its old gap is an ordinary move area.
  const channels = page.locator('[data-sidebar-section="channels"]');
  const channelsBox = await channels.boundingBox();
  if (!channelsBox) throw new Error("Channels destination missing");
  await page.mouse.move(
    channelsBox.x + channelsBox.width / 2,
    channelsBox.y - 8,
  );
  await page.mouse.move(
    channelsBox.x + channelsBox.width / 2,
    channelsBox.y + 12,
  );
  await expect(channels).toHaveAttribute("data-drop-target", "true");
  await expect(target).toHaveCount(0);
  await expect(
    page.locator("[data-create-section-slot] + [data-sidebar-section]"),
  ).toHaveAttribute("data-sidebar-section", "group:work");
  await revealCreate(page);
  await page
    .locator(".shell-sidebar")
    .screenshot({ path: testInfo.outputPath("top-section-target.png") });
  await page.evaluate(() => {
    localStorage.setItem("buzz-appearance.v1", "dark");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-appearance.v1",
        newValue: "dark",
        storageArea: localStorage,
      }),
    );
  });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.locator(".shell-sidebar").screenshot({
    path: testInfo.outputPath("top-section-target-dark.png"),
  });
  // Leaving the gap must not collapse it or prevent an ordinary section move.
  const work = page.locator('[data-sidebar-section="group:work"] summary');
  const workBox = await work.boundingBox();
  if (!workBox) throw new Error("Work destination missing");
  await page.mouse.move(
    workBox.x + workBox.width / 2,
    workBox.y + workBox.height / 2,
  );
  await expect(target).toBeVisible();
  await expect(
    page.locator('[data-sidebar-section="group:work"]'),
  ).toHaveAttribute("data-drop-target", "true");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(target).toHaveCount(0);
  // The cue retires before its height finishes collapsing. Wait for the layout
  // boundary before sampling Work's header for the next pointer gesture.
  await expect(page.locator("[data-create-section-trigger] + div")).toHaveCSS(
    "height",
    "0px",
  );
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  // A lone saved section is not reorderable and cannot reveal creation.
  await startDrag(page, work);
  await expect(target).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  // Release as soon as the original gap accepts the drop, without waiting for
  // expansion. dnd-kit drops on its rendered target, not the last mouse event.
  await startDrag(page, row);
  const gap = await page.locator("[data-create-section-trigger]").boundingBox();
  if (!gap) throw new Error("Create boundary missing");
  await page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2);
  await expect(target).toHaveAttribute("data-drop-target", "true");
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "Move to new section" });
  const field = dialog.getByRole("textbox", { name: "Section name" });
  await expect(field).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await startDrag(page, row);
  await dropOnCreate(page);
  await expect(field).toBeFocused();
  await dialog.evaluate(async (element) => {
    await Promise.allSettled(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await expect(field).toBeFocused();
  await page.keyboard.type("Release");
  await expect(field).toHaveValue("Release");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).toHaveCount(0);
  const section = page
    .locator("[data-sidebar-section]")
    .filter({ has: page.locator("summary").filter({ hasText: /^Release$/ }) });
  await expect(section.locator('[data-channel-id="alpha"]')).toBeVisible();
  await expect(
    page.locator('[data-sidebar-section^="group:"] summary'),
  ).toHaveText(["Release", "Work"]);
  await expect(row).toBeFocused();
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  await page.reload();
  await openPage(page, "Messages");
  await expect(section.locator('[data-channel-id="alpha"]')).toBeVisible();
  await expect(
    page.locator('[data-sidebar-section^="group:"] summary'),
  ).toHaveText(["Release", "Work"]);
  await page.locator(".shell-sidebar").screenshot({
    path: testInfo.outputPath("created-section-first.png"),
  });
  // The original per-channel creation entry remains available.
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .hover();
  await expect(
    page.getByRole("menuitem", { name: "Create new…", exact: true }),
  ).toBeVisible();
});

test.describe("without saved sections", () => {
  test.use({ savedSidebar: false });

  // Only a layout engine proves that the first-section gap is reachable in the
  // host sidebar, including its scrollport, enlarged text and immediate motion.
  test("the first Channels boundary works with reduced motion in a narrow sidebar", async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto(app.origin);
    await page.evaluate(() => {
      localStorage.setItem("buzz-font-scale.v1", "2");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "buzz-font-scale.v1",
          newValue: "2",
          storageArea: localStorage,
        }),
      );
    });
    await openPage(page, "Messages");
    await settleShellToggle(page);
    await page
      .getByRole("button", { name: "Show navigation", exact: true })
      .click();
    await expect(page.locator('[data-sidebar-section="starred"]')).toHaveCount(
      0,
    );
    await expect(page.locator('[data-sidebar-section^="group:"]')).toHaveCount(
      0,
    );
    // Coalesce the hit area's initial observer delivery with the immediate
    // reveal. dnd-kit ignores that first delivery; the completed reveal must
    // establish its expanded collision geometry independently.
    const resizeGate = await page.evaluateHandle(() => {
      const NativeResizeObserver = window.ResizeObserver;
      const pending = new Map();
      let released = false;
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback) {
          super((entries, observer) => {
            const create = entries.filter(({ target }) =>
              target.hasAttribute("data-create-section-trigger"),
            );
            const rest = entries.filter(
              ({ target }) =>
                !target.hasAttribute("data-create-section-trigger"),
            );
            if (rest.length) callback(rest, observer);
            if (create.length) {
              if (released) callback(create, observer);
              else
                pending.set(observer, {
                  entries: create,
                  notify: () => callback(create, observer),
                });
            }
          });
        }
      };
      return {
        ready: () =>
          pending.size > 0 &&
          [...pending.values()].every(({ entries }) =>
            entries.every(
              ({ target, contentRect }) =>
                contentRect.height === target.clientHeight,
            ),
          ),
        release: () => {
          released = true;
          for (const { notify } of pending.values()) notify();
          pending.clear();
          window.ResizeObserver = NativeResizeObserver;
        },
      };
    });
    try {
      await startDrag(page, page.locator('[data-channel-id="alpha"]'));
      await revealCreate(page);
      await expect
        .poll(() => resizeGate.evaluate((gate) => gate.ready()))
        .toBe(true);
    } finally {
      await resizeGate.evaluate((gate) => gate.release());
      await resizeGate.dispose();
    }
    const target = page.locator("[data-create-section-drop]");
    await target.hover();
    await expect(page.locator('[class*="channelDragOverlay"]')).toBeHidden();
    await page.mouse.up();
    const dialog = page.getByRole("dialog", { name: "Move to new section" });
    await expect(
      dialog.getByRole("textbox", { name: "Section name" }),
    ).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  });
});
