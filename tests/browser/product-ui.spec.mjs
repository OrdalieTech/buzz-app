import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

let server;
let url;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/product-ui.html`;
});
test.afterAll(async () => {
  await server?.close();
});

// Browser-only: actual text/control geometry, focus and source selection.
test("production composer catalogue preserves source and controls at responsive widths", async ({
  page,
}, testInfo) => {
  await page.goto(url);
  const playground = page.getByRole("region", { name: "Composer playground" });
  const input = playground.getByRole("textbox");
  const source = "**Markdown** [label](https://example.com/path)";
  await input.fill(source);
  await expect(
    playground.getByRole("button", { name: "Mention a member", exact: true }),
  ).toBeVisible();
  await expect(
    playground.getByRole("button", { name: "Toggle formatting" }),
  ).toBeVisible();
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    const form = playground.getByRole("form");
    const bounds = await form.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    for (const control of await form.getByRole("button").all()) {
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    }
    await expect(input).toHaveJSProperty("value", source);
    await page.screenshot({
      path: testInfo.outputPath(`composer-${width}.png`),
    });
  }
  await input.focus();
  await page.keyboard.press("ControlOrMeta+a");
  const copied = await input.evaluate((element) => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return clipboardData.getData("text/plain");
  });
  expect(copied).toBe(source);
  await page.keyboard.press("Tab");
  const tool = page.locator(":focus");
  await expect(tool).toHaveRole("button");
  await expect(tool).toHaveCSS("outline-style", "solid");
  await expect(tool).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS("outline-style", "none");
  await expect(input).toHaveJSProperty("value", source);
});

test("catalogue preserves disabled, read-only and failed-send recovery examples", async ({
  page,
}) => {
  await page.goto(url);
  await expect(
    page
      .getByRole("region", { name: "Unavailable", exact: true })
      .getByRole("textbox"),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("region", { name: "Read only", exact: true }),
  ).toContainText("supports reading only");
  const recovery = page.getByRole("region", {
    name: "Validation and recovery",
  });
  await recovery.getByRole("button", { name: "Send message" }).click();
  await expect(recovery.getByRole("alert")).toContainText(
    "Your message is still here",
  );
  await expect(recovery.getByRole("textbox")).toHaveJSProperty(
    "value",
    "Retry this message",
  );
});

// Browser-only: choose real picker entries and observe inline chip relabeling.
test("playground distinguishes same-name people and agents in the real composer", async ({
  page,
}) => {
  await page.goto(url);
  const playground = page.getByRole("region", { name: "Composer playground" });
  const chips = playground.getByRole("textbox").locator(".inline-chip");
  const labels = [];
  for (const [name, keys] of [
    ["Alice", ["a".repeat(64), "c".repeat(64)]],
    ["Honey", ["b".repeat(64), "d".repeat(64)]],
  ]) {
    for (const key of keys) {
      const label = `${name} · ${npubEncode(key).slice(-4)}`;
      await playground
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      await expect(dialog).toBeVisible();
      // The community search settles after the dialog opens and its status
      // line leaves the flow above the rows; a click across that moment
      // lands on two different rows and reaches neither.
      await expect(dialog.getByText("Searching community…")).toHaveCount(0);
      await dialog
        .getByRole("button")
        .and(page.locator(`[data-mention-choice="${key}"]`))
        .click();
      labels.push(`@${label}`);
      await expect(chips).toHaveText(labels);
    }
  }
});
