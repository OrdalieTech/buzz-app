import {
  chooseColorMode,
  openSettings,
  selectSettingsSection,
  settingsDialog,
  settingsSections,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { npubEncode } from "nostr-tools/nip19";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

test("editable instructions open formatted and scroll independently of the save footer", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.emulateMedia({
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Agent setup");
  const title = "Agent Memory";
  const instructions = settingsDialog(page).getByRole("region", {
    name: "Base instructions",
  });
  await instructions.getByRole("button", { name: /^Show all/ }).click();
  const row = instructions
    .locator('.buzz-accordion[data-variant="popout"]')
    .getByRole("button", { name: title, exact: true });
  const rowLabel = row
    .locator('span[aria-hidden="true"]')
    .filter({ hasText: title });
  const fill = (property) =>
    row.evaluate(
      (node, name) =>
        getComputedStyle(
          node.closest(".buzz-accordion-item"),
          "::before",
        ).getPropertyValue(name),
      property,
    );
  await expect(rowLabel).toHaveCSS("opacity", "1");
  expect(await fill("opacity")).toBe("0");
  const collapsedFillLeft = parseFloat(await fill("left"));
  await row.click();
  const panel = instructions.getByRole("region", { name: title, exact: true });
  const heading = panel.getByRole("heading", { name: title, exact: true });
  const editor = panel.getByRole("textbox", { name: `Your text for ${title}` });
  await expect(rowLabel).toHaveCSS("transition-property", "opacity");
  await expect(rowLabel).toHaveCSS("opacity", "0");
  expect(await fill("transition-property")).toContain("opacity");
  await expect.poll(() => fill("opacity")).toBe("1");
  expect(parseFloat(await fill("left"))).toBeLessThan(collapsedFillLeft);
  const fontSize = (locator) =>
    locator.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  expect(await fontSize(heading)).toBeGreaterThan(await fontSize(rowLabel));
  expect((await heading.boundingBox()).y).toBeLessThan(
    (await editor.boundingBox()).y,
  );
  await row.click();
  await expect(rowLabel).toHaveCSS("opacity", "1");
  await expect(heading).toHaveCount(0);
  await row.press("Enter");
  await expect(row).toBeFocused();
  await expect(rowLabel).toHaveCSS("transition-duration", "0s");
  await expect(rowLabel).toHaveCSS("opacity", "0");
  expect(await fill("transition-duration")).toBe("0s");
  expect(await fill("opacity")).toBe("1");
  await expect(heading).toBeVisible();
  const save = panel.getByRole("button", { name: "Save", exact: true });
  const cancel = panel.getByRole("button", { name: "Cancel", exact: true });
  const actions = panel.getByRole("button", {
    name: `Options for ${title}`,
  });
  await cancel.click();
  await expect(row).toBeFocused();
  await row.press("Enter");
  const actionsBounds = await actions.boundingBox();
  const cancelBounds = await cancel.boundingBox();
  expect(actionsBounds.x + actionsBounds.width).toBeLessThan(cancelBounds.x);
  expect(actionsBounds.y).toBe(cancelBounds.y);
  const expectScrollChaining = async (body, settingsScroll) => {
    const innerMax = await body.evaluate((node) => {
      const max = node.scrollHeight - node.clientHeight;
      node.scrollTop = max - 60;
      return max;
    });
    expect(innerMax).toBeGreaterThan(1);
    await body.hover();
    // Reach the edge with real input so the browser resolves pixel rounding
    // before the next wheel event tests chaining.
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() => body.evaluate((node) => node.scrollTop))
      .toBeGreaterThanOrEqual(innerMax - 1);
    const outer = await settingsScroll.evaluate((node) => ({
      top: node.scrollTop,
      max: node.scrollHeight - node.clientHeight,
    }));
    expect(outer.top).toBeLessThan(outer.max);
    await expect
      .poll(async () => {
        // Continue the gesture after the inner scroller reaches its edge.
        await page.mouse.wheel(0, 120);
        return settingsScroll.evaluate((node) => node.scrollTop);
      })
      .toBeGreaterThan(outer.top);
  };
  await expect(save).toHaveAttribute("data-variant", "prominent");
  await expect(cancel).toHaveAttribute("data-variant", "subtle");
  await expect(actions).toHaveText("Options");
  const editableHint = panel.getByText("This instruction can be changed.");
  expect((await editableHint.boundingBox()).x).toBeLessThan(
    (await cancel.boundingBox()).x,
  );
  await save.scrollIntoViewIfNeeded();
  const footerTop = (await save.boundingBox()).y;
  await editor.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(() => editor.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  expect((await save.boundingBox()).y).toBe(footerTop);
  await expectScrollChaining(
    editor,
    settingsDialog(page).locator(".buzz-dialog-navigation-layout"),
  );

  await actions.press("Enter");
  const reset = page.getByRole("menuitem", {
    name: "Set to default instruction",
    exact: true,
  });
  await reset.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Already set");
  await page.keyboard.press("Escape");
  await cancel.press("Enter");
  await expect(row).toBeFocused();
  await row.press("Enter");

  await editor.fill("Report milestones.");
  await editor.press("ControlOrMeta+a");
  await editor.press("ControlOrMeta+b");
  await expect(editor.locator("strong")).toHaveText("Report milestones.");
  await save.click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Instruction saved.")).toBeVisible();
  await expect(row).toBeFocused();
  await row.press("Enter");
  await expect(
    panel.getByRole("heading", { name: `${title} (Modified)` }),
  ).toBeVisible();
  await expect(editor.locator("strong")).toHaveText("Report milestones.");

  await actions.click();
  await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Instruction disabled.")).toBeVisible();
  await expect(row).toBeFocused();
  await row.press("Enter");
  await expect(
    panel.getByRole("heading", { name: `${title} (Disabled)` }),
  ).toBeVisible();
  const disabledText = panel.locator("[data-instruction-reading-area]");
  await row.press("Tab");
  await expect(disabledText).toBeFocused();
  await disabledText.press("End");
  await expect
    .poll(() => disabledText.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect(save).toBeDisabled();
  await expect(cancel).toBeVisible();
  await actions.press("Space");
  await page
    .getByRole("menuitem", { name: "Enable", exact: true })
    .press("Enter");
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Instruction enabled.")).toBeVisible();
  await expect(row).toBeFocused();
  await row.press("Enter");
  await expect(editor).toBeEditable();
  await expect(save).toBeDisabled();

  const pasted = "Report milestones.\nMention blockers.";
  await editor.press("ControlOrMeta+a");
  await editor.evaluate((node, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, pasted);
  await save.click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.press("Enter");
  await expect(editor).toHaveValue(pasted);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await selectSettingsSection(page, "Appearance");
  await chooseColorMode(page, "Dark");
  await page.getByRole("button", { name: "Increase interface size" }).click();
  await selectSettingsSection(page, "Agent setup");
  const readOnly = instructions.getByRole("button", {
    name: "Trust",
    exact: true,
  });
  const readOnlyLabel = readOnly
    .locator('span[aria-hidden="true"]')
    .filter({ hasText: "Trust" });
  await readOnly.click();
  await expect(readOnlyLabel).toHaveCSS("transition-duration", "0s");
  await expect(readOnlyLabel).toHaveCSS("opacity", "0");
  const readingPanel = instructions.getByRole("region", {
    name: "Trust",
    exact: true,
  });
  const readingHeading = readingPanel.getByRole("heading", {
    name: "Trust",
    exact: true,
  });
  const readingBody = readingPanel.locator("[data-instruction-reading-area]");
  expect(await fontSize(readingHeading)).toBeGreaterThan(
    await fontSize(readOnlyLabel),
  );
  expect((await readingHeading.boundingBox()).y).toBeLessThan(
    (await readingBody.boundingBox()).y,
  );
  await expect(
    readingPanel.getByRole("button", { name: "Options for Trust" }),
  ).toHaveCount(0);
  await readOnly.press("Tab");
  await expect(readingBody).toBeFocused();
  await expect(readingBody).toHaveCSS("outline-style", "solid");
  await expect(readingBody).toHaveCSS("mask-image", "none");
  await readingBody.press("End");
  await expect
    .poll(() => readingBody.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expectScrollChaining(
    readingBody,
    settingsDialog(page).locator(".buzz-dialog-navigation-detail"),
  );
});

// Column sizing and control containment depend on browser layout/font metrics.
// Service persistence, errors, and draft transitions stay in the component tests.
test("settings share a centered, bounded column and keep controls contained across themes and widths", async ({
  page,
  app,
}, info) => {
  await page.goto(app.origin);
  await openSettings(page);
  // A desktop Settings surface stays bounded instead of filling the workspace.
  await expect
    .poll(() =>
      settingsDialog(page).evaluate((root) => {
        const { width, height } = root.getBoundingClientRect();
        return { width, height };
      }),
    )
    .toEqual({ width: 1152, height: 768 });
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
  await selectSettingsSection(page, "Identity");
  // Copy failure must leave the entire value selectable as ordinary text.
  const identity = page.getByRole("region", {
    name: "Identity",
    exact: true,
  });
  const copyId = identity.getByRole("button", {
    name: "Copy Buzz ID",
    exact: true,
  });
  await expect(copyId).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard unavailable");
        },
      },
    });
  });
  await copyId.click();
  await expect(page.getByText(/Select it and copy manually/)).toBeVisible();
  // The card abbreviates the ID; clipboard failure exposes the full value below it.
  const publicKey = identity.getByText(/^Full Buzz ID:/).locator("code");
  const key = npubEncode(app.viewer);
  await expect(publicKey).toHaveText(key);
  await publicKey.click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe(key);
  await copyId.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    identity.getByRole("button", { name: "More options", exact: true }),
  ).toBeFocused();
  await page.getByRole("dialog", { name: "Identity wasn’t copied" }).hover();
  await page
    .getByRole("dialog", { name: "Identity wasn’t copied" })
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Identity wasn’t copied" }),
  ).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, mode === "light" ? "Light" : "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of [
        "Profile",
        "Local settings",
        "Identity",
        "Appearance",
        "Notifications",
        "Shortcuts",
        "Agent setup",
        "Decisions API",
        "Manage plugins",
        "Software updates",
      ]) {
        await selectSettingsSection(page, name);
        const section = page.getByRole("region", {
          name,
          exact: true,
        });
        if (name === "Profile") {
          await expect(
            section.getByRole("textbox", { name: "Display name", exact: true }),
          ).toBeEnabled();
        }
        if (name === "Notifications") {
          await expect(
            section.getByRole("combobox", { name: "Direct messages" }),
          ).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(
            () =>
              section.evaluate((root) => {
                const bounds = root.getBoundingClientRect();
                const rem = parseFloat(
                  getComputedStyle(document.documentElement).fontSize,
                );
                const failures = [];
                // The Settings modal's detail scrollport owns the page inset.
                const detailStyle = getComputedStyle(
                  root.closest(".buzz-dialog-navigation-detail"),
                );
                const inset = getComputedStyle(
                  root.closest(".buzz-dialog"),
                ).getPropertyValue("--dialog-padding");
                if (
                  !inset.endsWith("rem") ||
                  parseFloat(detailStyle.paddingTop) !== parseFloat(inset) * rem
                )
                  failures.push("settings page lost its top inset");
                if (bounds.width > 48 * rem)
                  failures.push("content exceeds 48rem");
                if (document.documentElement.scrollWidth > window.innerWidth)
                  failures.push("document overflows");
                for (const control of root.querySelectorAll(
                  'button, code, input:not([type="checkbox"]), textarea, [role="combobox"]',
                )) {
                  if (
                    !control.checkVisibility() ||
                    control.getAttribute("aria-hidden") === "true"
                  )
                    continue;
                  const box = control.getBoundingClientRect();
                  if (box.left < bounds.left || box.right > bounds.right)
                    failures.push(
                      `${control.getAttribute("aria-label") || control.textContent}: control overflows`,
                    );
                }
                return failures;
              }),
            { message: `${name}, ${mode}, ${width}px` },
          )
          .toEqual([]);
        if (width === 1440) {
          await expect
            .poll(() =>
              section.evaluate((root) => root.getBoundingClientRect().width),
            )
            .toBe(768);
          await expect
            .poll(() =>
              section.evaluate((root) => {
                const bounds = root.getBoundingClientRect();
                const panel = root
                  .closest(".buzz-dialog-navigation-detail")
                  .getBoundingClientRect();
                return (
                  bounds.left +
                  bounds.width / 2 -
                  (panel.left + panel.width / 2)
                );
              }),
            )
            .toBe(0);
        }
        await page.screenshot({
          path: info.outputPath(`${name.toLowerCase()}-${mode}-${width}.png`),
        });
      }
    }
  }
  await selectSettingsSection(page, "Appearance");
  for (let step = 0; step < 10; step++) {
    await page.getByRole("button", { name: "Increase interface size" }).click();
  }
  await expect(page.getByRole("status", { name: "Interface size" })).toHaveText(
    "200%",
  );
  for (const name of ["Appearance", "Agent setup", "Local settings"]) {
    await selectSettingsSection(page, name);
    const agents = page.getByRole("region", {
      name,
      exact: true,
    });
    await expect
      .poll(
        () =>
          agents.evaluate((root) => {
            const bounds = root.getBoundingClientRect();
            return [...root.querySelectorAll("*")]
              .filter((node) => {
                // Accent colors intentionally scroll horizontally at large text sizes.
                // Check the scrollport here; exercise each clipped swatch below.
                if (node.parentElement?.closest("[data-accent-colors]"))
                  return false;
                if (
                  !node.checkVisibility() ||
                  node.getAttribute("aria-hidden") === "true"
                )
                  return false;
                const box = node.getBoundingClientRect();
                return box.left < bounds.left || box.right > bounds.right;
              })
              .map((node) => ({
                tag: node.tagName,
                text: node.textContent,
                width: node.getBoundingClientRect().width,
                available: bounds.width,
              }));
          }),
        {
          message:
            "Management headings and actions fit at 200% in a narrow panel",
        },
      )
      .toEqual([]);
    if (name === "Appearance") {
      const swatches = agents.getByRole("button", { name: / accent color$/ });
      await expect(swatches.first()).toBeVisible();
      for (const swatch of await swatches.all()) {
        await swatch.focus();
        await expect(swatch).toBeFocused();
        await expect
          .poll(() =>
            swatch.evaluate((node) => {
              const bounds = node
                .closest("[data-accent-colors]")
                .getBoundingClientRect();
              const box = node.getBoundingClientRect();
              return box.left >= bounds.left && box.right <= bounds.right;
            }),
          )
          .toBe(true);
      }
    }
    await page.screenshot({
      path: info.outputPath(`${name.toLowerCase()}-dark-390-200.png`),
    });
  }
});

