import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

// Classic scrollbars take space, so a notice that overflows the expanded,
// scrolling stack shows a bar. jsdom has no layout to catch it.
test.use({
  productionBroker: true,
  channelLifecycle: true,
  soloChannels: ["11111111-1111-4111-8111-111111111111"],
});

// Scrollbar thickness on each axis: the part of the box its content can't use.
function stackScrollbars(page) {
  return page.evaluate(() => {
    const stack = document.querySelector(".buzz-toast-viewport");
    if (!stack?.querySelector("[data-sonner-toast]")) return null;
    const style = getComputedStyle(stack);
    const px = (name) => Number.parseFloat(style.getPropertyValue(name));
    return {
      horizontal:
        stack.offsetHeight -
        stack.clientHeight -
        px("border-top-width") -
        px("border-bottom-width"),
      vertical:
        stack.offsetWidth -
        stack.clientWidth -
        px("border-left-width") -
        px("border-right-width"),
    };
  });
}

test(
  "pressing a notice action's label never adds a stack scrollbar",
  {
    tag: "@classic-scrollbars",
  },
  async ({ page, app }, testInfo) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page
      .getByRole("navigation", { name: "Subscribed channels" })
      .getByRole("button", { name: "Lifecycle channel", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Chat actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .click();
    const notice = page.getByRole("dialog", {
      name: "Chat archived: Lifecycle channel",
    });
    await expect(notice).toBeVisible();
    const toast = page.locator(".buzz-toast-viewport [data-sonner-toast]");
    await toast.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );

    // Pressing an action's label (not its button) starts Sonner's swipe, and
    // pressing expands the stack, which then scrolls.
    const label = notice
      .getByRole("button", { name: "Undo" })
      .locator(".buzz-button-label");
    const box = await label.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(toast).toHaveAttribute("data-swiping", "true");
    await expect(toast).toHaveAttribute("data-expanded", "true");
    await expect(page.locator(".buzz-toast-viewport")).toHaveCSS(
      "overflow-y",
      "auto",
    );
    await page.screenshot({ path: testInfo.outputPath("pressed.png") });
    expect(await stackScrollbars(page)).toEqual({ horizontal: 0, vertical: 0 });

    // Sample every frame of the release and dismissal.
    await page.evaluate(() => {
      window.stackSamples = [];
      window.stackSampling = true;
      const tick = () => {
        if (!window.stackSampling) return;
        const stack = document.querySelector(".buzz-toast-viewport");
        if (stack?.querySelector("[data-sonner-toast]"))
          window.stackSamples.push({
            horizontal: stack.offsetHeight - stack.clientHeight,
            vertical: stack.offsetWidth - stack.clientWidth,
          });
        requestAnimationFrame(tick);
      };
      tick();
    });
    await page.mouse.up();
    await expect(notice).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Chat unarchived: Lifecycle channel" }),
    ).toBeVisible();
    await page.evaluate(() => {
      window.stackSampling = false;
    });
    const samples = await page.evaluate(() => window.stackSamples);
    expect(samples.length).toBeGreaterThan(5);
    for (const sample of samples)
      expect.soft(sample).toEqual({ horizontal: 0, vertical: 0 });
  },
);
