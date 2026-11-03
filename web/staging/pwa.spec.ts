import { type Browser, expect, type Page, test } from "@playwright/test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

// End-to-end journey of the web build against the local staging relay. Test
// keys only; staging data outlives a run, so names carry a run suffix.
const community = "https://buzz.localhost:9443";
const run = Date.now().toString(36);

async function open(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  return page;
}
const invoke = (page: Page, command: string, args?: object) =>
  page.evaluate(
    ([command, args]) =>
      Reflect.get(window, "__TAURI_INTERNALS__").invoke(command, args),
    [command, args] as const,
  );
const shell = (page: Page) =>
  expect(page.getByRole("button", { name: "Create channel" })).toBeVisible();
async function profile(page: Page, name: string) {
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await shell(page);
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: /^Message/ }).click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(page.getByText(text)).toBeVisible();
}

test("chats through the browser host", async ({ browser }) => {
  // Alice brings a key through first run's "I already have a key".
  const alice = await open(browser);
  const aliceName = `Alice ${run}`;
  await expect(async () => {
    await alice.getByLabel("Community URL").fill("buzz.localhost:9443");
    await alice.getByRole("button", { name: "Continue" }).click();
    await expect(
      alice.getByRole("button", { name: "I already have a key" }),
    ).toBeVisible({ timeout: 2000 });
  }).toPass();
  await alice.getByRole("button", { name: "I already have a key" }).click();
  await alice
    .getByLabel("Private key (nsec)")
    .fill(nip19.nsecEncode(generateSecretKey()));
  await alice.getByRole("button", { name: "Continue with this key" }).click();
  await alice.getByRole("button", { name: "Join", exact: true }).click();
  await profile(alice, aliceName);

  // Bob's key is created by the key Worker; joining a community outside the
  // build's allowlist is refused, the staging one is not.
  const bob = await open(browser);
  const bobName = `Bob ${run}`;
  const viewer = await invoke(bob, "identity_create");
  expect(viewer).toMatch(/^[0-9a-f]{64}$/);
  await bob.reload();
  const dialog = bob.getByRole("dialog");
  const join = async (url: string) => {
    const field = bob.getByLabel("Invite link or community URL");
    await expect(async () => {
      await field.fill(url);
      await field.press("Enter");
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass();
    await dialog.getByRole("button", { name: "Continue" }).click();
  };
  await join("wss://other.example.com");
  await expect(
    bob.getByText("This community isn't available in this app."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Back" }).click();
  await join("wss://buzz.localhost:9443");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByLabel("Display name").fill(bobName);
  await dialog.getByRole("button", { name: "Publish profile & open" }).click();
  await shell(bob);

  // A channel and a message.
  await alice.getByRole("button", { name: "Create channel" }).click();
  await alice.getByLabel("Name").fill(`general-${run}`);
  await alice
    .getByRole("dialog")
    .getByRole("button", { name: "Create channel" })
    .click();
  await send(alice, `hello from the web ${run}`);

  // A direct message, delivered live to Bob.
  await alice.getByRole("button", { name: "New message" }).click();
  await alice
    .getByRole("combobox", { name: "Message recipients" })
    .fill(bobName);
  await alice.getByRole("option", { name: bobName }).click();
  await send(alice, `hi Bob ${run}`);
  const row = bob
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("button", { name: aliceName });
  await expect(row).toBeVisible();

  // Read state: unread survives a reload until read; once read, the relay
  // holds Bob's self-encrypted record and a reload keeps it read.
  await bob.getByRole("button", { name: "Inbox" }).click();
  await send(alice, `are you there ${run}`);
  const unread = row.locator("[data-channel-unread]");
  await expect(unread).toBeVisible();
  await bob.reload();
  await expect(unread).toBeVisible();
  await row.click();
  await expect(bob.getByText(`are you there ${run}`)).toBeVisible();
  await expect(unread).toBeHidden();
  const channel = await row.getAttribute("data-channel-id");
  // Publication is debounced (5 s) after a local journal write.
  await expect
    .poll(
      async () => {
        const { body } = (await invoke(bob, "relay_http", {
          community,
          path: "/query",
          method: "POST",
          body: JSON.stringify([
            { kinds: [30078], authors: [viewer], "#t": ["read-state"] },
          ]),
        })) as { body: string };
        const events = JSON.parse(body);
        return JSON.stringify(
          await invoke(bob, "relay_decode_read_state", { community, events }),
        );
      },
      { timeout: 20_000 },
    )
    .toContain(channel);
  await bob.reload();
  await expect(bob.getByText(`are you there ${run}`)).toBeVisible();
  await expect(unread).toBeHidden();

  // Alice stays signed in across a reload.
  await alice.reload();
  await shell(alice);
  await expect(alice.getByText(`are you there ${run}`)).toBeVisible();
});

test("continues with the previous PWA's identity and communities", async ({
  browser,
}) => {
  const secret = generateSecretKey();
  const page = await open(browser);
  // Our old PWA's vault (desktop/src/web/core.ts saveIdentity) and community list.
  const seeded = await page.evaluate(
    async ({ secret, pubkey }) => {
      const wrappingKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        wrappingKey,
        new Uint8Array(secret),
      );
      const request = indexedDB.open("buzz-desktop-web-vault", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("identity", { keyPath: "id" });
      const database = await new Promise<IDBDatabase>((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      const transaction = database.transaction("identity", "readwrite");
      transaction
        .objectStore("identity")
        .put({ id: "current", ciphertext, iv, pubkey, wrappingKey });
      await new Promise((resolve) => {
        transaction.oncomplete = resolve;
      });
      database.close();
      localStorage.setItem(
        "buzz-communities",
        JSON.stringify([
          { id: "a", name: "Staging", relayUrl: "wss://buzz.localhost:9443" },
          { id: "b", name: "Other", relayUrl: "wss://other.example.com" },
        ]),
      );
      return ciphertext.byteLength;
    },
    { secret: [...secret], pubkey: getPublicKey(secret) },
  );
  await page.reload();
  const offer = page.getByRole("alertdialog", {
    name: "Continue with your Buzz identity?",
  });
  await offer.getByRole("button", { name: "Continue" }).click();
  const communities = page.getByRole("alertdialog", {
    name: "Import communities from old Buzz?",
  });
  await expect(communities.getByRole("listitem")).toHaveText([community]);
  await communities.getByRole("button", { name: "Import communities" }).click();
  // Imported communities are saved, not opened: pick it.
  await page.getByRole("button", { name: /^Community switcher/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "buzz.localhost:9443" })
    .click();
  await shell(page);
  expect(await invoke(page, "identity_restore")).toBe(getPublicKey(secret));
  // The old vault stays as it was, for rollback.
  expect(
    await page.evaluate(async () => {
      const request = indexedDB.open("buzz-desktop-web-vault");
      const database = await new Promise<IDBDatabase>((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      const read = database
        .transaction("identity")
        .objectStore("identity")
        .get("current");
      return new Promise((resolve) => {
        read.onsuccess = () => resolve(read.result.ciphertext.byteLength);
      });
    }),
  ).toBe(seeded);

  // Sign-out removes every copy of the key on this origin.
  await invoke(page, "sign_out", { wipe: false, removeAgents: false }).catch(
    () => {},
  );
  await expect(page.getByLabel("Community URL")).toBeVisible();
  expect(await invoke(page, "identity_restore")).toBeNull();
  expect(await invoke(page, "identity_legacy_available")).toBe(false);
});
