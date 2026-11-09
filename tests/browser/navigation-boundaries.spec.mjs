import { openPage, pageChoices, pageChoice } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
test.use({
  enabledPlugins: ["buzz.workflows"],
  pluginFixtures: true,
  historyCounts: { alpha: 1, beta: 0 },
});

async function expectPageChoice(page, name, count) {
  const choices = await pageChoices(page, "Settings");
  await expect(pageChoice(choices, "Settings")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Search Buzz", exact: true })
    .fill(name);
  await expect(pageChoice(choices, name)).toHaveCount(count);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
}

// Regressions from the independent review, exercised through production composition.
test("cold destination waits for its enabled provider to activate", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.delayFixture = { started: false };
  });
  const target = {
    version: 1,
    kind: "page",
    pluginId: "fixture.delayed",
    pageId: "slow",
  };
  try {
    await page.goto(
      `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
    );
    await expect
      .poll(() => page.evaluate(() => window.delayFixture.started))
      .toBe(true);
    await expect(page.getByRole("main").getByRole("status")).toHaveText(
      "Loading…",
    );
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation?.snapshot().status),
      )
      .toBe("opening");
    const destination = page.getByText("Delayed destination presented", {
      exact: true,
    });
    await expectPageChoice(page, "Delayed fixture", 0);
    await expect(destination).toHaveCount(0);
    await page.evaluate(() => window.delayFixture.release());
    await expect(destination).toBeVisible();
    await expectPageChoice(page, "Delayed fixture", 1);
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
  } finally {
    await page.evaluate(() => window.delayFixture?.release?.());
  }
});

test("cold Settings provider waits for its plugin activation", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.delayFixture = { started: false };
  });
  const target = {
    version: 1,
    kind: "settings",
    section: "agents",
    provider: "fixture.delayed/provider",
  };
  try {
    await page.goto(
      `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
    );
    await expect
      .poll(() => page.evaluate(() => window.delayFixture.started))
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation?.snapshot().status),
      )
      .toBe("opening");
    await page.evaluate(() => window.delayFixture.release());
    await expect(
      page.getByRole("dialog", { name: "Delayed provider", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
  } finally {
    await page.evaluate(() => window.delayFixture?.release?.());
  }
});

// Native Forward must retain the actual editor node while its destination fails;
// owner tests cover pending activation and Save/Discard decision ordering.
test("native Settings traversal retains a dirty Profile behind an unavailable provider", async ({
  page,
  app,
}) => {
  await open(page, app);
  const profile = { version: 1, kind: "settings", section: "profile" };
  expect(
    await page.evaluate(
      (target) => window.fixtureNavigation.open(target),
      profile,
    ),
  ).toEqual({ status: "opened" });
  expect(
    await page.evaluate((target) => window.fixtureNavigation.open(target), {
      ...profile,
      section: "agents",
      provider: "missing/provider",
    }),
  ).toEqual({ status: "failed", reason: "unavailable" });
  await page.goBack();
  const name = page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("textbox", { name: "Display name", exact: true });
  await expect(name).toBeEnabled();
  await name.fill("Keep this Profile draft");
  await name.evaluate((element) => {
    window.retainedDraftEditor = element;
  });
  await page.goForward();
  await expect(
    page.getByText("This page isn’t available", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.retainedDraftEditor.isConnected),
  ).toBe(true);
  await page.goBack();
  await expect(name).toHaveValue("Keep this Profile draft");
  expect(
    await name.evaluate((element) => element === window.retainedDraftEditor),
  ).toBe(true);
});

test("Messages default resolution returns opened to cold and warm callers without an extra visit", async ({
  page,
  app,
}) => {
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "page",
        pluginId: "buzz.repos",
        pageId: "repos",
      }),
    )}`,
  );
  await expect(
    page.getByRole("heading", {
      name: "Destination no longer available",
      exact: true,
    }),
  ).toBeVisible();
  await expectPageChoice(page, "Messages", 1);
  for (const mode of ["cold", "warm"]) {
    const result = await page.evaluate(async () => {
      const nav = window.fixtureNavigation;
      const pending = nav.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
      });
      const visit = nav.snapshot().entry.id;
      return { result: await pending, visit, resolved: nav.snapshot().entry };
    });
    expect(result.result, mode).toEqual({ status: "opened" });
    expect(result.resolved.id, mode).toBe(result.visit);
    expect(result.resolved.target.channelId, mode).toBe("alpha");
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "Destination no longer available",
        exact: true,
      }),
    ).toBeVisible();
  }
});

test("native Alt arrows preserve composer editing; deliberate history shortcuts navigate", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Workflows");
  await expect(
    page.getByRole("heading", {
      name: "Workflows",
      exact: true,
    }),
  ).toBeVisible();
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("one two three");
  const visit = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry.id,
  );
  for (const arrow of ["ArrowLeft", "ArrowRight"]) {
    await page.keyboard.press(`Alt+${arrow}`);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty("value", "one two three");
    expect(
      await page.evaluate(() => window.fixtureNavigation.snapshot().entry.id),
    ).toBe(visit);
  }
  const apple = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  );
  await page.keyboard.press(`${apple ? "Meta" : "Control"}+[`);
  await expect(composer).toHaveCount(0);
  await page.keyboard.press(`${apple ? "Meta" : "Control"}+]`);
  await expect(composer).toHaveJSProperty("value", "one two three");
});
