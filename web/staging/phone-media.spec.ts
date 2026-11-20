import { devices, expect, type Page, test } from "@playwright/test";

const port = process.env.STAGING_PORT ?? "9443";
const shots = process.env.PHONE_SHOTS;
// PHONE_MEDIA holds red.jpg, green.jpg, blue.jpg and clip.mp4 (ffmpeg color
// and testsrc2 sources).
const media = process.env.PHONE_MEDIA ?? "/tmp/buzz-phone-media";
const run = Date.now().toString(36);

async function shot(page: Page, name: string) {
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
  if (shots) await page.screenshot({ path: `${shots}/media-${name}.png` });
}

type Point = [number, number];
/** Real touches through Chromium's input pipeline, which gives pages pointer
 * events as fingers do (dispatched TouchEvents give none): fingers moving
 * from `from` to `to` in 8 steps, a swipe with one, a pinch with two, a tap
 * when they do not move. */
async function touches(page: Page, from: Point[], to = from) {
  const cdp = await page.context().newCDPSession(page);
  const points = (at: Point[]) =>
    at.map(([x, y], id) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 }));
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: points(from),
  });
  if (JSON.stringify(from) !== JSON.stringify(to))
    for (let step = 1; step <= 8; step++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(
          from.map(([x, y], i) => [
            x + (((to[i] as Point)[0] - x) * step) / 8,
            y + (((to[i] as Point)[1] - y) * step) / 8,
          ]),
        ),
      });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

// Media on a phone: images open full screen and answer pinch, double tap and
// swipe; a video opens on the video, its comments a tap away.
test("media viewer on a phone", async ({ playwright }) => {
  // The service worker, which signs media requests, only registers on a
  // certificate the browser trusts.
  const browser = await playwright.chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  const { defaultBrowserType: _, ...options } = devices["Pixel 7"];
  const page = await (
    await browser.newContext({ ...options, ignoreHTTPSErrors: true })
  ).newPage();
  const { width, height } = options.viewport;
  await page.goto(`https://buzz.localhost:${port}/`);
  await page.evaluate(() =>
    Reflect.get(window, "__TAURI_INTERNALS__").invoke("identity_create"),
  );
  await page.reload();
  const next = page.getByRole("button", { name: "Continue" });
  await expect(async () => {
    const field = page.getByLabel("Invite link or community URL");
    await field.fill(`wss://buzz.localhost:${port}`);
    await field.press("Enter");
    await expect(next).toBeVisible({ timeout: 2000 });
  }).toPass();
  await next.tap();
  await page.getByLabel("Display name").fill("Phone media");
  await page.getByRole("button", { name: "Publish profile & open" }).tap();
  await page.locator("[data-shell-sidebar-toggle]").tap();
  await page.getByRole("button", { name: "Create channel" }).first().tap();
  await page.getByLabel("Name").fill(`media-${run}`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create channel" })
    .click();
  const send = page.getByRole("button", { name: "Send message" });
  const post = async (files: string[]) => {
    const uploads = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith("/upload"),
      { timeout: 60_000 },
    );
    await page
      .locator('input[type="file"]')
      .setInputFiles(files.map((file) => `${media}/${file}`));
    await uploads;
    await expect(send).toBeEnabled({ timeout: 60_000 });
    await send.tap();
  };
  await post(["red.jpg", "green.jpg", "blue.jpg"]);
  await post(["clip.mp4"]);
  const previews = page.locator("[data-media-preview]");
  await expect(previews).toHaveCount(4, { timeout: 60_000 });
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await shot(page, "1-channel");

  // An image opens full screen.
  await previews.first().tap();
  const image = page.locator("[data-review-media]");
  await expect(image).toBeVisible();
  await shot(page, "2-image");
  const src = async () => image.getAttribute("src");
  const first = await src();

  // A swipe left shows the next image; a swipe right comes back.
  const middle: Point = [width / 2, height / 2];
  await touches(
    page,
    [[width * 0.8, height / 2]],
    [[width * 0.15, height / 2]],
  );
  await expect.poll(src).not.toBe(first);
  await shot(page, "3-swiped");
  await touches(
    page,
    [[width * 0.15, height / 2]],
    [[width * 0.8, height / 2]],
  );
  await expect.poll(src).toBe(first);

  // Two fingers moving apart zoom in, and a double tap zooms back out.
  const zoom = () =>
    page
      .locator("[data-image-controls]")
      .evaluate(() =>
        document.querySelector("[data-review-zoomed]") ? "zoomed" : "fit",
      );
  await touches(
    page,
    [
      [middle[0] - 20, middle[1]],
      [middle[0] + 20, middle[1]],
    ],
    [
      [middle[0] - 140, middle[1]],
      [middle[0] + 140, middle[1]],
    ],
  );
  await expect.poll(zoom).toBe("zoomed");
  await shot(page, "4-pinched");
  // While zoomed, a swipe pans instead of changing image.
  await touches(page, [middle], [[middle[0] - 120, middle[1]]]);
  expect(await src()).toBe(first);
  await touches(page, [middle]);
  await touches(page, [middle]);
  await expect.poll(zoom).toBe("fit");
  // A double tap zooms in where it lands.
  await touches(page, [middle]);
  await touches(page, [middle]);
  await expect.poll(zoom).toBe("zoomed");
  await touches(page, [middle]);
  await touches(page, [middle]);
  await expect.poll(zoom).toBe("fit");

  // A swipe down closes the viewer.
  await touches(page, [middle], [[middle[0], height * 0.95]]);
  await expect(image).toBeHidden();

  // A video opens on the video, its comments a tap away, even once it has
  // some.
  const comments = page.getByRole("complementary", { name: "Media comments" });
  const openVideo = async () => {
    await page.getByRole("button", { name: "Open video fullscreen" }).tap();
    await expect(page.locator("video").last()).toBeVisible();
  };
  await openVideo();
  await expect(comments).toBeHidden();
  await page.getByRole("button", { name: "Show comments" }).tap();
  await expect(comments).toBeVisible();
  await comments.getByRole("textbox").tap();
  await page.keyboard.type("Nice clip");
  await comments.getByRole("button", { name: "Send message" }).tap();
  await expect(comments.getByText("Nice clip")).toBeVisible();
  await shot(page, "6-video-comments");
  await page.getByRole("button", { name: "Close fullscreen viewer" }).tap();
  await openVideo();
  await expect(comments).toBeHidden();
  await shot(page, "5-video");
  await browser.close();
});
