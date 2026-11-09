import { expect, type Page, test } from "@playwright/test";
import { finalizeEvent, generateSecretKey, nip19 } from "nostr-tools";

const port = process.env.STAGING_PORT ?? "9443";
// Uploads through the composer, as a user does. UPLOAD_MEDIA holds photo.jpg,
// photo.heic (sips), clip-hevc.mov, clip.webm, clip-h264.mp4 and
// voice-note-1700000000000.wav (ffmpeg testsrc2/sine, with metadata).
// Run with --browser webkit for Safari's codecs.
const media = process.env.UPLOAD_MEDIA ?? "/tmp/buzz-upload-media";
const secret = generateSecretKey();
const run = Date.now().toString(36);

test.use({
  launchOptions: [
    async ({ browserName }, use) =>
      use(
        browserName === "chromium"
          ? {
              args: [
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
              ],
            }
          : {},
      ),
    { scope: "worker" },
  ],
});

/** The relay's descriptor for the next `PUT /upload`, and the fetched bytes
 * (Blossom `get`, signed here with the test key). */
async function uploaded(page: Page, act: () => Promise<unknown>) {
  const response = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith("/upload"),
    { timeout: 60_000 },
  );
  await act();
  const put = await response;
  const descriptor = await put.json();
  expect(put.status(), JSON.stringify(descriptor)).toBe(200);
  const now = Math.floor(Date.now() / 1000);
  const token = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      content: "Get media",
      tags: [
        ["t", "get"],
        ["server", `buzz.localhost:${port}`],
        ["expiration", String(now + 60)],
      ],
    },
    secret,
  );
  const get = await page.request.get(descriptor.url, {
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(token)).toString("base64")}`,
    },
  });
  expect(get.status()).toBe(200);
  const bytes = await get.body();
  expect(bytes.length).toBe(descriptor.size);
  return { descriptor, bytes };
}
/** Top-level MP4 boxes, which the relay requires to start ftyp, moov. */
function boxes(bytes: Buffer) {
  const kinds = [];
  for (let at = 0; at + 8 <= bytes.length; at += bytes.readUInt32BE(at))
    kinds.push(bytes.toString("latin1", at + 4, at + 8));
  return kinds;
}

test("uploads images, HEIC, video and voice notes", async ({
  page,
  browserName,
}) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Other options" }).click();
  await expect(async () => {
    await page
      .getByLabel("Community address or invite link")
      .fill(`buzz.localhost:${port}`, { timeout: 2000 });
    await page
      .getByRole("button", { name: "Continue" })
      .click({ timeout: 2000 });
    await expect(
      page.getByRole("button", { name: "I already have a key" }),
    ).toBeVisible({ timeout: 2000 });
  }).toPass();
  await page.getByRole("button", { name: "I already have a key" }).click();
  await page.getByLabel("Private key or backup").fill(nip19.nsecEncode(secret));
  await page.getByRole("button", { name: "Continue with this key" }).click();
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await page.getByLabel("Display name").fill(`Uploader ${run}`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.getByLabel("Name").fill(`media-${run}`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create channel" })
    .click();
  const composer = page.getByRole("textbox", { name: /^Message/ });
  const attach = async (file: string) => {
    await page.locator('input[type="file"]').setInputFiles(`${media}/${file}`);
    await composer.click();
    await page.keyboard.press("Enter");
  };

  const photo = await uploaded(page, () => attach("photo.jpg"));
  expect(photo.descriptor.type).toBe("image/jpeg");

  for (const file of ["clip.webm", "clip-h264.mp4"]) {
    const clip = await uploaded(page, () => attach(file));
    expect(clip.descriptor.type).toBe("video/mp4");
    expect(boxes(clip.bytes).slice(0, 2)).toEqual(["ftyp", "moov"]);
  }
  // Safari decodes HEVC and HEIC; Playwright's Chromium does neither, and
  // says so.
  const refused = async (file: string, message: string) => {
    await page.locator('input[type="file"]').setInputFiles(`${media}/${file}`);
    await expect(page.getByText(message, { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: `Remove ${file}` }).click();
  };
  if (browserName === "webkit") {
    const clip = await uploaded(page, () => attach("clip-hevc.mov"));
    expect(clip.descriptor.type).toBe("video/mp4");
    const heic = await uploaded(page, () => attach("photo.heic"));
    expect(heic.descriptor.type).toBe("image/jpeg");
  } else {
    await refused("clip-hevc.mov", "can't read this file's format");
    await refused("photo.heic", "can't open HEIC photos");
  }

  // Recorded with Chromium's fake microphone; WebKit attaches a recording.
  const voice = await uploaded(page, async () => {
    if (browserName !== "chromium")
      return attach("voice-note-1700000000000.wav");
    await page.getByRole("button", { name: "Record voice note" }).click();
    await expect(page.getByRole("status").getByText(/^0:02/)).toBeVisible();
    await page.getByRole("button", { name: "Stop recording" }).click();
    await composer.click();
    await page.keyboard.press("Enter");
  });
  expect(voice.descriptor.type).toBe("video/mp4");
  expect(boxes(voice.bytes).slice(0, 2)).toEqual(["ftyp", "moov"]);
});
