import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent,
} from "nostr-tools";
import { beforeEach, expect, test, vi } from "vitest";

// In-memory vault; IndexedDB itself is exercised by the browser run.
const store = vi.hoisted(() => ({
  saved: undefined as Uint8Array | undefined,
  legacy: undefined as Uint8Array | undefined,
}));
vi.mock("./vault.ts", async () => {
  const { getPublicKey } = await import("nostr-tools");
  const SAVED = "An identity is already saved; nothing was overwritten";
  return {
    SAVED,
    load: async () => store.saved ?? null,
    save: async (secret: Uint8Array) => {
      if (store.saved) throw SAVED;
      store.saved = secret;
    },
    remove: async () => {
      store.saved = undefined;
    },
    legacyRecord: async () =>
      store.legacy && { pubkey: getPublicKey(store.legacy) },
    loadLegacy: async () => store.legacy ?? null,
  };
});
// Each test starts from a fresh Worker: no key read yet.
let keys: typeof import("./keys.ts").keyCommands;
const run = (command: string, args: Record<string, unknown> = {}) =>
  Promise.resolve().then(() => keys[command]?.(args));

const community = "https://relay.test";
const secret = generateSecretKey();
const viewer = getPublicKey(secret);
const nsec = nip19.nsecEncode(secret);
const other = getPublicKey(generateSecretKey());
const channel = "0b6f8c7e-3f1a-4a2b-9c3d-2e1f0a9b8c7d";
const message = {
  kind: 9,
  created_at: 1,
  tags: [["h", channel]],
  content: "hi",
};
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

beforeEach(async () => {
  store.saved = undefined;
  store.legacy = undefined;
  fetchMock.mockReset();
  vi.resetModules();
  keys = (await import("./keys.ts")).keyCommands;
  await run("identity_import", { nsec });
});

test("identity is create-only and never replaced", async () => {
  expect(await run("identity_restore")).toBe(viewer);
  await expect(run("identity_create")).rejects.toMatch(/already saved/);
  await expect(run("identity_import", { nsec })).rejects.toMatch(
    /already saved/,
  );
  expect(await run("identity_export")).toBe(nsec);
  await run("sign_out");
  await expect(run("identity_restore")).rejects.toBe("Buzz is signing out");
});

test("signs only allowed kinds for this build's communities", async () => {
  const event = await run("relay_sign", { community, event: message });
  expect(verifyEvent(event as never)).toBe(true);
  for (const [target, kind, error] of [
    [
      "https://elsewhere.test",
      9,
      "This community isn't available in this app.",
    ],
    [community, 27235, "This event is not supported in the browser yet"],
    [community, 30078, "This event is not supported in the browser yet"],
    [community, 20002, "Invalid typing indicator"],
  ] as const)
    await expect(
      run("relay_sign", { community: target, event: { ...message, kind } }),
    ).rejects.toBe(error);
});

test("binds relay authentication to the community", async () => {
  const auth = (relay: string) => ({
    kind: 22242,
    created_at: 1,
    content: "",
    tags: [
      ["relay", relay],
      ["challenge", "abc"],
    ],
  });
  await expect(
    run("relay_sign", { community, event: auth("wss://relay.test") }),
  ).resolves.toMatchObject({ kind: 22242, pubkey: viewer });
  await expect(
    run("relay_sign", { community, event: auth("wss://elsewhere.test") }),
  ).rejects.toBe("Relay authentication does not match this community");
});

test("signs relay requests with NIP-98 for exactly that request", async () => {
  fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
  const body = JSON.stringify([{ kinds: [9], limit: 1 }]);
  const response = await run("relay_http", {
    community,
    path: "/query",
    method: "POST",
    body,
  });
  expect(response).toMatchObject({ status: 200, body: "[]" });
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  const header = new Headers(init?.headers).get("Authorization") ?? "";
  const auth = JSON.parse(atob(header.replace("Nostr ", "")));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  );
  expect(String(url)).toBe("https://relay.test/query");
  expect(verifyEvent(auth)).toBe(true);
  expect(auth).toMatchObject({ kind: 27235, pubkey: viewer });
  expect(Object.fromEntries(auth.tags)).toMatchObject({
    u: "https://relay.test/query",
    method: "POST",
    payload: Buffer.from(digest).toString("hex"),
  });
  await expect(
    run("relay_http", { community, path: "/admin", method: "POST", body }),
  ).rejects.toBe("Unsupported relay request");
  await expect(
    run("relay_http", {
      community,
      path: "/events",
      method: "POST",
      body: JSON.stringify({ kind: 41010 }),
    }),
  ).rejects.toBe("Choose between one and eight other people.");
});

test("cancels a read with native's cancelled answer", async () => {
  fetchMock.mockImplementation(
    (_, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error())),
      ),
  );
  const id = crypto.randomUUID();
  const read = run("relay_http", {
    community,
    path: "/query",
    method: "POST",
    body: "[]",
    id,
  });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await run("relay_http_cancel", { id });
  expect(await read).toEqual({ status: 499, headers: {}, body: "" });
});

test("opens a direct message from the relay's receipt", async () => {
  fetchMock.mockImplementation(async (_, init) => {
    const event = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        event_id: event.id,
        accepted: true,
        message: `response:${JSON.stringify({ channel_id: channel })}`,
      }),
    );
  });
  expect(
    await run("relay_direct_message", { community, pubkeys: [other] }),
  ).toBe(channel);
  await expect(
    run("relay_direct_message", { community, pubkeys: [viewer] }),
  ).rejects.toBe("Choose between one and eight other people.");
});

test("round-trips self-encrypted read state and sidebar records", async () => {
  const blob = { v: 1, client_id: "web", contexts: {} };
  const read = await run("relay_sign_read_state", {
    community,
    intent: {
      slot: "0".repeat(32),
      createdAt: Math.floor(Date.now() / 1000),
      blob,
    },
  });
  expect(
    await run("relay_decode_read_state", { community, events: [read] }),
  ).toEqual([{ eventId: (read as { id: string }).id, blob }]);
  const stars = {
    version: 1,
    channels: { a: { starred: true, updatedAt: 1 } },
  };
  const sidebar = await run("relay_sign_sidebar", {
    coordinate: "channel-stars",
    payload: stars,
    createdAt: 1,
  });
  expect(await run("relay_decode_sidebar", { events: [sidebar] })).toEqual({
    "channel-stars": stars,
  });
  await expect(
    run("relay_sign_sidebar", {
      coordinate: "channel-stars",
      payload: { version: 2 },
      createdAt: 1,
    }),
  ).rejects.toBe("Invalid sidebar payload");
  const foreign = finalizeEvent(
    { ...(sidebar as typeof message), tags: [["d", "channel-stars"]] },
    generateSecretKey(),
  );
  await expect(run("relay_decode_sidebar", { events: [foreign] })).rejects.toBe(
    "Invalid sidebar record",
  );
});

test("imports the previous PWA's identity and communities", async () => {
  await expect(run("identity_import_legacy")).rejects.toMatch(/already saved/);
  vi.resetModules();
  keys = (await import("./keys.ts")).keyCommands;
  store.saved = undefined;
  store.legacy = secret;
  expect(await run("identity_legacy_available")).toBe(true);
  expect(await run("identity_import_legacy")).toBe(viewer);
  expect(store.legacy).toBe(secret);
  const saved = JSON.stringify([
    { relayUrl: "wss://relay.test" },
    { relayUrl: "wss://elsewhere.test" },
    null,
  ]);
  expect(await run("legacy_communities", { saved })).toEqual([
    { relayUrl: "wss://relay.test", pubkey: viewer },
  ]);
});
