import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

async function pageAction(page, article, name) {
  await article.getByRole("button", { name: "Doc actions" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function expectDocumentAtBottom(article) {
  const contents = article.getByRole("region", { name: "Doc contents" });
  await expect(
    article.getByRole("group", { name: "Document formatting" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      contents.evaluate((region) =>
        Math.abs(
          region.getBoundingClientRect().bottom -
            region.closest("article").getBoundingClientRect().bottom,
        ),
      ),
    )
    .toBeLessThanOrEqual(1);
}

test("continues editing through creation and a background save", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bundled-docs.html");
  await page.getByRole("button", { name: "New doc" }).click();
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toBeFocused();
  await title.fill("Draft plan");
  const created = page.getByRole("article", { name: "Draft plan" });
  await expect(created.getByRole("status")).toHaveText(/^Saved /);
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("Draft plan");
  await page.evaluate(() => window.docsFixture.holdSaveReceipt());
  try {
    await title.fill("Updated plan");
    await expect(created.getByRole("status")).toHaveText("Saving…");
    await expect(title).toBeFocused();
    await expect(
      created.getByRole("combobox", { name: "Doc mode" }),
    ).toBeEnabled();
    await pageAction(page, created, "Markdown source");
    await created
      .getByRole("textbox", { name: "Markdown", exact: true })
      .fill("Draft written with a save in flight.");
  } finally {
    await page.evaluate(() => window.docsFixture.releaseSaveReceipt());
  }
  const updated = page.getByRole("article", { name: "Updated plan" });
  await expect(updated.getByRole("status")).toHaveText(/^Saved /);
  await expect(
    updated.getByRole("textbox", { name: "Markdown", exact: true }),
  ).toHaveValue("Draft written with a save in flight.");
});

test("opens a Trash-only list, searches by retained title, and exits from the search bar", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bundled-docs.html");
  const title = "Connected docs plan";
  const activeLink = page.getByRole("link", { name: title, exact: true });
  const filter = page.getByRole("button", { name: "Filter docs" });
  const trashFilter = page.getByRole("menuitemcheckbox", {
    name: "Show Trash",
  });
  await expect(activeLink).toBeVisible();
  await activeLink.click();
  await pageAction(
    page,
    page.getByRole("article", { name: title }),
    "Move to Trash",
  );
  const confirm = page.getByRole("dialog", { name: "Move this doc to Trash?" });
  await confirm.getByRole("button", { name: "Move to Trash" }).click();
  const deleted = page.getByRole("article", { name: `${title} (in Trash)` });
  await expect(deleted).toBeVisible();
  await page.getByRole("button", { name: "Back to docs", exact: true }).click();
  const docs = page.getByRole("list", { name: "Docs" });
  await expect(activeLink).toHaveCount(0);
  await filter.press("Enter");
  await trashFilter.press("Enter");
  const search = page.getByRole("searchbox", { name: "Search Trash" });
  const trash = page.getByRole("list", { name: "Trash" });
  const trashedLink = trash.getByRole("link", { name: `${title} (in Trash)` });
  await expect(search).toBeFocused();
  await expect(trashedLink).toBeVisible();
  await expect(trash.getByRole("link")).toHaveCount(1);
  await page.goBack();
  await expect(docs).toBeVisible();
  await page.goForward();
  await expect(trashedLink).toBeVisible();
  await search.fill("Storage research");
  await expect(
    page.getByText("No matching docs in Trash.", { exact: true }),
  ).toBeVisible();
  await search.fill("Connected docs");
  await expect(trashedLink).toBeVisible();
  await search.fill("");
  await trashedLink.click();
  await deleted.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByRole("article", { name: title, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to docs", exact: true }).click();
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await page.getByRole("button", { name: "Exit Trash" }).click();
  await expect(
    docs.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
});

// Browser boundary: plugin composition, native rich editing, mounted live delivery,
// retained view state and responsive layout. Policy permutations live in Vitest.
test("edits and preserves drafts using host UI, then adopts an agent revision without rewriting it", async ({
  browserName,
  context,
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/bundled-docs.html");
  await expect(
    page.getByRole("link", { name: "Agent outline", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const f = window.docsFixture;
    return f.agentEdit(f.agentDoc, "Fresh unopened collection body");
  });
  const search = page.getByRole("searchbox", { name: "Search docs" });
  await search.fill("Fresh unopened collection body");
  await expect(
    page.getByRole("link", { name: "Agent outline", exact: true }),
  ).toBeVisible();
  await search.fill("");
  const shared = page.getByRole("link", {
    name: "Shared research",
    exact: true,
  });
  await shared.click();
  const sharedDoc = page.getByRole("article", {
    name: "Shared research",
    exact: true,
  });
  const sharedMode = sharedDoc.getByRole("combobox", { name: "Doc mode" });
  const modeHint = page.getByRole("tooltip").filter({
    hasText: "You have read-only access.",
  });
  await expect(sharedMode).toBeDisabled();
  await expect(sharedMode).toHaveText("Viewing");
  await sharedMode.hover();
  await expect(modeHint).toBeVisible();
  await sharedDoc
    .getByRole("heading", { name: "Shared research" })
    .first()
    .hover();
  await expect(modeHint).toBeHidden();
  await page.getByRole("button", { name: "Back to docs" }).focus();
  await page.keyboard.press("Tab");
  await expect(
    sharedDoc.getByRole("group", { name: "Doc mode" }),
  ).toBeFocused();
  await expect(modeHint).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(sharedMode).toHaveAttribute("aria-expanded", "false");
  await page.goBack();
  await expect(shared).toBeVisible();
  await page.goForward();
  await expect(sharedDoc).toBeVisible();
  await page.getByRole("button", { name: "Back to docs", exact: true }).click();
  await expect(search).toBeFocused();
  await page
    .getByRole("link", { name: "Connected docs plan", exact: true })
    .click();
  const article = page.getByRole("article", {
    name: "Connected docs plan",
    exact: true,
  });
  await article.getByRole("button", { name: "Doc actions" }).click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Move to Trash" }),
  ).toHaveAttribute("data-tone", "danger");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await article.getByRole("button", { name: "Share doc" }).click();
  const share = page.getByRole("dialog", { name: "Share access" });
  await share.getByRole("button", { name: "Copy link" }).click();
  await expect(
    share.getByRole("button", { name: "Link copied" }),
  ).toBeVisible();
  await share.getByRole("button", { name: "Close", exact: true }).click();
  await expect(share).toBeHidden();
  const body = article.getByRole("textbox", { name: "Doc body", exact: true });
  const [h1, h2] = await article
    .getByRole("heading", { name: /Connected docs|Supporting research/ })
    .evaluateAll((headings) =>
      headings.map((heading) =>
        Number.parseFloat(getComputedStyle(heading).fontSize),
      ),
    );
  expect(h1 / h2).toBeGreaterThan(1);
  expect(h1 / h2).toBeLessThan(1.3);
  await body.fill("");
  await body.pressSequentially("[[");
  await expect(body).toHaveText("[[");
  await article.getByRole("button", { name: "Link", exact: true }).click();
  const linkDialog = page.getByRole("dialog", { name: "Add link" });
  await expect(linkDialog.getByRole("textbox", { name: "URL" })).toBeVisible();
  await expect(
    linkDialog.getByRole("combobox", { name: "Link destination" }),
  ).toHaveCount(0);
  await linkDialog.getByRole("textbox", { name: "Text" }).fill("Example");
  await linkDialog
    .getByRole("textbox", { name: "URL" })
    .fill("https://example.org/");
  await linkDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(body.getByRole("link", { name: "Example" })).toHaveAttribute(
    "href",
    "https://example.org/",
  );
  await body.fill("A draft retained while browsing.");
  await page.getByRole("button", { name: "Back to docs", exact: true }).click();
  await page
    .getByRole("link", { name: "Connected docs plan", exact: true })
    .click();
  await expect(body).toHaveText("A draft retained while browsing.");
  await expect(article.getByRole("status")).toHaveText(/^Saved /);
  await expect(
    article.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  const remote = "# Agent update\n\n- retain spacing\n- no echo\n";
  const saved = await page.evaluate(
    (markdown) =>
      window.docsFixture.agentEdit(window.docsFixture.plan, markdown),
    remote,
  );
  await expect(body).toContainText("Agent update");
  await expect(
    body.getByRole("heading", { level: 1, name: "Agent update" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.docsFixture.head(window.docsFixture.plan.id).revision,
      ),
    )
    .toBe(saved.revision);
  expect(saved.message).toBe(`[Connected docs plan](<${saved.link}>)`);
  await pageAction(page, article, "Revision history");
  const currentRevision = page.getByRole("menuitem", {
    name: /Connected docs plan.*Carl.*Current/,
  });
  await expect(currentRevision).toBeVisible();
  const olderRevision = page
    .getByRole("menuitem", { name: /Connected docs plan.*You/ })
    .last();
  await olderRevision.focus();
  await olderRevision.press("Enter");
  const preview = page.getByRole("dialog", { name: "Revision preview" });
  const revision = preview.getByRole("region", { name: "Selected revision" });
  await expect(revision).toContainText("You ·");
  await expect(
    revision.getByRole("heading", { name: "Connected docs", exact: true }),
  ).toHaveCSS("font-size", `${h1}px`);
  await expect(
    revision.getByRole("heading", { name: "Supporting research", exact: true }),
  ).toHaveCSS("font-size", `${h2}px`);
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(
    article.getByRole("button", { name: "Doc actions" }),
  ).toBeFocused();
  await pageAction(page, article, "Markdown source");
  await expect(
    article.getByRole("textbox", { name: "Markdown", exact: true }),
  ).toHaveValue(remote);
  const sourceDraft = `${remote}\nUnsaved source edit.`;
  await article
    .getByRole("textbox", { name: "Markdown", exact: true })
    .fill(sourceDraft);
  await pageAction(page, article, "Formatted text");
  await expect(body).toContainText("Unsaved source edit.");
  await body.evaluate((input) => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  await page.keyboard.type(" Rich edit.");
  await pageAction(page, article, "Markdown source");
  await expect(
    article.getByRole("textbox", { name: "Markdown", exact: true }),
  ).toHaveValue(`${remote}\nUnsaved source edit. Rich edit.`.trimEnd());
  await pageAction(page, article, "Formatted text");
  await expect
    .poll(() =>
      page.evaluate(
        () => window.docsFixture.head(window.docsFixture.plan.id).markdown,
      ),
    )
    .toBe(
      `${remote}
Unsaved source edit. Rich edit.`.trimEnd(),
    );
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 480]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(
        article.getByRole("button", { name: "Share doc", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expectDocumentAtBottom(article);
      await expect(
        body.getByRole("heading", { level: 1, name: "Agent update" }),
      ).toBeVisible();
      const title = article.getByRole("textbox", { name: "Title" });
      const savedTitle = await title.inputValue();
      const shortHeight = (await title.boundingBox()).height;
      await title.fill(
        "A long title about sharing documents in a conversation ".repeat(4) +
          "Revision".repeat(18),
      );
      expect((await title.boundingBox()).height).toBeGreaterThan(shortHeight);
      expect(
        await title.evaluate(
          (field) =>
            field.scrollHeight <= field.clientHeight + 1 &&
            field.scrollWidth <= field.clientWidth + 1,
        ),
      ).toBe(true);
      await title.fill(savedTitle);
      expect((await title.boundingBox()).height).toBe(shortHeight);
      await expect(article.getByRole("status")).toHaveText(/^Saved /);
      await pageAction(page, article, "Revision history");
      await expect(
        page.getByRole("menuitem", {
          name: /Connected docs plan.*You.*Current/,
        }),
      ).toBeInViewport({ ratio: 1 });
      const bounds = await page
        .getByRole("menu", { name: "Revision history" })
        .boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
    }
  }
  expect(errors.unexplained()).toEqual([]);
});

// Browser boundary: the real conversation link dispatcher must retain the
// composer and use the existing addressable panel Back/Forward/Close owner.
test("focuses the start of the document without changing its scroll position", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/bundled-docs.html");
  const link = page.getByRole("link", {
    name: "Connected docs plan",
    exact: true,
  });
  await expect(link).toBeVisible();
  await page.evaluate(() => {
    const fixture = window.docsFixture;
    const markdown = Array.from(
      { length: 28 },
      (_, i) => `${i < 2 ? "- " : ""}Paragraph ${i + 1} of the working plan.`,
    ).join("\n\n");
    return fixture.agentEdit(fixture.plan, markdown);
  });
  await link.click();
  const article = page.getByRole("article", { name: "Connected docs plan" });
  const contents = article.getByRole("region", { name: "Doc contents" });
  const mode = article.getByRole("combobox", { name: "Doc mode" });
  const toolbar = article.getByRole("group", { name: "Document formatting" });
  const body = article.getByRole("textbox", { name: "Doc body" });
  await expect(toolbar).toBeVisible();
  await expect(body).toContainText("Paragraph 28");
  await expect(body).toBeFocused();
  await expect(body).toHaveJSProperty("selectionStart", 0);
  await expect(body).toHaveJSProperty("selectionEnd", 0);
  await expect(contents).toHaveJSProperty("scrollTop", 0);
  const firstLine = contents
    .getByText("Paragraph 1 of the working plan.", { exact: true })
    .filter({ visible: true });
  const firstLineGap = async () => {
    const line = await firstLine.boundingBox();
    const control = await mode.boundingBox();
    return line.y - control.y - control.height;
  };
  const editingGap = await firstLineGap();
  await body.evaluate((field) => field.setSelectionRange(12, 12));
  await mode.click();
  await page.getByRole("option", { name: "Viewing", exact: true }).click();
  await expect(mode).toHaveText("Viewing");
  await expect(mode).toHaveAttribute("data-variant", "outline");
  await expect(toolbar).toHaveCount(0);
  expect(await firstLineGap()).toBeCloseTo(editingGap, 0);

  await page.getByRole("button", { name: "Back to docs" }).click();
  await expect(link).toBeVisible();
  await page.goBack();
  await expect(mode).toHaveText("Viewing");
  await contents.evaluate((region) => {
    region.scrollTop = 64;
  });
  await mode.click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
  await expect(toolbar).toBeVisible();
  await expect(mode).toHaveText("Editing");
  await expect(mode).toHaveAttribute("data-variant", "subtle");
  await expect(body).toBeFocused();
  await expect(body).toHaveJSProperty("selectionStart", 0);
  await expect(body).toHaveJSProperty("selectionEnd", 0);
  await expect(contents).toHaveJSProperty("scrollTop", 64);

  await mode.click();
  await page.getByRole("option", { name: "Viewing", exact: true }).click();
  await expect(mode).toHaveText("Viewing");
  await expect(contents).toHaveJSProperty("scrollTop", 64);
});

test("opens a doc beside the conversation and preserves host history and live edits", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/bundled-docs.html");
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  const reference = page.getByRole("link", {
    name: "Connected docs plan",
    exact: true,
  });
  await reference.focus();
  await reference.press("Enter");
  const article = page.getByRole("article", {
    name: "Connected docs plan",
    exact: true,
  });
  await expect(article).toBeVisible();
  await expectDocumentAtBottom(article);
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  const remote = "Updated through the agent tool beside the conversation.";
  await page.evaluate(
    (markdown) =>
      window.docsFixture.agentEdit(window.docsFixture.plan, markdown),
    remote,
  );
  await expect(
    article.getByRole("textbox", { name: "Doc body", exact: true }),
  ).toHaveText(remote);
  await page.goBack();
  await expect(article).toBeHidden();
  await page.goForward();
  await expect(article).toBeVisible();
  const tab = page.getByRole("tab", {
    name: "Connected docs plan",
    exact: true,
  });
  await tab.click({ button: "middle" });
  await expect(article).toBeHidden();
  await page.goBack();
  await page.goForward();
  await expect(article).toBeHidden();
  await reference.click();
  await expect(article).toBeVisible();
  await tab.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Open in Docs", exact: true })
    .click();
  const docs = page.getByRole("region", { name: "Doc details" });
  await expect(
    docs.getByRole("article", { name: "Connected docs plan" }),
  ).toBeVisible();
  await page.goBack();
  await expect(tab).toBeVisible();
  await pageAction(page, article, "Open in Docs");
  await expect(
    docs.getByRole("article", { name: "Connected docs plan" }),
  ).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});