// Once the section list scrolls, a classic scrollbar takes its width from the
// labels. Only a browser with scrollbars that take space can show that.
test("settings section labels fit beside a classic scrollbar", {
  tag: "@classic-scrollbars",
}, async ({ page, app }) => {
  test.skip(
    process.platform !== "linux" && !process.env.BUZZ_CLASSIC_SCROLLBARS,
    "Set BUZZ_CLASSIC_SCROLLBARS=1 on a Mac whose scrollbars take space",
  );
  // A short window makes the fixture's section list scroll.
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(app.origin);
  await openSettings(page);
  await page.evaluate(() => document.fonts.ready);
  const sections = settingsSections(page);
  await expect
    .poll(
      () =>
        sections.evaluate((nav) => {
          const style = getComputedStyle(nav);
          return (
            nav.offsetWidth -
            nav.clientWidth -
            parseFloat(style.borderLeftWidth) -
            parseFloat(style.borderRightWidth)
          );
        }),
      {
        message: "the section list scrolls beside a scrollbar that takes space",
      },
    )
    .toBeGreaterThan(0);
  const labels = await sections.evaluate((nav) =>
    // The community address row truncates long hosts by design.
    [
      ...nav.querySelectorAll(
        ".navigation-item:not([aria-label]) .navigation-item-label",
      ),
    ].map((label) => {
      const text = document.createRange();
      text.selectNodeContents(label);
      return {
        name: label.textContent,
        overflows:
          text.getBoundingClientRect().width >
          label.getBoundingClientRect().width,
      };
    }),
  );
  expect(labels.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["Channel templates", "Software updates"]),
  );
  expect(
    labels.filter(({ overflows }) => overflows).map(({ name }) => name),
  ).toEqual([]);
});

