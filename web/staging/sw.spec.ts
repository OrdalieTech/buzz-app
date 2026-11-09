import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  test,
  type Worker,
} from "@playwright/test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
} from "nostr-tools";

const port = process.env.STAGING_PORT ?? "9443";

// The service worker against the local staging relay: signed media (image,
// video with Range, download), the running-tab notification stand-in, and a
// push lease, a push wake and its tap routed to the message. Needs ffmpeg.
const community = `https://buzz.localhost:${port}`;
const run = Date.now().toString(36);
// Chromium refuses a service worker script behind an untrusted certificate,
// and its headless shell denies notifications.
test.use({
  channel: "chromium",
  launchOptions: { args: ["--ignore-certificate-errors"] },
});

const invoke = (page: Page, command: string, args?: object) =>
  page.evaluate(
    ([command, args]) =>
      Reflect.get(window, "__TAURI_INTERNALS__").invoke(command, args),
    [command, args] as const,
  );

async function signUp(browser: Browser, name: string) {
  const context = await browser.newContext({ permissions: ["notifications"] });
  const page = await context.newPage();
  await page.goto("/");
  const secret = generateSecretKey();
  await invoke(page, "identity_import", { nsec: nip19.nsecEncode(secret) });
  await page.reload();
  const field = page.getByLabel("Invite link or community URL");
  const next = page.getByRole("button", { name: "Continue" });
  await expect(async () => {
    await field.fill(`wss://buzz.localhost:${port}`);
    await field.press("Enter");
    await expect(next).toBeVisible({ timeout: 2000 });
  }).toPass();
  await next.click();
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Publish profile & open" }).click();
  await expect(
    page.getByRole("button", { name: "Create channel" }),
  ).toBeVisible();
  await expect.poll(() => context.serviceWorkers().length).toBe(1);
  return { page, secret };
}

/** A one-colour PNG with only the chunks the relay admits (ffmpeg adds pHYs). */
function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8);
  const row = Buffer.from([0, ...Array(width).fill([255, 140, 0]).flat()]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Blossom upload as the native host does it, from the test process. */
async function upload(
  request: APIRequestContext,
  secret: Uint8Array,
  file: string,
  type: string,
) {
  const body = readFileSync(file);
  const hash = createHash("sha256").update(body).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      content: "Upload attachment",
      tags: [
        ["x", hash],
        ["t", "upload"],
        ["server", `buzz.localhost:${port}`],
        ["expiration", String(now + 60)],
      ],
    },
    secret,
  );
  const response = await request.put(`${community}/upload`, {
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
      "Content-Type": type,
      "X-SHA-256": hash,
    },
    data: body,
  });
  expect(response.status(), await response.text()).toBe(200);
  return {
    url: (await response.json()).url as string,
    hash,
    size: body.length,
  };
}

async function post(
  page: Page,
  channel: string,
  content: string,
  tags: string[][] = [],
) {
  const event = await invoke(page, "relay_sign", {
    community,
    event: {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [["h", channel], ...tags],
    },
  });
  const { status } = (await invoke(page, "relay_http", {
    community,
    path: "/events",
    method: "POST",
    body: JSON.stringify(event),
  })) as { status: number };
  expect(status).toBe(200);
  return (event as { id: string }).id;
}

/** Fires a service worker event the way the browser would, and waits for it. */
const dispatch = (
  page: Page,
  type: "push" | "notificationclick",
  tag?: string,
) =>
  (page.context().serviceWorkers()[0] as Worker).evaluate(
    async ([type, tag]) => {
      const scope = self as unknown as ServiceWorkerGlobalScope;
      const [notification] = tag
        ? await scope.registration.getNotifications({ tag })
        : [];
      const event =
        type === "push"
          ? new PushEvent("push")
          : new NotificationEvent("notificationclick", {
              notification: notification as Notification,
            });
      let done: Promise<unknown> = Promise.resolve();
      Object.defineProperty(event, "waitUntil", {
        value: (work: Promise<unknown>) => (done = work),
      });
      scope.dispatchEvent(event);
      await done;
    },
    [type, tag] as const,
  );
