import { test, expect } from "./playwright-test.mjs";
import react from "@vitejs/plugin-react";
import { crc32, deflateSync } from "node:zlib";
import { createServer } from "./vite-server.mjs";
import { seedThreadPlacement } from "./thread-placement.mjs";

// The fullscreen viewer: inline media reads in a sheet (inline-media.spec).
test.beforeEach(({ context }) => seedThreadPlacement(context));

// Solid raster PNGs: native builds download SVG attachments instead of
// rendering them, so the viewer must be exercised with a supported format.
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const picture = (name, width, height) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9e)]);
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  };
};

// Reads the rendered zoom geometry the way the viewer computes it.
const geometry = (image) =>
  image.evaluate((el) => {
    const stage = el.parentElement.getBoundingClientRect();
    const fit = Math.min(
      stage.width / el.naturalWidth,
      stage.height / el.naturalHeight,
    );
    const {
      a: zoom,
      e: x,
      f: y,
    } = new DOMMatrix(getComputedStyle(el).transform);
    return {
      x,
      y,
      zoom,
      click: Math.max(2, 1 / fit),
      limitX: Math.max(0, (el.naturalWidth * fit * zoom - stage.width) / 2),
      limitY: Math.max(0, (el.naturalHeight * fit * zoom - stage.height) / 2),
      center: {
        x: stage.left + stage.width / 2,
        y: stage.top + stage.height / 2,
      },
    };
  });

test("clicking a gallery image zooms in and out without closing or navigating", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments`,
    );
    const form = page.getByRole("form", {
      name: "Send a message to General",
      exact: true,
    });
    await expect(
      form.getByRole("button", { name: "Attach files", exact: true }),
    ).toBeEnabled();
    await form
      .getByLabel("Choose attachments")
      .setInputFiles([
        picture("panorama.png", 6000, 600),
        picture("portrait.png", 240, 900),
      ]);
    await expect(form.getByText(/Ready$/)).toHaveCount(2);
    await form
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    const links = history
      .getByRole("group", { name: "2 images", exact: true })
      .getByRole("link");
    await expect(links).toHaveCount(2);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.composerFixture
            .pending()
            .every((item) => ["accepted", "seen"].includes(item.delivery)),
        ),
      )
      .toBe(true);
    await links.first().click();
    const viewer = page.getByRole("dialog", {
      name: "Image viewer",
      exact: true,
    });
    await expect(viewer).toBeVisible();
    await expect(viewer).not.toHaveAttribute("data-review-opening");
    const image = viewer.getByRole("img", { name: "Attachment preview" });
    await expect(image).toHaveAccessibleDescription("Click the image to zoom.");
    await expect.poll(() => image.evaluate((el) => el.naturalWidth)).toBe(6000);
    const readout = viewer.getByRole("button", { name: /^Image zoom:/ });
    await expect(readout).toHaveText("100%");
    await expect(image).toHaveCSS("cursor", "zoom-in");

    // The panorama is downscaled, so a click lands on its actual pixels.
    const fitted = await geometry(image);
    await page.mouse.click(fitted.center.x + 100, fitted.center.y);
    await expect(readout).toHaveText(`${Math.round(fitted.click * 100)}%`);
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("1 / 2", { exact: true })).toBeVisible();
    await expect(image).toHaveCSS("cursor", "grab");
    const zoomed = await geometry(image);
    expect(zoomed.x).toBeCloseTo(-100 * (fitted.click - 1), 0);

    // Dragging pans to the clamped edge instead of toggling zoom.
    await page.mouse.move(zoomed.center.x, zoomed.center.y);
    await page.mouse.down();
    await page.mouse.move(zoomed.center.x + 400, zoomed.center.y, {
      steps: 4,
    });
    await page.mouse.move(zoomed.center.x + 20000, zoomed.center.y, {
      steps: 4,
    });
    await page.mouse.up();
    await expect(readout).toHaveText(`${Math.round(fitted.click * 100)}%`);
    const panned = await geometry(image);
    expect(panned.x).toBeCloseTo(panned.limitX, 0);
    expect(panned.y).toBe(0);

    // A narrower window reclamps the pan so the edge stays reachable.
    await page.setViewportSize({ width: 900, height: 700 });
    await expect
      .poll(async () => {
        const next = await geometry(image);
        return Math.abs(next.x - next.limitX) < 0.5;
      })
      .toBe(true);

    const resized = await geometry(image);
    await page.mouse.click(resized.center.x, resized.center.y);
    await expect(readout).toHaveText("100%");
    await expect(image).toHaveCSS("transform", "none");

    // Repeated zooming stays consistent and gallery switches reset it.
    for (let round = 0; round < 3; round++) {
      await page.mouse.click(resized.center.x, resized.center.y);
      await expect(readout).not.toHaveText("100%");
      await page.mouse.click(resized.center.x, resized.center.y);
      await expect(readout).toHaveText("100%");
    }
    await page.mouse.click(resized.center.x, resized.center.y);
    await expect(readout).not.toHaveText("100%");
    await viewer.getByRole("button", { name: "Next image" }).click();
    await expect(viewer.getByText("2 / 2", { exact: true })).toBeVisible();
    await expect(readout).toHaveText("100%");

    // The small portrait gets a visible 2x step rather than its actual size.
    await expect.poll(() => image.evaluate((el) => el.naturalWidth)).toBe(240);
    const portrait = await geometry(image);
    await page.mouse.click(portrait.center.x, portrait.center.y);
    await expect(readout).toHaveText("200%");
    await page.keyboard.press("ArrowLeft");
    await expect(viewer.getByText("1 / 2", { exact: true })).toBeVisible();
    await expect(readout).toHaveText("100%");

    await viewer
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(viewer).toHaveCount(0);
    await expect(links.first()).toBeFocused();
  } finally {
    await server.close();
  }
});
