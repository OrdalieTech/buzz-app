import { test, expect } from "./source-fixture.mjs";

// Real contenteditable key/default-action boundary; unit tests own the ranking matrix.
test("Space commits a unique exact identity but leaves namesakes as prose", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html?delayed-profiles");
  await page.evaluate(() => window.mentionFixture.releaseProfiles());
  const input = page.getByRole("textbox", { name: "Message #General" });
  // Exact-name Space must not create intent inside an actual rich-editor code span.
  await input.fill("`@Mary Jane`");
  await input.evaluate((el) => el.setSelectionRange(11, 11));
  await input.press("Space");
  await expect(input).toHaveJSProperty("value", "`@Mary Jane `");
  await expect(input.locator(".inline-chip")).toHaveCount(0);
  // A member's exact name selects without waiting for the directory search
  // (README section 5), so typing straight on cannot race it.
  await page.evaluate(() => window.mentionFixture.holdSearches());
  await input.fill("@Mary Jane");
  await expect(
    page.getByRole("option", { name: "Mary Jane", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.mentionFixture
          .heldSearches()
          .some((s) => s.toLowerCase() === "mary jane"),
      ),
    )
    .toBe(true);
  await input.press("Space");
  await expect(input.locator(".inline-chip")).toHaveText("@Mary Jane");
  await page.evaluate(() => window.mentionFixture.releaseSearches());
  await input.pressSequentially("hello");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mentionFixture.publications.filter((e) => e.kind === 9).length,
      ),
    )
    .toBe(1);
  const sent = await page.evaluate(() => ({
    event: window.mentionFixture.publications.find((e) => e.kind === 9),
    key: window.mentionFixture.first,
  }));
  expect(sent.event.tags).toContainEqual(["p", sent.key]);
  await page.goto("/tests/fixtures/mentions.html");
  await input.fill("@Honey");
  await expect(page.getByRole("option", { name: /^Honey/ })).toHaveCount(2);
  await input.press("Space");
  await expect(input).toHaveJSProperty("value", "@Honey ");
  await expect(input.locator(".inline-chip")).toHaveCount(0);
});

test("an open list preserves keys and highlight when membership is revoked", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.fill("@Honey");
  const rows = page.getByRole("option");
  await expect(rows).toHaveCount(2);
  // Let the directory page settle, so it cannot race the revocation below.
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.searches()))
    .toContain("Honey");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.reads().pending))
    .toBe(0);
  const rowKeys = () =>
    rows.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-completion-id")),
    );
  const before = await rowKeys();
  const revokedKey = await page.evaluate(() => window.mentionFixture.first);
  const removed = page
    .getByRole("option")
    .and(page.locator(`[data-completion-id="${revokedKey}"]`));
  if ((await removed.getAttribute("aria-selected")) !== "true")
    await input.press("ArrowDown");
  await expect(removed).toHaveAttribute("aria-selected", "true");
  const selectedId = await input.getAttribute("aria-activedescendant");
  await page.evaluate(() => window.mentionFixture.removeFirst());
  // The directory still finds the removed person, so the row stays, now
  // disabled until the list is reopened for a fresh review.
  await expect(
    page.getByRole("option", { name: /Channel membership changed/ }),
  ).toHaveAttribute("aria-disabled", "true");
  const archived = page.getByRole("option", {
    name: /Channel membership changed/,
  });
  await expect(archived).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", selectedId);
  const position = before.indexOf(revokedKey);
  await expect(rows.nth(position)).toHaveAttribute("aria-disabled", "true");
  await input.press("Enter");
  await expect(input).toHaveJSProperty("value", "@Honey");
  await expect(input.locator(".inline-chip")).toHaveCount(0);
  expect(
    await page.evaluate(() => window.mentionFixture.publications.length),
  ).toBe(0);
  expect(before).toHaveLength(2);
});

// The real editor, dialog focus contract, directory and signed writer must agree.
test("outside people survive Close and send reference-only with Send anyway", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html?nonmember-admission");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.fill("@Outside");
  await page.getByRole("option", { name: /^Outside Person / }).click();
  await expect(input.locator(".inline-chip")).toHaveText("@Outside Person");
  await input.pressSequentially("hello");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Mention people outside this channel?",
  });
  await expect(dialog).toBeVisible();
  // block/buzz parity: this fixture cannot add members, so no Invite or Cancel.
  await expect(dialog.getByRole("button", { name: "Invite" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("value", "@Outside Person hello");
  expect(await page.evaluate(() => window.mentionFixture.publications)).toEqual(
    [],
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Send anyway", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  const { event, key } = await page.evaluate(() => ({
    event: window.mentionFixture.publications[0],
    key: window.mentionFixture.outsider,
  }));
  expect(event.kind).toBe(9);
  expect(event.tags).toContainEqual(["mention", key]);
  expect(event.tags.filter((tag) => tag[0] === "p")).toEqual([]);
  expect(event.content).toBe("@Outside Person hello");
  await expect(input).toHaveJSProperty("value", "");
});

// Nobody can be added to a DM, so there is no choice to ask about.
test("a DM sends outside people as references without asking", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html?nonmember-admission&dm");
  // Fixture-only label: the &dm fixture keeps the "General" name, so the
  // textbox label is not what a real DM composer shows.
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.fill("@Outside");
  const option = page.getByRole("option", { name: /^Outside Person / });
  await expect(option).toContainText("Not in DM · Will not be notified");
  await option.click();
  await expect(input.locator(".inline-chip")).toHaveText("@Outside Person");
  await input.pressSequentially("hello");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const { event, key } = await page.evaluate(() => ({
    event: window.mentionFixture.publications[0],
    key: window.mentionFixture.outsider,
  }));
  expect(event.tags).toContainEqual(["mention", key]);
  expect(event.tags.filter((tag) => tag[0] === "p")).toEqual([]);
  expect(event.content).toBe("@Outside Person hello");
  await expect(input).toHaveJSProperty("value", "");
});
