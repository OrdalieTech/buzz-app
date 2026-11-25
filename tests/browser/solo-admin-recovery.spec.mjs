import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const channel = "11111111-1111-4111-8111-111111111111";
const chat = "33333333-3333-4333-8333-333333333333";
test.use({
  video: "on",
  diagnostics: false,
  productionBroker: true,
  openingAdminSetup: true,
  channelLifecycle: true,
  channelIds: [channel, chat],
  channelNames: { [channel]: "Project updates", [chat]: "Recovery chat" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  soloAgentNames: ["Recovery agent"],
  soloOutsideAgentNames: ["Shared helper"],
  savedCommunities: ["primary"],
  historyCounts: { [channel]: 0, [chat]: 0 },
});

// Production users have no Diagnostics, so the blocked chat offers abandonment
// inline, including while a Retry waits on a held admin signature, at a
// narrow width with enlarged text.
test("a blocked setup is abandoned from its chat without Diagnostics", async ({
  page,
  app,
}, info) => {
  const createdAt = Math.floor(Date.now() / 1000);
  const agent = app.soloAgents[0].pubkey;
  const creation = app.sign({
    kind: 9007,
    created_at: createdAt,
    content: "",
    tags: [
      ["h", chat],
      ["p", agent],
    ],
  });
  const message = app.sign({
    kind: 9,
    created_at: createdAt,
    content: "Opening work",
    tags: [
      ["h", chat],
      ["p", agent],
    ],
  });
  app.report.setupCreation = creation;
  app.report.setupReceiverTime = createdAt;
  await page.addInitScript(
    ({ scope, creation, message, agent }) => {
      localStorage.setItem("buzz-font-scale.v1", "1.5");
      localStorage.setItem(
        `buzz-outbox-v1:${scope}`,
        JSON.stringify([
          {
            event: creation,
            signed: creation,
            delivery: "accepted",
            recovery: {
              key: `solo-initial-admins:${creation.tags[0][1]}`,
              value: JSON.stringify([agent]),
            },
          },
          { event: message, signed: message, delivery: "failed" },
        ]),
      );
    },
    {
      scope: `https://primary.example:${app.viewer}`,
      creation,
      message,
      agent,
    },
  );
  let release = () => {};
  let signingStarted = false;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/member-administration-sign", async (route) => {
    const response = await route.fetch();
    signingStarted = true;
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    // Launch selects its first conversation; choose the chat only after that.
    const sidebar = page.locator('aside[aria-label="Sidebar"]');
    await expect(sidebar).not.toHaveAttribute("data-buzz-launch-pending");
    await expect(sidebar).not.toHaveAttribute("aria-busy", "true");
    await page
      .getByRole("button", { name: "Recovery chat", exact: true })
      .click();
    const notice = page.getByRole("status", {
      name: "Chat admin setup didn’t finish",
      exact: true,
    });
    await expect(notice).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(notice).toBeVisible();
    await page
      .getByRole("button", { name: "Retry", exact: true })
      .first()
      .click();
    await expect.poll(() => signingStarted).toBe(true);
    const abandon = notice.getByRole("button", {
      name: "Abandon admin setup",
      exact: true,
    });
    await abandon.click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Abandon admin setup?",
    });
    await confirmation.screenshot({
      path: info.outputPath("ABANDON_FROM_CHAT.png"),
    });
    await confirmation
      .getByRole("button", { name: "Abandon admin setup", exact: true })
      .click();
    await expect(notice).toHaveCount(0);
    release();
    await expect(
      page.getByRole("button", { name: "Retry", exact: true }).first(),
    ).toBeVisible();
    expect(
      app.report.publications.filter(({ event }) =>
        [9000, 9].includes(event.kind),
      ),
    ).toEqual([]);
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    await composer.fill("Continue with current roles");
    await composer.press("Enter");
    await expect
      .poll(
        () =>
          app.report.publications.filter(({ event }) => event.kind === 9)
            .length,
      )
      .toBe(1);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9000),
    ).toEqual([]);
    expect(
      app.report.publications.find(({ event }) => event.kind === 9).event
        .content,
    ).toBe("Continue with current roles");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
