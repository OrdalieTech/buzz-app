import { test, expect } from "./playwright-test.mjs";
import react from "@vitejs/plugin-react";
import { createServer } from "./vite-server.mjs";
import { readFile } from "node:fs/promises";
import { seedThreadPlacement } from "./thread-placement.mjs";

// The fullscreen viewer: inline media reads in a sheet (inline-media.spec).
test.beforeEach(({ context }) => seedThreadPlacement(context));

function insideHistory(el) {
  const history = el.closest('[aria-label="Channel message history"]');
  const frame = el.getBoundingClientRect();
  const viewport = history.getBoundingClientRect();
  return (
    frame.left >= viewport.left &&
    frame.right <= viewport.right &&
    frame.top >= viewport.top &&
    frame.bottom <= viewport.bottom
  );
}

// Browser-only: real video decoding, mixed tile geometry and gallery handoff.
test("mixed videos and photos stay in four tiles and all remain reachable", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments`,
    );
    const form = page.getByRole("form", {
      name: "Send a message to General",
      exact: true,
    });
    const clip = await readFile(
      new URL("../fixtures/message-gallery/assets/sample.mp4", import.meta.url),
    );
    await form.getByLabel("Choose attachments").setInputFiles([
      { name: "clip.mp4", mimeType: "video/mp4", buffer: clip },
      ...Array.from({ length: 4 }, (_, index) => ({
        name: `photo-${index}.svg`,
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#d9e7e3"/><text x="20" y="80" font-size="40">Photo ${index}</text></svg>`,
        ),
      })),
    ]);
    await expect(form.getByText(/Ready$/)).toHaveCount(5);
    await form.getByRole("textbox").fill("Mixed gallery");
    await form
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const group = page
      .getByRole("region", { name: "Channel message history", exact: true })
      .getByRole("group", { name: "5 photos and videos", exact: true });
    const links = group.getByRole("link");
    await expect(links).toHaveCount(4);
    await expect(links.last()).toHaveText("+2");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.composerFixture
            .pending()
            .every((item) => ["accepted", "seen"].includes(item.delivery)),
        ),
      )
      .toBe(true);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      const boxes = await links.evaluateAll((items) =>
        items.map((item) => {
          const r = item.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        }),
      );
      expect(boxes[0].y).toBe(boxes[1].y);
      expect(boxes[2].y).toBe(boxes[3].y);
      expect(boxes[2].y).toBeGreaterThan(boxes[0].bottom);
      expect(boxes[1].x).toBeGreaterThan(boxes[0].right);
      await page.screenshot({
        path: testInfo.outputPath(`mixed-${width}.png`),
      });
    }
    await links.last().click();
    const viewer = page.getByRole("dialog");
    await expect(viewer.getByText("4 / 5", { exact: true })).toBeVisible();
    await expect(
      viewer.getByRole("heading", { name: "photo-2.svg", exact: true }),
    ).toBeVisible();
    // The image stage is replaced between mixed-gallery items. Keep keyboard
    // navigation working after focus was inside the departing stage.
    await viewer.getByRole("group", { name: "Image gallery" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(viewer.getByText("5 / 5", { exact: true })).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(viewer.getByText("4 / 5", { exact: true })).toBeVisible();
    await viewer
      .getByRole("button", { name: "Next media", exact: true })
      .click();
    await expect(viewer.getByText("5 / 5", { exact: true })).toBeVisible();
    await expect(
      viewer.getByRole("heading", { name: "photo-3.svg", exact: true }),
    ).toBeVisible();
    await expect(
      viewer.getByRole("button", { name: "Next media", exact: true }),
    ).toBeDisabled();
    for (let index = 4; index >= 1; index--) {
      await viewer
        .getByRole("button", { name: "Previous media", exact: true })
        .click();
      await expect(
        viewer.getByText(`${index} / 5`, { exact: true }),
      ).toBeVisible();
    }
    await expect(viewer).toHaveAttribute("aria-label", "Video review");
    await expect(
      viewer.getByRole("heading", { name: "clip.mp4", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => viewer.locator("video").evaluate((video) => video.readyState))
      .toBeGreaterThanOrEqual(2);
    await viewer
      .getByRole("button", { name: "Close fullscreen viewer", exact: true })
      .click();
    await expect(links.last()).toBeFocused();
  } finally {
    await server.close();
  }
});

// Browser-only: posted full-frame layout, focus scrolling and real viewer wiring.
test("posted image previews keep every image reachable beside documents", async ({
  page,
  browserName,
}, testInfo) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
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
    const pictures = Array.from({ length: 8 }, (_, i) => ({
      name: `sample-${i + 1}.svg`,
      mimeType: "image/svg+xml",
      buffer: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${i % 2 ? 400 : 900}" height="600"><rect width="100%" height="100%" fill="${i % 2 ? "#d9e7e3" : "#ebdfd4"}"/><circle cx="200" cy="180" r="90" fill="#cda97c"/><path d="M0 600 L250 250 L650 600" fill="#859e89"/><text x="30" y="60" font-size="32">${i + 1}</text></svg>`,
      ),
    }));
    await form.getByLabel("Choose attachments").setInputFiles([
      {
        name: "Design-review.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\nSynthetic fixture"),
      },
      {
        name: "Meeting-notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Sample notes"),
      },
      ...pictures,
    ]);
    await expect(form.getByText(/Ready$/)).toHaveCount(10);
    await form.getByRole("textbox").fill("Design references and review notes");
    await form
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    const images = history.getByRole("group", {
      name: "8 images",
      exact: true,
    });
    const links = images.getByRole("link");
    await expect(links).toHaveCount(4);
    await expect(links.last()).toHaveText("+5");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.composerFixture
            .pending()
            .every((item) => ["accepted", "seen"].includes(item.delivery)),
        ),
      )
      .toBe(true);
    await expect(history.getByText("8 images", { exact: true })).toHaveCount(0);
    const viewer = page.getByRole("dialog", {
      name: "Image viewer",
      exact: true,
    });
    // macOS WebKit only tabs to links with Option held.
    const optionTab = browserName === "webkit" && process.platform === "darwin";
    const forward = optionTab ? "Alt+Tab" : "Tab";
    const backward = optionTab ? "Shift+Alt+Tab" : "Shift+Tab";
    for (const [width, fontSize] of [
      [390, 16],
      [768, 16],
      [1280, 16],
      [390, 20],
      [1280, 20],
    ]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      await page.setViewportSize({ width, height: 950 });
      await expect(images).toBeVisible();
      const geometry = await links.evaluateAll((items) =>
        items.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        }),
      );
      for (let index = 0; index < geometry.length; index += 2) {
        expect(geometry[index + 1].top).toBe(geometry[index].top);
        expect(geometry[index + 1].left).toBeGreaterThan(geometry[index].right);
        if (index >= 2)
          expect(geometry[index].top).toBeGreaterThan(
            geometry[index - 2].bottom,
          );
        expect(
          geometry[index].right - geometry[index].left,
        ).toBeLessThanOrEqual((180 * fontSize) / 16);
      }
      for (const link of await links.all())
        await expect(link.locator("img")).toHaveCSS("object-fit", "contain");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const files = history.getByRole("link", {
        name: /Download (Design-review.pdf|Meeting-notes.md)/,
      });
      await expect(files).toHaveCount(2);
      const boxes = await files.evaluateAll((items) =>
        items.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        }),
      );
      expect(boxes[1].x > boxes[0].right || boxes[1].y > boxes[0].bottom).toBe(
        true,
      );
      await links.first().focus();
      for (let i = 1; i < 4; i++) await page.keyboard.press(forward);
      await expect(links.last()).toBeFocused();
      await expect.poll(() => links.last().evaluate(insideHistory)).toBe(true);
      await expect(links.last()).toHaveCSS("outline-style", "solid");
      // A declared outline can still be clipped away. Compare actual pixels
      // while changing only its color, not focus, scrolling, or layout.
      await links
        .last()
        .evaluate((el) => el.setAttribute("data-focus-probe", ""));
      const mask = [links.locator("img, canvas")];
      const focused = await history.screenshot({ mask });
      const hiddenOutline = await history.screenshot({
        mask,
        style: "[data-focus-probe] { outline-color: transparent !important; }",
      });
      expect(focused.equals(hiddenOutline)).toBe(false);
      await links
        .last()
        .evaluate((el) => el.removeAttribute("data-focus-probe"));
      await expect(history.getByText("8 images", { exact: true })).toHaveCount(
        0,
      );
      for (let i = 2; i >= 0; i--) {
        await page.keyboard.press(backward);
        await expect(links.nth(i)).toBeFocused();
        await expect
          .poll(() => links.nth(i).evaluate(insideHistory))
          .toBe(true);
      }
      // A held pointer press must not move the preview under the pointer.
      await expect
        .poll(() =>
          links
            .first()
            .locator("img")
            .evaluate(
              (el) =>
                el.naturalWidth > 0 &&
                getComputedStyle(el).visibility === "visible",
            ),
        )
        .toBe(true);
      await links.first().hover();
      await expect
        .poll(() =>
          links.first().evaluate((el) => {
            const frame = el.getBoundingClientRect();
            return (
              getComputedStyle(el.closest("ol")).pointerEvents !== "none" &&
              el.contains(
                document.elementFromPoint(
                  frame.left + frame.width / 2,
                  frame.top + frame.height / 2,
                ),
              )
            );
          }),
        )
        .toBe(true);
      const beforePress = await links.first().boundingBox();
      await page.mouse.down();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      expect(await links.first().boundingBox()).toEqual(beforePress);
      await page.mouse.up();
      await expect(viewer).toBeVisible();
      await expect(viewer).not.toHaveAttribute("data-review-opening");
      await viewer
        .getByRole("button", { name: "Close fullscreen viewer" })
        .click();
      await expect(viewer).toHaveCount(0);
      await links.first().focus();
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) =>
            document.documentElement.setAttribute("data-color-mode", theme),
          theme,
        );
        await page
          .getByRole("article", { name: "Conversation", exact: true })
          .screenshot({
            path: testInfo.outputPath(
              `images-${width}-${fontSize}-${theme}.png`,
            ),
            style:
              '[aria-label="App notifications"] { visibility: hidden !important; }',
          });
      }
    }
    await links.last().focus();
    const lastSource = await links.last().locator("img").getAttribute("src");
    await page.keyboard.press("Enter");
    await expect(
      viewer.getByRole("img", { name: "Attachment preview" }),
    ).toHaveAttribute("src", lastSource);
    await expect(viewer.getByText("4 / 8", { exact: true })).toBeVisible();
    await expect(
      viewer.getByRole("heading", { name: "sample-4.svg", exact: true }),
    ).toBeVisible();
    for (let index = 5; index <= 8; index++) {
      await page.keyboard.press("ArrowRight");
      await expect(
        viewer.getByText(`${index} / 8`, { exact: true }),
      ).toBeVisible();
      await expect(
        viewer.getByRole("heading", {
          name: `sample-${index}.svg`,
          exact: true,
        }),
      ).toBeVisible();
    }
    await expect(
      viewer.getByRole("img", { name: "Attachment preview" }),
    ).not.toHaveAttribute("src", lastSource);
    await expect(
      viewer.getByRole("button", { name: "Next image", exact: true }),
    ).toBeDisabled();
    await viewer
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(links.last()).toBeFocused();

    // Pointer activation uses the new shared-image motion; keyboard skips it.
    await page.evaluate(() => {
      window.imageMotionFrames = [];
      const animate = HTMLElement.prototype.animate;
      HTMLElement.prototype.animate = function (frames, options) {
        if (this.hasAttribute("data-review-media"))
          window.imageMotionFrames.push(frames);
        return animate.call(this, frames, options);
      };
    });
    await links.first().click();
    await expect(viewer).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.imageMotionFrames.length))
      .toBeGreaterThan(0);
    await expect(viewer).not.toHaveAttribute("data-review-opening");
    const motion = await page.evaluate(() => {
      const media = document.querySelector("[data-review-media]");
      const bounds = media.getBoundingClientRect();
      const height =
        bounds.height -
        (parseFloat(getComputedStyle(media).paddingBottom) || 0);
      const tile = document.querySelector("[data-media-preview]");
      const image = tile.querySelector("img");
      const aspect = image.naturalWidth / image.naturalHeight;
      const preview = tile.getBoundingClientRect();
      const containedWidth = Math.min(preview.width, preview.height * aspect);
      const targetWidth = Math.min(bounds.width, height * aspect);
      return {
        frames: window.imageMotionFrames,
        scale: containedWidth / targetWidth,
      };
    });
    const start = motion.frames[0][0];
    expect(Number(start.transform.match(/scale\(([^)]+)\)/)[1])).toBeCloseTo(
      motion.scale,
      5,
    );
    expect(start.clipPath).toBeTruthy();
    await expect(viewer).not.toHaveAttribute("data-review-opening");
    await viewer
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(viewer).toHaveCount(0);
    await expect(links.first()).toBeFocused();
  } finally {
    await server.close();
  }
});
