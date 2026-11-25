import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({ productionBroker: true });

// Records the payload of each engine's real copy event for the selection.
async function copySelection(page, browserName) {
  await page.evaluate(() => {
    window.__copyPayload = undefined;
    document.addEventListener(
      "copy",
      (event) => {
        window.__copyPayload = {
          prevented: event.defaultPrevented,
          text: event.clipboardData?.getData("text/plain"),
          html: event.clipboardData?.getData("text/html"),
        };
      },
      { once: true },
    );
  });
  if (browserName === "webkit") {
    // Headless WebKit does not dispatch Copy for selected non-editable content
    // from keyboard input on Linux; the browser copy command uses the real
    // selection and document listeners rather than a synthetic event.
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  } else {
    await page.keyboard.press("ControlOrMeta+c");
  }
}

// Browser-only contract: a native pointer selection across a mention button and
// a channel anchor, serialized by each engine's real copy event. The walker's
// case matrix lives in src/features/messages/selection-copy.test.tsx.
test("copying a timeline selection keeps mentions, channel refs and links in both flavors", async ({
  page,
  app,
  browserName,
}) => {
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Ping @Fixture Reader about #Beta and https://example.test/docs",
    true,
    true,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(
    row
      .locator("p")
      .getByRole("button", { name: "View Fixture Reader profile" }),
  ).toBeVisible();
  await expect(row.getByRole("link", { name: "#Beta" })).toBeVisible();
  const paragraph = row.locator("p").first();
  const box = await paragraph.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  test.info().annotations.push({
    type: "pointer selection",
    description: JSON.stringify(selected),
  });
  expect(selected).toBe(
    "Ping Fixture Reader about Beta and https://example.test/docs",
  );
  await copySelection(page, browserName);
  await expect
    .poll(() => page.evaluate(() => window.__copyPayload))
    .toEqual({
      prevented: true,
      text: "Ping @Fixture Reader about #Beta and https://example.test/docs",
      html: `<div data-buzz-copy="timeline"><p>Ping <a href="nostr:${npubEncode(app.viewer)}">@Fixture Reader</a> about <a href="buzz://channel/beta">#Beta</a> and <a href="https://example.test/docs">https://example.test/docs</a></p></div>`,
    });
});

// Browser-only contract: where a pointer drag released on or beside a file card
// ends the selection, which decides whether the card copies as a link. The
// cards' case matrix lives in src/features/messages/selection-copy.test.tsx.
test("copying a drag through a file card leaves out its second line", async ({
  page,
  app,
  browserName,
}) => {
  await open(page, app);
  const external = "https://fixture.test/media/report.pdf";
  const hosted = `https://primary.example/media/${"a".repeat(64)}.zip`;
  const linked = {
    text: `Notes\nreport.pdf (${external})`,
    html: `<p>Notes</p><p><a href="${external}">report.pdf</a></p>`,
  };
  const named = (name) => ({
    text: `Notes\n${name}`,
    html: `<p>Notes</p><p>${name}</p>`,
  });
  for (const [name, url, label, whole] of [
    ["report.pdf", external, "Open report.pdf", linked],
    ["archive.zip", hosted, "Download archive.zip", named("archive.zip")],
  ]) {
    const event = app.append(
      "primary",
      "alpha",
      `Notes\n\n[${name}](<${url}>)`,
      true,
      false,
      undefined,
      undefined,
      [["imeta", `url ${url}`, "size 2516582"]],
    );
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    const card = row.getByRole("link", { name: label, exact: true });
    await expect(card).toBeVisible();
    await settle(page);
    const caption = await row.locator("p").first().boundingBox();
    const box = await card.boundingBox();
    const arrow = await card.locator("> svg").boundingBox();
    // The middle of the size's own glyphs, not of its wider line box.
    const size = await card.getByText("2 MB").evaluate((element) => {
      const glyphs = document.createRange();
      glyphs.selectNodeContents(element);
      const { x, y, width, height } = glyphs.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    });
    for (const [release, x, y, expected] of [
      ["on the size", size.x, size.y, named(name)],
      [
        "on the arrow",
        arrow.x + arrow.width / 2,
        arrow.y + arrow.height / 2,
        whole,
      ],
      [
        "right of the card",
        box.x + box.width + 40,
        box.y + box.height / 2,
        whole,
      ],
    ]) {
      // A press on the last selection would drag its text, not select anew.
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.mouse.move(caption.x + 1, caption.y + caption.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 12 });
      await page.mouse.up();
      await copySelection(page, browserName);
      await expect
        .poll(() => page.evaluate(() => window.__copyPayload), {
          message: `${name}, released ${release}`,
        })
        .toEqual({
          prevented: true,
          text: expected.text,
          html: `<div data-buzz-copy="timeline">${expected.html}</div>`,
        });
    }
  }
});