// Real layout metrics and Base UI focus handoff need a browser; empty/loading
// conditions are covered by component tests.
test.describe("settings empty collections", () => {
  test.use({ productionBroker: true, channelLifecycle: true });
  test("empty cards fit the settings column and their actions lead to the editor", async ({
    page,
    app,
  }, info) => {
    await page.goto(app.origin);
    // This layout journey starts after the initial reader's focus handoff, not
    // while channel startup can still dismiss the profile menu.
    await expect(
      page.getByRole("textbox", { name: /^Message #/ }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    for (const mode of ["light", "dark"]) {
      await selectSettingsSection(page, "Appearance");
      await chooseColorMode(page, mode === "light" ? "Light" : "Dark");
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      for (const width of [1440, 800, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await selectSettingsSection(page, "Custom emoji");
        await page.getByRole("tab", { name: "Community emoji (0)" }).click();
        const community = page.getByRole("group", {
          name: "Community emoji",
          exact: true,
        });
        const search = community.getByRole("searchbox", { name: "Search" });
        await search.fill("unmatched");
        await expect(
          community.getByRole("heading", { name: "No results" }),
        ).toBeVisible();
        await community.getByRole("button", { name: "Clear search" }).click();
        await expect(search).toBeFocused();
        await expect(search).toHaveValue("");
        await page.evaluate(() => document.fonts.ready);
        // Search shares the title/tab content inset rather than the border edge.
        await expect
          .poll(() =>
            community.evaluate((root) => {
              const section = root.closest("section");
              const title = section.querySelector(".buzz-content-header-title");
              const search = root.querySelector(".buzz-input-group");
              if (!title || !search) return false;
              const left = title.getBoundingClientRect().left;
              return Math.abs(search.getBoundingClientRect().left - left) < 1;
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            community.evaluate(
              (root) =>
                root.scrollWidth <= root.clientWidth &&
                document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true);
        await page.screenshot({
          path: info.outputPath(`emoji-community-${mode}-${width}.png`),
        });
        await page.getByRole("tab", { name: "My emojis", exact: true }).click();
        const card = page.locator(".buzz-empty-state").filter({
          has: page.getByRole("heading", {
            name: "No emojis yet",
            exact: true,
          }),
        });
        await expect(card).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(() =>
            card.evaluate((root) => {
              const bounds = root.getBoundingClientRect();
              return (
                [...root.querySelectorAll("*")].every((node) => {
                  const box = node.getBoundingClientRect();
                  return box.left >= bounds.left && box.right <= bounds.right;
                }) &&
                root.scrollWidth <= root.clientWidth &&
                document.documentElement.scrollWidth <= innerWidth
              );
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            settingsDialog(page).evaluate(
              (root) =>
                root
                  .getAnimations({ subtree: true })
                  .filter((animation) => animation.playState === "running")
                  .length,
            ),
          )
          .toBe(0);
        await page.screenshot({
          path: info.outputPath(`Custom emoji-${mode}-${width}.png`),
        });
        const add = card.getByRole("button", {
          name: "Add emoji",
          exact: true,
        });
        await add.hover();
        await add.focus();
        await add.press("Enter");
        await expect(
          page.getByRole("tab", { name: "Add emoji", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        const uploadCard = page.locator(".buzz-empty-state").filter({
          has: page.getByRole("heading", {
            name: "Upload an image",
            exact: true,
          }),
        });
        await expect(uploadCard.locator("button")).toBeFocused();
        await expect
          .poll(() =>
            uploadCard.evaluate((root) => {
              const bounds = root.getBoundingClientRect();
              return [...root.querySelectorAll("*")].every((node) => {
                const box = node.getBoundingClientRect();
                return box.left >= bounds.left && box.right <= bounds.right;
              });
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            settingsDialog(page).evaluate(
              (root) =>
                root
                  .getAnimations({ subtree: true })
                  .filter((animation) => animation.playState === "running")
                  .length,
            ),
          )
          .toBe(0);
        await page.screenshot({
          path: info.outputPath(`emoji-upload-${mode}-${width}.png`),
        });
      }
    }
  });
});

// The Builderlab section applies only in FI builds. With no native host its
// session stays signed out, and hosted communities use the fixture broker.
const fiBuild = test.extend({ federatedIdentity: true });

// Hosted setup states use the real settings page with isolated account replies;
// account operations and failures are covered by the owning component tests.
fiBuild(
  "hosted settings empty and setup cards fit without covering their actions",
  async ({ page, app }, info) => {
    let signedIn = false;
    await page.route("**/api/builderlab/**", async (route) => {
      const action = new URL(route.request().url()).pathname.split("/").pop();
      const replies = {
        auth: {
          auth: signedIn
            ? { email: "test@example.com", expiresAt: "2030" }
            : null,
        },
        identity: { identity: { pubkey_hex: app.viewer } },
        list: { communities: [] },
      };
      if (!(action in replies))
        throw new Error(`Unexpected account action: ${action}`);
      await route.fulfill({ json: replies[action] });
    });
    for (const state of ["setup", "empty"]) {
      signedIn = state === "empty";
      await page.goto(app.origin);
      await page
        .getByRole("button", { name: "Your profile", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      for (const mode of ["light", "dark"]) {
        await selectSettingsSection(page, "Appearance");
        await chooseColorMode(page, mode === "light" ? "Light" : "Dark");
        for (const width of [1440, 800, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await selectSettingsSection(page, "Builderlab");
          await expect(
            page.getByRole("region", { name: "Builderlab", exact: true }),
          ).toBeVisible();
          const back = page.getByRole("button", { name: "Back to Builderlab" });
          if (await back.isVisible()) await back.click();
          const open = page.getByRole("button", { name: "Open Communities" });
          await open.click();
          const card = signedIn
            ? page.getByRole("region", { name: "Communities", exact: true })
            : page.locator(".buzz-empty-state").filter({
                has: page.getByRole("heading", {
                  name: "Sign in to manage hosted communities",
                }),
              });
          if (signedIn) {
            const create = card.getByRole("button", {
              name: "Create community",
              exact: true,
            });
            await expect(create).toBeEnabled();
          }
          await expect(card).toBeVisible();
          for (const scale of ["100%", "200%"]) {
            await page.evaluate((value) => {
              document.documentElement.style.fontSize = value;
            }, scale);
            await expect
              .poll(
                () =>
                  card.evaluate((root) => {
                    const box = root.getBoundingClientRect();
                    return (
                      [...root.querySelectorAll("*")].every((node) => {
                        if (!node.getClientRects().length) return true;
                        const child = node.getBoundingClientRect();
                        return (
                          child.left >= box.left && child.right <= box.right
                        );
                      }) && root.scrollWidth <= root.clientWidth
                    );
                  }),
                { message: `${state}, ${mode}, ${width}px, ${scale}` },
              )
              .toBe(true);
            if (!signedIn) {
              const action = card.getByRole("button", {
                name: "Sign in with Builderlab",
              });
              await action.scrollIntoViewIfNeeded();
              await expect(action).toBeInViewport({ ratio: 1 });
            }
            if (width === 390 && scale === "200%")
              await page.screenshot({
                path: info.outputPath(`hosted-${state}-${mode}-200.png`),
              });
          }
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "";
          });
        }
      }
    }
  },
);