const notifications = (page: Page) =>
  page.evaluate(async () =>
    (await (await navigator.serviceWorker.ready).getNotifications()).map(
      ({ title, body, tag, data }) => ({ title, body, tag, data }),
    ),
  );

test("signs relay media and routes notifications to their message", async ({
  browser,
  request,
}) => {
  const alice = await signUp(browser, `Alice ${run}`);
  const bob = await signUp(browser, `Bob ${run}`);
  // Upstream's avatar preview registers the community first, as with the dev broker.
  expect(
    await bob.page.evaluate(
      async () =>
        (await fetch("/api/relay/register", { method: "POST" })).status,
    ),
  ).toBe(204);

  // A DM from Alice carrying an image and a fast-start H.264/AAC video.
  await alice.page.getByRole("button", { name: "New message" }).click();
  await alice.page
    .getByRole("combobox", { name: "Message recipients" })
    .fill(`Bob ${run}`);
  await alice.page.getByRole("option", { name: `Bob ${run}` }).click();
  await alice.page.getByRole("textbox", { name: /^Message/ }).click();
  await alice.page.keyboard.type(`hi Bob ${run}`);
  await alice.page.keyboard.press("Enter");
  const row = bob.page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("button", { name: `Alice ${run}` });
  const channel = (await row.getAttribute("data-channel-id")) ?? "";

  const dir = mkdtempSync(join(tmpdir(), "buzz-sw-"));
  // Canonical media, as upstream's preparation makes it (no metadata).
  const ffmpeg = (args: string, output: string) =>
    execFileSync("ffmpeg", [
      ...`-loglevel error -f lavfi ${args} -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact`.split(
        " ",
      ),
      join(dir, output),
    ]);
  writeFileSync(join(dir, "dot.png"), png(64, 48));
  ffmpeg(
    "-i testsrc=size=160x120:rate=15 -f lavfi -i sine -t 3 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart -metadata encoder=",
    "clip.mp4",
  );
  const [image, clip] = [
    {
      name: "dot.png",
      type: "image/png",
      ...(await upload(
        request,
        alice.secret,
        join(dir, "dot.png"),
        "image/png",
      )),
    },
    {
      name: "clip.mp4",
      type: "video/mp4",
      ...(await upload(
        request,
        alice.secret,
        join(dir, "clip.mp4"),
        "video/mp4",
      )),
    },
  ];
  await post(
    alice.page,
    channel,
    [image, clip]
      .map(({ name, url }) => `![${name.replace(".", "\\.")}](<${url}>)`)
      .join("\n\n"),
    [image, clip].map(({ name, type, url, hash, size }) => [
      "imeta",
      `url ${url}`,
      `m ${type}`,
      `size ${size}`,
      `x ${hash}`,
      `filename ${name}`,
    ]),
  );
  // An unsigned read is refused by the relay; the worker's is not.
  expect((await request.get(image.url)).status()).toBe(401);

  await row.click();
  const img = bob.page.locator(`img[src*="${image.hash}"]`);
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(64);
  const video = bob.page.locator("video").first();
  await expect(video).toHaveAttribute("src", new RegExp(clip.hash));
  await video.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    return element.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0.5);
  // Seeking is served from a ranged read.
  const ranged = await bob.page.evaluate(
    async (src) =>
      (await fetch(src, { headers: { Range: "bytes=0-99" } })).status,
    (await video.getAttribute("src")) ?? "",
  );
  expect(ranged).toBe(206);

  // The viewer's download action saves through media_download.
  await bob.page
    .getByRole("button", { name: "Open video fullscreen" })
    .dispatchEvent("click");
  const [download] = await Promise.all([
    bob.page.waitForEvent("download"),
    bob.page.getByRole("button", { name: "Download video" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("clip.mp4");
  expect(readFileSync(await download.path()).length).toBe(clip.size);
  await bob.page.keyboard.press("Escape");

  // A running-tab alert goes through the worker, and its tap opens the message.
  await bob.page.getByRole("tab", { name: "Activity" }).click();
  const text = `are you there ${run}`;
  await post(alice.page, channel, text);
  await expect
    .poll(async () =>
      (await notifications(bob.page)).find((item) => item.body === text),
    )
    .toMatchObject({
      data: { page: true },
    });
  const shown = (await notifications(bob.page)).find(
    (item) => item.body === text,
  );
  await dispatch(bob.page, "notificationclick", shown?.tag);
  await expect(bob.page.getByText(text)).toBeVisible();

  // Push: with a browser subscription (stubbed: headless Chromium has no push
  // service), the worker leases mentions and the DM through the gateway
  // (webpush.mjs here), and the relay delivers a wake for a new message.
  await bob.page.getByRole("tab", { name: "Activity" }).click();
  const stub = (endpoint: string) => {
    const subscription = {
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint, keys: { p256dh: "p256dh", auth: "auth" } }),
      unsubscribe: async () => true,
    };
    const manager = (self as unknown as ServiceWorkerGlobalScope).registration
      ?.pushManager;
    Object.assign(manager ?? PushManager.prototype, {
      getSubscription: async () => subscription,
    });
  };
  const endpoint = `https://push.example/${run}`;
  await (bob.page.context().serviceWorkers()[0] as Worker).evaluate(
    stub,
    endpoint,
  );
  await bob.page.evaluate(stub, endpoint);
  await bob.page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  const bobKey = getPublicKey(bob.secret);
  await expect
    .poll(() =>
      bob.page.evaluate(async () => {
        const name = "buzz-desktop-web-push";
        // Opening a missing database would create it without its store.
        if (!(await indexedDB.databases()).some((db) => db.name === name))
          return null;
        const request = indexedDB.open(name);
        const database = await new Promise<IDBDatabase>((resolve) => {
          request.onsuccess = () => resolve(request.result);
        });
        const read = database
          .transaction("context")
          .objectStore("context")
          .get("current");
        return new Promise((resolve) => {
          read.onsuccess = () => resolve(read.result);
        });
      }),
    )
    .toMatchObject({
      pubkey: bobKey,
      active: true,
      filters: [{ "#p": [bobKey] }, { kinds: [9], "#h": [channel] }],
    });
  const wake = async (text: string) => {
    const deliveries = async () =>
      (await (await request.get(`${community}/webpush/deliveries`)).json())
        .length;
    const before = await deliveries();
    // A later second than the previous line, so this one sorts newest.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const id = await post(alice.page, channel, text);
    await expect.poll(deliveries).toBe(before + 1);
    await dispatch(bob.page, "push");
    expect(
      (await notifications(bob.page)).find((item) => item.tag === channel),
    ).toMatchObject({
      title: `Alice ${run}`,
      // The channel's unread lines are grouped, newest last.
      body: expect.stringContaining(text),
      data: {
        target: { kind: "conversation", channelId: channel, messageId: id },
      },
    });
  };
  await wake(`wake up ${run}`);
  // Read in the app (Messages reopens the conversation; reading counts with
  // focus in it), the alert is taken back once read state reaches the relay
  // (published 5 s after reading).
  await bob.page.getByRole("tab", { name: "Messages" }).click();
  await bob.page.getByRole("textbox", { name: /^Message/ }).click();
  await expect
    .poll(
      async () => {
        await bob.page.evaluate(() =>
          navigator.serviceWorker.controller?.postMessage({
            type: "buzz-close-read",
          }),
        );
        return (await notifications(bob.page)).some(
          (item) => item.tag === channel,
        );
      },
      { timeout: 40_000, intervals: [2000] },
    )
    .toBe(false);

  await bob.page.getByRole("tab", { name: "Activity" }).click();
  await wake(`wake up again ${run}`);
  await dispatch(bob.page, "notificationclick", channel);
  await expect(bob.page).toHaveURL(new RegExp(`#buzz=.*${channel}`));
  await expect(bob.page.getByText(`wake up again ${run}`)).toBeVisible();
});
