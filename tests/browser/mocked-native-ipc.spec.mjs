import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { schnorr } from "@noble/curves/secp256k1.js";

// Browser boundary: real page reload, localStorage admission and IndexedDB outbox
// persistence through the packaged adapter. Failure matrices live in Vitest.
test("mocked native IPC admission and uncertain delivery survive page reload without the broker", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    define: { "import.meta.env.VITE_BUZZ_LIVE": '"0"' },
    server: { host: "127.0.0.1", port: 0 },
  });
  const key = generateSecretKey();
  const viewer = getPublicKey(key);
  const community = "https://packaged-fixture.test";
  const calls = [],
    messages = [];
  let admitted = false,
    profile;
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.isTauri = true;
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    window.WebSocket = class {
      close() {}
    };
    window.fetch = () => {
      throw new Error("No development broker");
    };
  });
  await page.exposeFunction(
    "mockedNativeIpcInvoke",
    async (command, payload) => {
      if (command === "identity_restore") return viewer;
      if (command === "relay_sign") {
        expect(Object.keys(payload.event).sort()).toEqual([
          "content",
          "created_at",
          "kind",
          "tags",
        ]);
        expect(payload.community).toBe(community);
        return finalizeEvent(payload.event, key);
      }
      if (command === "relay_verify_signatures")
        return payload.claims.map(({ id, pubkey, sig }) =>
          schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey)),
        );
      expect(command).toBe("relay_http");
      expect(payload.community).toBe(community);
      const body = payload.body ? JSON.parse(payload.body) : undefined;
      calls.push(payload.path);
      const response = (body, status = 200) => ({
        status,
        headers: {},
        body: JSON.stringify(body),
      });
      if (payload.path === "/")
        return response({
          self: viewer,
          name: "Fixture community",
          supported_nips: [1, 42, 43],
        });
      if (payload.path === "/api/join-policy")
        return response({ policy: null });
      if (payload.path === "/api/invites/claim") {
        admitted = true;
        throw new Error("Claim receipt lost");
      }
      if (payload.path === "/query") {
        if (!admitted) return response({ error: "not admitted" }, 403);
        return response(
          body.some((filter) => filter.kinds?.includes(0)) && profile
            ? [profile]
            : [],
        );
      }
      if (payload.path === "/events") {
        expect(verifyEvent(body)).toBe(true);
        expect(body.pubkey).toBe(viewer);
        if (body.kind === 0) profile = body;
        else {
          messages.push(body);
          if (messages.length === 1) throw new Error("Message receipt lost");
        }
        return response({ accepted: true, event_id: body.id });
      }
      throw new Error(`Unexpected request ${payload.path}`);
    },
  );
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mocked-native-ipc.html`,
    );
    await page.getByRole("button", { name: "Add a community" }).click();
    await page.getByLabel("Community URL").fill(community);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Invite code").fill("v2.fixture");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Claim receipt lost");
    await page.reload();
    await page.getByRole("button", { name: "Add a community" }).click();
    await expect(page.getByLabel("Community URL")).toHaveValue(community);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Fixture member");
    await page.getByRole("button", { name: "Publish profile & open" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByLabel("Selected community", { exact: true }),
    ).toHaveText(community);
    await page.getByRole("button", { name: "Send fixture message" }).click();
    await expect(page.getByLabel("Delivery", { exact: true })).toHaveText(
      "unknown",
    );
    // The UI update precedes its durable status write; observe the actual commit.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("buzz-outbox-v2", 2);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            return await new Promise((resolve) => {
              const tx = db.transaction("events");
              const request = tx.objectStore("events").getAll();
              tx.oncomplete = () =>
                resolve(
                  request.result.some(
                    (entry) => entry.operation.delivery === "unknown",
                  ),
                );
            });
          } finally {
            db.close();
          }
        }),
      )
      .toBe(true);
    await page.reload();
    await expect(page.getByLabel("Connection", { exact: true })).toHaveText(
      "ready",
    );
    await expect(page.getByLabel("Delivery", { exact: true })).toHaveText(
      "unknown",
    );
    expect(messages).toHaveLength(1);
    await page.getByRole("button", { name: "Retry delivery" }).click();
    await expect(page.getByLabel("Delivery", { exact: true })).toHaveText(
      "accepted",
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual(messages[0]);
    expect(calls.filter((path) => path === "/api/invites/claim")).toHaveLength(
      1,
    );
    expect(errors.unexplained()).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("mocked-native-ipc-recovery.png"),
    });
  } finally {
    await server.close();
  }
});
