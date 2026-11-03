import { devices, expect, type Page, test } from "@playwright/test";

const port = process.env.STAGING_PORT ?? "9443";
const shots = process.env.PHONE_SHOTS;
const run = Date.now().toString(36);

// The phone layer (web/mobile.ts, web/mobile.css) on emulated phones against
// the local staging relay. Set PHONE_SHOTS to a directory to keep screenshots.
async function shot(page: Page, name: string) {
  // Settle finite transitions and animations (loaders loop forever).
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
  if (shots) await page.screenshot({ path: `${shots}/phone-${name}.png` });
}

// A one-finger gesture from synthetic touch events (Playwright only taps):
// a swipe from `from` to `to`, or a press held `hold` ms.
type Point = [number, number];
const gesture = (page: Page, from: Point, to = from, hold = 0) =>
  page.evaluate(
    async ([[x0, y0], [x1, y1], hold]) => {
      const target = document.elementFromPoint(x0, y0) ?? document.body;
      // Desktop WebKit has no Touch constructor: a plain event carries them.
      const fire = (type: string, clientX: number, clientY: number) => {
        let touch: object = { identifier: 1, target, clientX, clientY };
        try {
          touch = new Touch(touch as TouchInit);
        } catch {}
        const touches = {
          touches: type === "touchend" ? [] : [touch],
          changedTouches: [touch],
        };
        const init = { bubbles: true, cancelable: true };
        target.dispatchEvent(
          "Touch" in window && touch instanceof Touch
            ? new TouchEvent(type, { ...init, ...(touches as TouchEventInit) })
            : Object.assign(new Event(type, init), touches),
        );
      };
      const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
      fire("touchstart", x0, y0);
      await wait(hold);
      for (let step = 1; x0 !== x1 && step <= 8; step++) {
        await wait(30);
        fire(
          "touchmove",
          x0 + ((x1 - x0) * step) / 8,
          y0 + ((y1 - y0) * step) / 8,
        );
      }
      fire("touchend", x1, y1);
    },
    [from, to, hold] as const,
  );

