import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Picker and colon suggestions learn from one usage history that survives reload.
test("emoji chosen in the picker or suggestions rise in both, after reload too", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html");
  const input = page.getByRole("textbox", { name: "Message #general" });
  const choices = page.getByRole("option");
  const labels = () =>
    choices.locator("[data-completion-label]").allTextContents();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  const frequent = page.locator(
    'em-emoji-picker .category[data-id="frequent"] button',
  );
  const openPicker = async () => {
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    await expect(search).toBeVisible();
  };
  const openFrequent = async () => {
    await openPicker();
    await search.fill("");
    await expect(frequent.first()).toBeVisible();
  };
  const counts = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("buzz.emoji-usage.v1") ?? "{}"),
    );
  const closePicker = async () => {
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
  };

  // New users get the query order.
  await input.fill(":sm");
  await expect(choices.first()).toHaveText(/:smile:/);
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot:", ":party-parrot-wave:"]);
  // Highlighting a suggestion is not choosing it.
  await input.press("ArrowDown");
  await expect(choices.nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("Escape");
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot:", ":party-parrot-wave:"]);

  // A picker choice ranks first among its prefix matches.
  await input.fill("");
  await openPicker();
  // A fresh picker shows one row of defaults, as Emoji Mart seeds it.
  await expect(frequent).toHaveCount(8);
  await search.fill("smirk");
  await expect(
    page.locator('em-emoji-picker .category button[aria-label="😏"]').first(),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(input).toHaveJSProperty("value", "😏 ");
  // The pick focused the editor. ProseMirror restores its own selection 20 ms
  // after focus, undoing the DOM select-all `fill` makes in that window, so
  // replace the draft with the composer's own select-all, as a person would.
  await input.press("ControlOrMeta+a");
  await page.keyboard.insertText(":sm");
  await expect(choices.first()).toHaveText(/:smirk:/);
  await input.press("Tab");
  await expect(input).toHaveJSProperty("value", "😏 ");
  // The closing colon chooses the exact name too.
  await input.fill(":smirk");
  await expect(choices.first()).toHaveText(/:smirk:/);
  await input.press(":");
  await expect(input).toHaveJSProperty("value", "😏 ");

  // A keyboard suggestion choice of a community emoji teaches suggestions and
  // the picker's Frequently used row, once.
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot:", ":party-parrot-wave:"]);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", ":party-parrot-wave: ");
  await input.fill(":party-p");
  await expect.poll(labels).toEqual([":party-parrot-wave:", ":party-parrot:"]);
  await input.press("Escape");
  await input.fill("");
  const stored = await counts();
  expect(stored).toMatchObject({
    smirk: 3,
    "buzz-custom/a/party-parrot-wave": 1,
  });
  expect(stored.heart_eyes).toBeUndefined();
  await openFrequent();
  await expect(frequent.locator('img[src*="wave.png"]')).toHaveCount(1);
  await expect(frequent.and(page.locator('[aria-label="😏"]'))).toHaveCount(1);
  await closePicker();

  await page.reload();
  await input.fill(":sm");
  await expect(choices.first()).toHaveText(/:smirk:/);
  await input.press("Escape");
  await input.fill("");
  await openFrequent();
  await expect(frequent.locator('img[src*="wave.png"]')).toHaveCount(1);
  await closePicker();
  expect(errors.unexplained()).toEqual([]);
});

test("choices in two windows of one profile keep each other", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  const errors = [watchPageErrors(page), watchPageErrors(other)];
  const choose = async (window, query, label, value) => {
    const input = window.getByRole("textbox", { name: "Message #general" });
    await input.fill(query);
    await expect(window.getByRole("option").first()).toHaveText(label);
    await input.press("Tab");
    await expect(input).toHaveJSProperty("value", value);
  };
  for (const window of [page, other])
    await window.goto("/tests/fixtures/emoji.html");
  // Each window opens its picker first, so each has loaded Emoji Mart.
  for (const window of [page, other]) {
    await window
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    await window.keyboard.press("Escape");
  }
  await choose(page, ":smirk", /:smirk:/, "😏 ");
  await choose(other, ":rocket", /:rocket:/, "🚀 ");
  await choose(page, ":tada", /:tada:/, "🎉 ");
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("buzz.emoji-usage.v1") ?? "{}"),
      ),
    )
    .toEqual({ smirk: 1, rocket: 1, tada: 1 });
  for (const watched of errors) expect(watched.unexplained()).toEqual([]);
});

test("emoji a full composer cannot insert teach nothing", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/emoji.html");
  const input = page.getByRole("textbox", { name: "Message #general" });
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  const counts = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("buzz.emoji-usage.v1") ?? "{}"),
    );
  const pickRocket = async () => {
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    await search.fill("rocket");
    await page
      .locator('em-emoji-picker .category button[aria-label="🚀"]')
      .first()
      .click();
  };
  // The closing colon fits under the limit; the flag that replaces it does not.
  const draft = `${"a".repeat(16000 - 13)} :flag-wales`;
  await input.fill(draft);
  await expect(page.getByRole("option").first()).toHaveText(/:flag-wales:/);
  await input.press(":");
  await expect(input).toHaveJSProperty("value", `${draft}:`);
  // A picker choice does not fit the full draft either.
  await pickRocket();
  await expect(page.getByRole("alert")).toContainText("too long");
  await expect(input).toHaveJSProperty("value", `${draft}:`);
  expect(await counts()).toEqual({});
  await input.fill("");
  await pickRocket();
  await expect(input).toHaveJSProperty("value", "🚀 ");
  await expect.poll(counts).toEqual({ rocket: 1 });
  expect(errors.unexplained()).toEqual([]);
});

test("choosing an existing reaction removes it and teaches nothing", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/emoji.html?reactions");
  const row = page.locator("[data-message-id]").first();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  const pill = row.locator('button[data-reaction="🚀"]');
  const counts = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("buzz.emoji-usage.v1") ?? "{}"),
    );
  const actions = row
    .getByRole("group", { name: "Message actions", includeHidden: true })
    .getByRole("button", { name: "Add reaction", exact: true });
  // The second pick uses the plus beside the reactions, a separate picker.
  const inline = row
    .getByTestId("inline-add-reaction")
    .getByRole("button", { name: "Add reaction", exact: true });
  const reactRocket = async (plus) => {
    await hoverMessage(row);
    await plus.click();
    await search.fill("rocket");
    await page
      .locator('em-emoji-picker .category button[aria-label="🚀"]')
      .first()
      .click();
    await expect(search).toHaveCount(0);
  };
  await reactRocket(actions);
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await expect(pill).toHaveAttribute("aria-disabled", "false");
  await expect.poll(counts).toEqual({ rocket: 1 });
  await reactRocket(inline);
  await expect(pill).toHaveCount(0);
  expect(await counts()).toEqual({ rocket: 1 });
  // The action bar picker removes too; the inline plus needs a reaction first.
  await reactRocket(actions);
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await expect.poll(counts).toEqual({ rocket: 2 });
  await reactRocket(actions);
  await expect(pill).toHaveCount(0);
  expect(await counts()).toEqual({ rocket: 2 });
  expect(errors.unexplained()).toEqual([]);
});
