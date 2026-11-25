import {
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ pluginFixtures: true, enabledPlugins: ["fixture.notices"] });

const tabKey = (browserName) =>
  browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";

const question = (page) =>
  page.getByRole("dialog", { name: "Let Fixture delete a.txt?" });

test("a plugin's notice shows on any page and takes the owner's answer over Settings", async ({
  page,
  app,
}) => {
  await open(page, app);
  const ask = question(page);
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("From Notice fixture");
  await openSettings(page);
  await expect(ask).toBeVisible();
  const close = settingsDialog(page).getByRole("button", {
    name: "Close Settings",
    exact: true,
  });
  await expect(close).toBeFocused();
  await page.getByRole("dialog", { name: "Fixture is waiting" }).hover();
  await ask.getByRole("button", { name: "Allow once" }).click();
  await expect(ask).toHaveCount(0);
  await returnedFocus(page);
  await expect(close).toBeFocused();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  const answered = page.getByRole("dialog", { name: "Answered once" });
  await expect(answered).toBeVisible();
  await settingsDialog(page).press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(answered).toBeVisible();
});

async function returnedFocus(page) {
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
  return page.evaluate(async () => {
    const frame = () => new Promise(requestAnimationFrame);
    const toaster = document.querySelector("[data-sonner-toaster]");
    const settle = async () => {
      await frame();
      const moving = toaster.getAnimations({ subtree: true });
      if (!moving.length) return;
      await Promise.allSettled(moving.map((animation) => animation.finished));
      await settle();
    };
    await settle();
    await frame();
    const cards = [
      ...document.querySelectorAll(
        '[data-sonner-toast]:not([data-removed="true"])',
      ),
    ].map((card) => card.getBoundingClientRect());
    const meets = (box, pad) =>
      cards.filter(
        (card) =>
          card.left < box.right + pad &&
          card.right > box.left - pad &&
          card.top < box.bottom + pad &&
          card.bottom > box.top - pad,
      ).length;
    const settings = document.querySelector('[aria-modal="true"]');
    const close = settings.querySelector('[aria-label="Close Settings"]');
    const focused = document.activeElement;
    const style = getComputedStyle(focused);
    const ring =
      Number.parseFloat(style.outlineWidth) +
      Number.parseFloat(style.outlineOffset);
    const box = focused.getBoundingClientRect();
    const corners = [
      [box.left - ring, box.top - ring],
      [box.right + ring - 1, box.top - ring],
      [box.left - ring, box.bottom + ring - 1],
      [box.right + ring - 1, box.bottom + ring - 1],
    ];
    return {
      closeUnderToast: meets(close.getBoundingClientRect(), 4) > 0,
      inSettings: settings.contains(focused),
      ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`,
      toastsOverRing: meets(box, ring),
      centreOnFocus: focused.contains(
        document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        ),
      ),
      ringCornersOnToast: corners.filter(([x, y]) =>
        document.elementFromPoint(x, y)?.closest("[data-sonner-toast]"),
      ).length,
    };
  });
}

const visibleInSettings = {
  closeUnderToast: true,
  inSettings: true,
  ring: "solid 2px 2px",
  toastsOverRing: 0,
  centreOnFocus: true,
  ringCornersOnToast: 0,
};

async function reachOverSettings(page, app) {
  await open(page, app);
  const ask = question(page);
  await expect(ask).toBeVisible();
  await openSettings(page);
  const close = settingsDialog(page).getByRole("button", {
    name: "Close Settings",
    exact: true,
  });
  await close.focus();
  const card = page.locator("[data-sonner-toast]", { has: ask });
  const [noticeBox, closeBox] = [
    await card.boundingBox(),
    await close.boundingBox(),
  ];
  expect(noticeBox.x).toBeLessThan(closeBox.x);
  expect(noticeBox.x + noticeBox.width).toBeGreaterThan(
    closeBox.x + closeBox.width,
  );
  expect(noticeBox.y).toBeLessThan(closeBox.y);
  expect(noticeBox.y + noticeBox.height).toBeGreaterThan(
    closeBox.y + closeBox.height,
  );
  await page.keyboard.press("F6");
  await expect(card).toBeFocused();
  await expect(card).toHaveCSS("outline-style", "solid");
  return { ask, card };
}

test("F6 reaches a waiting notice over Settings, and Enter on an action answers it", async ({
  page,
  app,
  browserName,
}) => {
  const tab = tabKey(browserName);
  const { ask } = await reachOverSettings(page, app);
  await page.keyboard.press(tab);
  await page.keyboard.press(tab);
  await expect(ask.getByRole("button", { name: "Allow once" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ask).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Answered once" }),
  ).toBeVisible();
  await expect(settingsDialog(page)).toBeVisible();
  expect(await returnedFocus(page)).toEqual(visibleInSettings);
});

test("F6 and Tab keep focus between a waiting notice and Settings, and Escape on the notice refuses it", async ({
  page,
  app,
  browserName,
}) => {
  const tab = tabKey(browserName);
  const { ask, card } = await reachOverSettings(page, app);
  await page.keyboard.press(`Shift+${tab}`);
  expect(await returnedFocus(page)).toEqual(visibleInSettings);
  await page.keyboard.press("F6");
  await expect(card).toBeFocused();
  await page.keyboard.press(tab);
  await page.keyboard.press(tab);
  await page.keyboard.press(tab);
  await expect(ask.getByRole("button", { name: "Deny" })).toBeFocused();
  await page.keyboard.press(tab);
  expect(await returnedFocus(page)).toEqual(visibleInSettings);
  await page.keyboard.press("F6");
  await expect(card).toBeFocused();
  await page.keyboard.press("F6");
  expect(await returnedFocus(page)).toEqual(visibleInSettings);
  await page.keyboard.press("F6");
  await expect(card).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Answered nothing" }),
  ).toBeVisible();
  await expect(settingsDialog(page)).toBeVisible();
  expect(await returnedFocus(page)).toEqual(visibleInSettings);
});

test("over Settings, a notice without choices keeps its Tab order and the focus a click gives it", async ({
  page,
  app,
  browserName,
}) => {
  const tab = tabKey(browserName);
  await open(page, app);
  await expect(question(page)).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Appearance");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "buzz-clock.v1")
        throw new DOMException("Full", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  await page.getByRole("switch", { name: "Show seconds" }).click();
  const unsaved = page.getByRole("dialog", {
    name: "Clock preference wasn’t saved",
  });
  await unsaved.getByText("Clock preference wasn’t saved").click();
  await expect(
    page.locator("[data-sonner-toast]", { has: unsaved }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    unsaved.getByRole("button", { name: "Retry saving clock preference" }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    page.locator("[data-sonner-toast]", {
      has: page.getByRole("dialog", { name: "Fixture is waiting" }),
    }),
  ).toBeFocused();
  await question(page).getByText("Let Fixture delete a.txt?").click();
  await expect(
    page.locator("[data-sonner-toast]", { has: question(page) }),
  ).toBeFocused();
  const retry = unsaved.getByRole("button", {
    name: "Retry saving clock preference",
  });
  await unsaved.hover();
  await retry.click();
  await expect(retry).toBeFocused();
});