for (const [device, engine] of [
  ["iPhone 15 Pro", "webkit"],
  ["Pixel 7", "chromium"],
] as const) {
  test(`phone shell on ${device}`, async ({ playwright }) => {
    const browser = await playwright[engine].launch();
    const { defaultBrowserType: _, ...options } = devices[device];
    const page = await (
      await browser.newContext({ ...options, ignoreHTTPSErrors: true })
    ).newPage();
    const { width, height } = options.viewport;
    const name = engine === "webkit" ? "iphone" : "pixel";
    const channel = `phone-${name}-${run}`;
    await page.goto(`https://buzz.localhost:${port}/`);

    // A fresh identity joins staging and opens a channel with a few messages.
    await page.evaluate(() =>
      Reflect.get(window, "__TAURI_INTERNALS__").invoke("identity_create"),
    );
    await page.reload();
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      const field = page.getByLabel("Invite link or community URL");
      await field.fill(`wss://buzz.localhost:${port}`);
      await field.press("Enter");
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByLabel("Display name").fill(`Phone ${name}`);
    await dialog
      .getByRole("button", { name: "Publish profile & open" })
      .click();
    const toggle = page.locator("[data-shell-sidebar-toggle]");
    const drawer = page.locator('#shell-navigation[data-expanded="true"]');
    await toggle.tap();
    await page.getByRole("button", { name: "Create channel" }).tap();
    await page.getByLabel("Name").fill(channel);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create channel" })
      .click();
    const composer = page.getByRole("textbox", { name: /^Message/ });
    for (const text of [
      "Morning! Is the deploy still on for today?",
      "Yes, after lunch. I'll post the checklist here first.",
      "Great, thanks",
    ]) {
      await composer.tap();
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
      await expect(page.getByText(text)).toBeVisible();
    }
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    // Actions stay hidden until a long press.
    await expect(
      page.locator("[data-message-id] [aria-label='Message actions']").first(),
    ).toHaveCSS("opacity", "0");
    await shot(page, `${name}-1-channel`);

    // Swipe right opens the drawer, a tap on the scrim closes it, a swipe
    // left puts it away; a channel opens from it without the keyboard.
    await gesture(page, [24, height / 2], [width * 0.8, height / 2]);
    await expect(drawer).toBeVisible();
    await shot(page, `${name}-2-drawer`);
    await page.mouse.click(width - 16, height / 2);
    await expect(drawer).toBeHidden();
    await toggle.tap();
    await expect(drawer).toBeVisible();
    await gesture(page, [width * 0.6, height / 2], [20, height / 2]);
    await expect(drawer).toBeHidden();
    await toggle.tap();
    await page.getByRole("button", { name: "Inbox" }).tap();
    await toggle.tap();
    await page.getByRole("button", { name: channel }).tap();
    await expect(composer).toBeVisible();
    await expect(composer).not.toBeFocused();

    // A long press reveals the message's actions.
    const first = page
      .locator("[data-message-id]")
      .filter({ hasText: "Morning! Is the deploy" });
    const middle = await first.getByText("Morning!").evaluate((text) => {
      const box = text.getBoundingClientRect();
      return [box.x + box.width / 2, box.y + box.height / 2] as Point;
    });
    await gesture(page, middle, middle, 600);
    await expect(first).toHaveAttribute("data-touch-actions", "");
    await shot(page, `${name}-3-long-press`);
    await gesture(page, [width / 2, 40]);
    await expect(first).not.toHaveAttribute("data-touch-actions");

    // Swipe left to reply opens the thread with the keyboard up.
    await gesture(page, middle, [middle[0] - 120, middle[1]]);
    const reply = page.getByRole("textbox", { name: /^Reply/ });
    await expect(reply).toBeFocused();
    await expect(
      page
        .getByRole("complementary", { name: "Thread" })
        .locator("[data-message-id]"),
    ).toBeVisible();
    await shot(page, `${name}-4-swipe-reply`);

    // The on-screen keyboard: Android resizes the layout viewport; iOS only
    // shrinks the visual viewport, which the shell follows.
    const keyboard = 330;
    if (engine === "chromium")
      await page.setViewportSize({ width, height: height - keyboard });
    else
      await page.evaluate((keyboard) => {
        const viewport = window.visualViewport as VisualViewport;
        Object.defineProperty(viewport, "height", {
          value: viewport.height - keyboard,
        });
        viewport.dispatchEvent(new Event("resize"));
      }, keyboard);
    await page.keyboard.type("On it, ping me when it's done");
    await page.getByRole("button", { name: "Send message" }).last().tap();
    await expect(page.getByText("On it, ping me when it's done")).toBeVisible();
    await expect(reply).toBeFocused();
    const bottom = await reply.evaluate(
      (field) =>
        (field.closest("form") as Element).getBoundingClientRect().bottom,
    );
    expect(bottom).toBeLessThanOrEqual(height - keyboard);
    await shot(page, `${name}-5-keyboard`);

    // Back in the foreground after a deploy, the app reloads into the new
    // build, once nothing is being typed.
    await page.route(`https://buzz.localhost:${port}/`, async (route) => {
      if (route.request().resourceType() !== "fetch") return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /main-[\w-]+\.js/,
        "main-next.js",
      );
      await route.fulfill({ response, body });
    });
    const reloaded = page.waitForEvent("load");
    await page.evaluate(() => {
      (document.activeElement as HTMLElement).blur();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await reloaded;
    await page.unrouteAll({ behavior: "ignoreErrors" });

    if (engine === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      const { installabilityErrors } = await cdp.send(
        "Page.getInstallabilityErrors",
      );
      expect(installabilityErrors).toEqual([]);
    }
    await browser.close();
  });
}
