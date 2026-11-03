import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { generateSecretKey, nip19 } from "nostr-tools";
import { watchPageErrors } from "../../tests/browser/page-errors.mjs";

// Visits every surface the web build reaches and fails on a refused native
// command, an "isn't available in the browser" or load-failure text, a console
// error, a page error or a failed same-origin request.
//
// By default a fresh key joins the empty staging relay and creates what it
// visits. Against a realistic community (a restored clone), set CRAWL_NSEC to
// a member's key and CRAWL_HOST to its host; CRAWL_LIVE=1 makes the run
// read-only (no writes, no traces) for a production community, and
// CRAWL_BUILD=dist/web serves the app from that local build at its origin, so
// a build meets the community's real data before it is deployed.
const port = process.env.STAGING_PORT ?? "9443";
const host = process.env.CRAWL_HOST ?? `buzz.localhost:${port}`;
const live = process.env.CRAWL_LIVE === "1";
const sampled = Number(process.env.CRAWL_CHANNELS ?? 10);

// Commands reachable surfaces call that degrade cleanly by design.
const degraded = new Set([
  // Block account sign-in is desktop-only; the service reports it unavailable.
  "plugin:event|listen",
  // Repository reads run a local git; the repository page shows unavailable.
  "relay_project_git",
]);
const FAILURE =
  /isn['’]t available in the browser|could not be loaded|Retry (templates|workspaces)/;

test.use({
  baseURL: `https://${host}`,
  actionTimeout: 10_000,
  ...(live ? { trace: "off", screenshot: "off", video: "off" } : {}),
});

/** Records every rejected native command by name. */
function watchCommands(page: Page) {
  return page.addInitScript(() => {
    const refused: string[] = [];
    let inner: (...args: unknown[]) => Promise<unknown>;
    const internals = Reflect.get(window, "__TAURI_INTERNALS__") ?? {};
    Reflect.set(window, "__TAURI_INTERNALS__", internals);
    Reflect.set(window, "__refused", refused);
    Object.defineProperty(internals, "invoke", {
      configurable: true,
      get: () => async (command: string, args: unknown, options: unknown) => {
        try {
          return await inner(command, args, options);
        } catch (error) {
          if (String(error).includes("isn't available in the browser"))
            refused.push(command);
          else console.info(`[crawl] ${command} rejected: ${String(error)}`);
          throw error;
        }
      },
      set: (value) => {
        inner = value;
      },
    });
  });
}

for (const width of [1280, 390])
  test(`every surface works at ${width}px`, async ({ page }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width, height: 844 });
    await watchCommands(page);
    const build = process.env.CRAWL_BUILD;
    if (build)
      await page.context().route(`https://${host}/**`, (route) => {
        const request = route.request();
        const file = join(build, new URL(request.url()).pathname);
        if (
          request.method() !== "GET" ||
          request.headers().accept?.includes("application/nostr+json")
        )
          return route.fallback();
        if (request.isNavigationRequest())
          return route.fulfill({ path: join(build, "index.html") });
        return existsSync(file) && statSync(file).isFile()
          ? route.fulfill({ path: file })
          : route.fallback();
      });
    const errors = watchPageErrors(page);
    const issues: string[] = [];
    const issue = (text: string) => {
      issues.push(text);
      console.log(`[crawl] ${text}`);
    };
    let step = "start";
    page.on("console", (message) => {
      if (message.text().startsWith("[crawl]")) console.log(message.text());
      // Relay media in a clone without its object store, the relay pacing
      // reads (429, which the app retries) and staging's local CA, which
      // Chromium refuses for service workers.
      const { url } = message.location();
      if (
        message.type() === "error" &&
        !/^An SSL certificate error occurred when fetching the script/.test(
          message.text(),
        ) &&
        !(
          /^Failed to load resource/.test(message.text()) &&
          (/\/media(\?|\/)/.test(url) || /status of 429/.test(message.text()))
        )
      )
        issue(`${step}: console: ${message.text().slice(0, 300)} ${url}`);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      // 429 is the relay pacing reads, which the app retries.
      if (
        response.status() >= 400 &&
        response.status() !== 429 &&
        url.host === host &&
        !/\/media(\/|$)/.test(url.pathname)
      )
        issue(`${step}: HTTP ${response.status()} ${url.pathname}`);
    });
    // Settled: no request in flight for a moment.
    let inflight = 0;
    let changed = Date.now();
    page.on("request", () => {
      inflight++;
      changed = Date.now();
    });
    const done = () => {
      inflight--;
      changed = Date.now();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    const settle = () =>
      expect
        .poll(() => inflight <= 0 && Date.now() - changed > 1000, {
          timeout: 10_000,
        })
        .toBe(true)
        .catch(() => {});
    const visited: string[] = [];
    /** Runs one surface, then records what it showed and closes it. */
    async function visit(name: string, open: () => Promise<unknown>) {
      step = name;
      const started = Date.now();
      try {
        await dismiss();
        await drawer(false);
        await open();
        visited.push(name);
      } catch (error) {
        const lines = String(error).split("\n");
        console.log(
          `[crawl] skipped ${name}: ${lines[0]} ${lines.find((line) => line.includes("intercepts")) ?? ""}`,
        );
      }
      await settle();
      for (const text of await page.getByText(FAILURE).allInnerTexts())
        issue(`${name}: shows "${text.slice(0, 200)}"`);
      await dismiss();
      if (Date.now() - started > 30_000)
        console.log(`[crawl] slow ${name}: ${Date.now() - started} ms`);
    }
    /** Closes whatever menus and dialogs the last surface left open. */
    async function dismiss() {
      const open = page.getByRole("menu").or(page.getByRole("dialog"));
      for (let tries = 0; tries < 4 && (await open.count()); tries++)
        await page.keyboard.press("Escape");
    }
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    /** On a phone the sidebar is a drawer: open it, or close it by its scrim. */
    async function drawer(open = true) {
      if (width > 650) return;
      const shown = await page
        .locator('#shell-navigation[data-expanded="true"]')
        .isVisible();
      if (open && !shown)
        await page.locator("[data-shell-sidebar-toggle]").click();
      if (!open && shown) await page.mouse.click(width - 16, 422);
    }
    /** Every tab in `scope`, in turn. */
    async function tabs(scope: Locator) {
      for (const tab of await scope.getByRole("tab").all())
        if (await tab.isVisible()) {
          await tab.click();
          await settle();
        }
    }
    /** Opens `menu`, then each item of `items` from a fresh menu. */
    async function menuItems(
      name: string,
      open: () => Promise<unknown>,
      items: string[],
    ) {
      for (const item of items)
        await visit(`${name} › ${item}`, async () => {
          await open();
          await page.getByRole("menuitem", { name: item, exact: true }).click();
          await settle();
          await tabs(page.getByRole("dialog"));
        });
    }

    // Sign in through the key import path, as people do.
    await page.goto("/");
    await expect(async () => {
      await page.getByLabel("Community URL").fill(host);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("button", { name: "I already have a key" }),
      ).toBeVisible({ timeout: 2000 });
    }).toPass();
    await page.getByRole("button", { name: "I already have a key" }).click();
    await page
      .getByLabel("Private key or backup")
      .fill(process.env.CRAWL_NSEC ?? nip19.nsecEncode(generateSecretKey()));
    await page.getByRole("button", { name: "Continue with this key" }).click();
    await page.getByRole("button", { name: "Join", exact: true }).click();
    const profile = page.getByLabel("Display name");
    const me = page.getByRole("button", { name: "Your profile" });
    await expect(profile.or(me)).toBeVisible({ timeout: 30_000 });
    if (await profile.isVisible()) {
      // Never publish a profile over a production identity's.
      expect(live).toBe(false);
      await profile.fill("Crawler");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    }
    await expect(me).toBeVisible({ timeout: 30_000 });
    await settle();

    if (!live) {
      // What the empty staging lacks: a channel with a message, a workspace
      // (a channel recipe) and a reminder on that message.
      await drawer();
      await page.getByRole("button", { name: "Create channel" }).click();
      await page.getByLabel("Name").fill(`crawl-${Date.now().toString(36)}`);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Create channel" })
        .click();
      const composer = page.getByRole("textbox", { name: /^Message/ });
      await composer.click();
      await page.keyboard.type("Crawl message");
      await page.keyboard.press("Enter");
      await expect(page.getByText("Crawl message")).toBeVisible();
      await page.getByText("Crawl message").hover();
      await page
        .getByRole("button", { name: "More message actions" })
        .last()
        .click();
      await page.getByRole("menuitem", { name: "Remind me" }).click();
      await page.getByRole("combobox", { name: "When" }).click();
      await page.getByRole("option").first().click();
      await page.getByRole("button", { name: "Set reminder" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await drawer();
      await page.getByRole("button", { name: "New", exact: true }).click();
      await page.getByRole("menuitem", { name: "New workspace" }).click();
      await page
        .getByRole("dialog")
        .getByLabel("Name")
        .fill(`Crawl ${Date.now().toString(36)}`);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 30_000 });
      // Read both back from the relay.
      await page.reload();
      await expect(me).toBeVisible({ timeout: 30_000 });
      await settle();
    }

    for (const name of ["Reminders", "Agents", "Workflows", "Messages"])
      await visit(`page ${name}`, async () => {
        const tab = page.getByRole("tab", { name, exact: true });
        // A phone lists the pages behind More pages.
        if (!(await tab.isVisible()))
          await page.getByRole("button", { name: "More pages" }).click();
        await tab
          .or(page.getByRole("dialog").getByText(name, { exact: true }))
          .first()
          .click();
        await settle();
        await tabs(page.getByRole("tabpanel", { name }));
        if (name === "Workflows") {
          await page
            .getByRole("button", { name: "Show all channel workflows" })
            .click({ timeout: 3000 })
            .catch(() => {});
          await settle();
          const first = page
            .getByRole("region", { name: "Workflows" })
            .getByRole("link")
            .first();
          if (await first.isVisible()) await first.click();
        }
      });
    await visit("inbox", async () => {
      await drawer();
      await sidebar.getByRole("button", { name: "Inbox" }).first().click();
    });
    await visit("search", async () => {
      await page.getByRole("button", { name: "Search Buzz" }).click();
      await page.keyboard.type("a");
      await settle();
      await page.keyboard.press("Enter");
    });
    for (const scope of ["Solo", "Team", "All"])
      await visit(`sidebar scope ${scope}`, async () => {
        await drawer();
        await sidebar.getByRole("tab", { name: scope, exact: true }).click();
      });
    await menuItems(
      "new",
      async () => {
        await drawer();
        await sidebar.getByRole("button", { name: "New", exact: true }).click();
      },
      // New chat and New section create at once; the rest open a dialog.
      live
        ? ["New workspace", "New DM", "New channel"]
        : ["New chat", "New workspace", "New DM", "New channel", "New section"],
    );
    for (const group of ["Channels", "Direct messages"])
      await menuItems(
        `${group} actions`,
        async () => {
          await drawer();
          await sidebar
            .getByRole("button", { name: `More actions for ${group}` })
            .click();
        },
        live ? [] : ["Filter"],
      );

    // A sample of conversations across the sidebar: Solo chats, channels,
    // forums and DMs.
    await drawer();
    const ids = [
      ...new Set(
        await sidebar
          .locator("[data-channel-id]")
          .evaluateAll((items) =>
            items.map((item) => item.getAttribute("data-channel-id") ?? ""),
          ),
      ),
    ].filter(Boolean);
    const every = Math.max(1, Math.ceil(ids.length / sampled));
    for (const id of ids.filter((_, index) => index % every === 0)) {
      const open = async () => {
        await drawer();
        await sidebar
          .locator(`[data-channel-id="${id}"]:visible`)
          .first()
          .click();
        await settle();
      };
      await visit(`channel ${id}`, open);
      await visit(`channel ${id} details`, async () => {
        await page.getByRole("button", { name: "Channel actions" }).click();
        await page
          .getByRole("menuitem", { name: /details/i })
          .first()
          .click();
        await settle();
        await tabs(page.getByRole("dialog"));
      });
      await visit(`channel ${id} members`, async () => {
        await page.getByRole("button", { name: "Manage members" }).click();
        await settle();
        await tabs(page.getByRole("dialog"));
      });
      const actions = page.getByRole("group", { name: "Message actions" });
      const message = page
        .getByRole("region", { name: "Channel message history" })
        .getByRole("listitem")
        .filter({ has: actions })
        .last();
      // Actions render while the pointer is over the message's text.
      const action = async (name: string) => {
        await message.getByRole("paragraph").first().hover();
        await message
          .getByRole("group", { name: "Message actions" })
          .getByRole("button", { name, exact: true })
          .click();
      };
      await visit(`channel ${id} thread`, async () => {
        await action("Reply");
      });
      await visit(`channel ${id} message menu`, async () => {
        await open();
        await action("More message actions");
        await settle();
      });
      await visit(`channel ${id} reactions`, async () => {
        await action("Add reaction");
      });
      for (const control of ["Emoji and GIFS", "Mention a member"])
        await visit(`channel ${id} ${control}`, () =>
          page.getByRole("button", { name: control }).last().click(),
        );
      // Typing shows others a typing indicator.
      if (!live)
        await visit(`channel ${id} commands`, async () => {
          const composer = page.getByRole("textbox", { name: /^Message/ });
          await composer.click();
          await page.keyboard.type("/");
          await settle();
          await page.keyboard.type(" @");
          await settle();
          await page.keyboard.press("Escape");
          await composer.clear();
        });
      // Last: the canvas replaces the conversation in this channel's tabs.
      await visit(`channel ${id} canvas`, async () => {
        await page.getByRole("button", { name: "Channel actions" }).click();
        await page.getByRole("menuitem", { name: "View canvas" }).click();
      });
    }

    // The profile menu, its dialogs and every Settings section.
    await menuItems("profile", () => me.click(), [
      "Set a status",
      "Appearance",
      "Plugins",
      "Send feedback",
    ]);
    await visit("profile edit", async () => {
      await me.click();
      await page.getByRole("menuitem", { name: /edit profile$/ }).click();
    });
    await me.click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const sections = page.getByRole("navigation", {
      name: "Settings sections",
    });
    const entries = sections.getByRole("button").or(sections.getByRole("link"));
    for (const text of await entries.allInnerTexts()) {
      const name = text.split("\n")[0] ?? text;
      await visit(`settings ${name}`, async () => {
        if (!(await sections.isVisible())) {
          await me.click();
          await page
            .getByRole("menuitem", { name: "Settings", exact: true })
            .click();
        }
        await entries.filter({ hasText: name }).first().click();
        await settle();
        await tabs(page.getByRole("main"));
      });
    }
    await visit("community switcher", () =>
      page.getByRole("button", { name: /^Community switcher/ }).click(),
    );

    console.log(`[crawl] ${width}px visited ${visited.length} surfaces`);
    const refused = await page.evaluate(
      () => Reflect.get(window, "__refused") as string[],
    );
    expect
      .soft(refused.filter((command) => !degraded.has(command)))
      .toEqual([]);
    expect.soft(issues).toEqual([]);
    expect.soft(errors.unexplained()).toEqual([]);
    expect(visited.length).toBeGreaterThan(30);
  });
