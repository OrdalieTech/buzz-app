import {
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({
  enabledPlugins: ["buzz.reminders"],
  historyCounts: { alpha: 0, beta: 0 },
});

async function settings(page) {
  await openSettings(page);
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
}

// Real font metrics, wrapping and parent layout need a browser, not jsdom.
test("Notifications keeps settings separated and button labels contained at supported interface sizes", async ({
  page,
  app,
}, info) => {
  await page.addInitScript(() => {
    window.Notification = class {
      static permission = "default";
      static async requestPermission() {
        return "default";
      }
      close() {}
    };
  });
  await page.goto(app.origin);
  await settings(page);
  const section = page.locator(
    'section[aria-labelledby="notification-settings-title"]',
  );
  for (const scale of [100, 200]) {
    await selectSettingsSection(page, "Appearance");
    if (scale === 200) {
      for (let i = 0; i < 10; i++) {
        await page
          .getByRole("button", { name: "Increase interface size" })
          .click();
      }
    }
    await expect(
      page.getByRole("status", { name: "Interface size" }),
    ).toHaveText(`${scale}%`);
    await selectSettingsSection(page, "Notifications");
    await expect(
      section.getByRole("button", { name: "Allow notifications" }),
    ).toBeVisible();
    await expect(section.getByRole("switch")).toHaveCount(8);
    // The per-event sound controls must be present for the geometry sweep.
    for (const name of [
      "Direct messages",
      "@Mentions",
      "Thread replies",
      "Solo chat completions",
    ]) {
      await expect(section.getByRole("combobox", { name })).toBeVisible();
    }
    await expect(
      section.getByRole("button", { name: /^Preview / }),
    ).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      // Retrying the geometry assertions observes applied layout after resizing.
      const geometryIssues = () =>
        section.evaluate((root) => {
          const failures = [];
          const bounds = root.getBoundingClientRect();
          const controls = [...root.querySelectorAll('[role="switch"]')];
          let previous;
          for (const control of controls) {
            const row = control
              .closest(".buzz-preference-row")
              .getBoundingClientRect();
            const name = control.getAttribute("aria-label");
            // Adjacent full-width rows share an edge; only intersecting bounds overlap.
            if (previous && row.top < previous.bottom)
              failures.push(`${name}: settings share or overlap a row`);
            if (row.left < bounds.left || row.right > bounds.right)
              failures.push(`${name}: row overflows section`);
            const track = control.getBoundingClientRect();
            const label = document.createRange();
            label.selectNodeContents(
              control.closest(".buzz-preference-row").querySelector("label"),
            );
            for (const line of label.getClientRects()) {
              if (line.right > track.left || track.right > bounds.right)
                failures.push(`${name}: label or switch overflows its row`);
            }
            previous = row;
          }
          for (const button of root.querySelectorAll(
            'button:not([role="switch"])',
          )) {
            const box = button.getBoundingClientRect();
            const text = document.createRange();
            text.selectNodeContents(button);
            for (const line of text.getClientRects()) {
              if (
                line.top < box.top ||
                line.bottom > box.bottom ||
                line.left < box.left ||
                line.right > box.right
              ) {
                failures.push(`${button.textContent}: text overflows button`);
              }
            }
            if (box.left < bounds.left || box.right > bounds.right)
              failures.push(`${button.textContent}: button overflows section`);
          }
          return failures;
        });
      await expect
        .poll(geometryIssues, {
          message: `Notifications layout at ${scale}% interface and ${width}px width`,
        })
        .toEqual([]);
      await page.screenshot({
        path: info.outputPath(`notifications-${scale}-${width}.png`),
      });
    }
  }
});
