import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
} from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { derive, ecdh } from "../pairing.ts";

const port = process.env.STAGING_PORT ?? "9443";

// End-to-end journey of the web build against the local staging relay. Test
// keys only; staging data outlives a run, so names carry a run suffix.
const community = `https://buzz.localhost:${port}`;
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

/** First run up to the key choice for the staging community. */
async function choose(page: Page, lane: string) {
  await expect(async () => {
    await page.getByLabel("Community URL").fill(`buzz.localhost:${port}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("button", { name: lane })).toBeVisible({
      timeout: 2000,
    });
  }).toPass();
  await page.getByRole("button", { name: lane }).click();
}

test("chats through the browser host", async ({ browser }) => {
  // Alice brings a key through first run's "I already have a key".
  const alice = await open(browser);
  const aliceName = `Alice ${run}`;
  await choose(alice, "I already have a key");
  await alice
    .getByLabel("Private key or backup")
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
  await join(`wss://buzz.localhost:${port}`);
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
    async ({ secret, pubkey, port }) => {
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
          {
            id: "a",
            name: "Staging",
            relayUrl: `wss://buzz.localhost:${port}`,
          },
          { id: "b", name: "Other", relayUrl: "wss://other.example.com" },
        ]),
      );
      return ciphertext.byteLength;
    },
    { secret: [...secret], pubkey: getPublicKey(secret), port },
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
    .getByRole("button", { name: `buzz.localhost:${port}` })
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

test("creates a key, backs it up and restores it from the backup", async ({
  browser,
}) => {
  const page = await open(browser);
  // No email sign-in in this build: the key choice is explicit.
  await expect(page.getByLabel("Community URL")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with email" }),
  ).toBeHidden();
  await choose(page, "Create my key");
  const npub = page.getByText(/^npub1/);
  await expect(npub).toBeVisible();
  const viewer = nip19.decode(
    (await npub.textContent()) as `npub1${string}`,
  ).data;
  const proceed = page.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  const password = `staging backup ${run}`;
  await page.getByLabel("Backup password").fill(password);
  await page.getByLabel("Repeat password").fill(password);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download backup file" }).click(),
  ]);
  const file = await download.path();
  // Nothing is saved before Continue.
  expect(await invoke(page, "identity_restore")).toBeNull();
  await proceed.click();
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await profile(page, `Carol ${run}`);
  expect(await invoke(page, "identity_restore")).toBe(viewer);

  await invoke(page, "sign_out", { wipe: false, removeAgents: false }).catch(
    () => {},
  );
  await choose(page, "I already have a key");
  await page.getByLabel("Backup file").setInputFiles(file);
  await page.getByLabel("Backup password").fill(password);
  await page.getByRole("button", { name: "Continue with this key" }).click();
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await shell(page);
  expect(await invoke(page, "identity_restore")).toBe(viewer);
});

test("receives an identity from Buzz desktop's Pair mobile", async ({
  browser,
}) => {
  // Buzz desktop's side (src-tauri/src/pairing), driven from here.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const relay = `wss://buzz.localhost:${port}/pair`;
  const source = generateSecretKey();
  const secret = generateSecretKey();
  const account = generateSecretKey();
  const conversation = (peer: string) =>
    nip44.v2.utils.getConversationKey(source, peer);
  const inbox: Record<string, unknown>[] = [];
  let target = "";
  const socket = new WebSocket(relay);
  socket.onmessage = ({ data }) => {
    const [type, , event] = JSON.parse(String(data));
    if (type !== "EVENT") return;
    target = event.pubkey;
    inbox.push(
      JSON.parse(nip44.v2.decrypt(event.content, conversation(target))),
    );
  };
  await new Promise((resolve) => {
    socket.onopen = resolve;
  });
  socket.send(
    JSON.stringify([
      "REQ",
      "pair",
      { kinds: [24134], "#p": [getPublicKey(source)] },
    ]),
  );
  const tell = (message: object) =>
    socket.send(
      JSON.stringify([
        "EVENT",
        finalizeEvent(
          {
            kind: 24134,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["p", target]],
            content: nip44.v2.encrypt(
              JSON.stringify(message),
              conversation(target),
            ),
          },
          source,
        ),
      ]),
    );

  const page = await open(browser);
  await choose(page, "Pair with Buzz desktop");
  await page
    .getByLabel("Pairing code")
    .fill(
      `nostrpair://${getPublicKey(source)}?secret=${bytesToHex(secret)}&relay=${encodeURIComponent(relay)}&v=1`,
    );
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => inbox[0]?.type).toBe("offer");
  const { id, sas, transcript } = await derive(
    secret,
    getPublicKey(source),
    target,
    ecdh(source, target),
  );
  expect(inbox[0]?.session_id).toBe(id);
  // The user compares codes, then confirms on desktop, which sends at once.
  await expect(
    page.getByText(`${sas.slice(0, 3)} ${sas.slice(3)}`),
  ).toBeVisible();
  tell({ type: "sas-confirm", transcript_hash: transcript });
  tell({
    type: "payload",
    payload_type: "custom",
    payload: JSON.stringify({
      relayUrl: community,
      pubkey: getPublicKey(account),
      nsec: nip19.nsecEncode(account),
    }),
  });
  // Nothing is kept until the codes match here too.
  expect(await invoke(page, "identity_restore")).toBeNull();
  await page.getByRole("button", { name: "Codes match" }).click();
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await profile(page, `Dave ${run}`);
  expect(await invoke(page, "identity_restore")).toBe(getPublicKey(account));
  await expect
    .poll(() => inbox.at(-1))
    .toEqual({ type: "complete", success: true });
  socket.close();
});
