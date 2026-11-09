import { test, expect } from "./source-fixture.mjs";

// SVG/text line placement requires a layout engine; jsdom cannot observe it.
for (const fullName of [true, false]) {
  test(`profile verification checkmark follows the verified ${fullName ? "full name" : "username"}`, async ({
    page,
  }, info) => {
    await page.goto(
      `/tests/fixtures/profiles.html?verified-name${fullName ? "" : "&no-full-name"}`,
    );
    await page
      .getByRole("button", { name: "View Viewer profile", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "Profile details" });
    const name = panel.getByText(fullName ? "Viewer Example" : "@viewer", {
      exact: true,
    });
    const label = name.locator("..");
    const issuer = panel.getByText(
      fullName
        ? "Name verified by Example · @viewer"
        : "Name verified by Example",
      { exact: true },
    );
    await expect(name).toBeVisible();
    await expect(label.locator("svg")).toHaveCount(1);
    await expect(issuer.locator("svg")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [480, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        for (const fontSize of ["16px", "24px"]) {
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = size;
          }, fontSize);
          await expect
            .poll(() =>
              label.evaluate((element) => {
                const icon = element
                  .querySelector("svg")
                  .getBoundingClientRect();
                const text = element
                  .querySelector("span")
                  .getBoundingClientRect();
                return (
                  icon.left >= text.right &&
                  icon.top < text.bottom &&
                  icon.bottom > text.top
                );
              }),
            )
            .toBe(true);
        }
      }
      await panel.screenshot({ path: info.outputPath(`${theme}.png`) });
    }
  });
}
