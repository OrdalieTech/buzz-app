import { test, expect } from "./source-fixture.mjs";

// Native contenteditable selection, browser history and clipboard dispatch must
// pass through the actual MessageComposer; serializer matrices live in unit tests.
test("bold toolbar and shortcut share selection, continued typing, history and draft restore", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off"),
  );
  await page.goto("/tests/fixtures/link-messages.html");
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  await input.fill("one two");
  await input.evaluate((el) => el.setSelectionRange(0, 3));
  await page
    .getByRole("button", { name: "Toggle formatting", exact: true })
    .click();
  const bold = page.getByRole("button", { name: "Bold", exact: true });
  await bold.click();
  await expect(input.locator("strong")).toHaveText("one");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  const copy = () =>
    input.evaluate((el) => {
      const clipboardData = new DataTransfer();
      el.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return clipboardData.getData("text/plain");
    });
  expect(await copy()).toBe("**one**");
  await input.press("ControlOrMeta+z");
  await expect(input.locator("strong")).toHaveCount(0);
  await input.press("ControlOrMeta+Shift+z");
  await expect(input.locator("strong")).toHaveText("one");
  await input.press("ControlOrMeta+b");
  await expect(input.locator("strong")).toHaveCount(0);
  await input.press("ControlOrMeta+b");
  await input.evaluate((el) => el.setSelectionRange(3, 3));
  await page.keyboard.type(" more ");
  await expect(input.locator("strong")).toHaveText("one more ");
  await input.press("ControlOrMeta+b");
  await page.keyboard.type("plain");
  await expect(input).toHaveJSProperty("value", "one more plain two");
  await page.reload();
  await expect(input.locator("strong")).toHaveText("one more ");
  await input.press("Enter");
  expect(await page.evaluate(() => window.linkComposerFixture.sent)).toEqual([
    { text: "**one more** plain two", mentions: [] },
  ]);
});

test("typed **Hello** becomes bold on the closing delimiter, undoes to its source and sends as Markdown", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/link-messages.html");
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  // The fixture opens with a seeded draft; typing must start from an empty editor.
  await input.fill("");
  await input.focus();
  await page.keyboard.type("**Hello**");
  await expect(input.locator("strong")).toHaveText("Hello");
  await expect(input).toHaveJSProperty("value", "Hello");
  await input.press("ControlOrMeta+z");
  await expect(input.locator("strong")).toHaveCount(0);
  await expect(input).toHaveJSProperty("value", "**Hello**");
  await input.press("ControlOrMeta+Shift+z");
  await expect(input.locator("strong")).toHaveText("Hello");
  await input.press("Enter");
  expect(await page.evaluate(() => window.linkComposerFixture.sent)).toEqual([
    { text: "**Hello**", mentions: [] },
  ]);
});

test("multiline bold copies and cuts the selected fragment without changing source", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/link-messages.html");
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  await input.fill("first\nsecond\nthird");
  await input.evaluate((el) => el.setSelectionRange(2, 9));
  await input.press("ControlOrMeta+b");
  const copied = await input.evaluate((el) => {
    const clipboardData = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return clipboardData.getData("text/plain");
  });
  expect(copied).toBe("**rst**\n**sec**");
  await expect(input).toHaveJSProperty("value", "fiond\nthird");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "first\nsecond\nthird");
  await input.press("Enter");
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.at(-1)),
  ).toEqual({
    text: "fi**rst**\n**sec**ond\nthird",
    mentions: [],
  });
});

test("bold mention completion keeps its identity and same-text replacement revokes it", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off"),
  );
  await page.goto("/tests/fixtures/mentions.html");
  const first = await page.evaluate(() => window.mentionFixture.first);
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.focus();
  await input.press("ControlOrMeta+b");
  await page.keyboard.type("@Ho");
  await page
    .getByRole("option")
    .and(page.locator(`[data-completion-id="${first}"]`))
    .click();
  await expect(input).toHaveJSProperty("value", "@Honey ");
  await expect(input.locator("strong .inline-chip")).toHaveText("@Honey");
  await input.evaluate((el) => el.setSelectionRange(2, 2));
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  const sent = await page.evaluate(() => window.mentionFixture.publications[0]);
  expect(sent.content).toBe("**@Honey**");
  expect(sent.tags.filter(([tag]) => tag === "p")).toEqual([["p", first]]);
  await input.focus();
  await input.press("ControlOrMeta+b");
  await page.keyboard.type("@Ho");
  await page
    .getByRole("option")
    .and(page.locator(`[data-completion-id="${first}"]`))
    .click();
  await expect(input).toHaveJSProperty("value", "@Honey ");
  await input.evaluate((el) => el.setSelectionRange(2, 3));
  await page.keyboard.insertText("o");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(2);
  const replaced = await page.evaluate(
    () => window.mentionFixture.publications[1],
  );
  expect(replaced.content).toBe("**@Honey**");
  expect(replaced.tags.filter(([tag]) => tag === "p")).toEqual([]);
});
