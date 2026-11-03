import { schnorr } from "@noble/curves/secp256k1.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { beforeEach, expect, test, vi } from "vitest";
import {
  parsePrivateRecord,
  privateCoordinate,
  privateTag,
} from "../src/features/channel-templates/model.ts";

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

test("authorizes exactly one agent key, unconditionally", async () => {
  const tag = (await run("identity_prepare_remote_agent_authorization", {
    owner: viewer,
    agentPubkey: other,
  })) as string[];
  expect(tag.slice(0, 3)).toEqual(["auth", viewer, ""]);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`nostr:agent-auth:${other}:`),
    ),
  );
  expect(
    schnorr.verify(hexToBytes(tag[3] ?? ""), digest, hexToBytes(viewer)),
  ).toBe(true);
  for (const [owner, agentPubkey, error] of [
    [viewer, viewer, "Owner and agent pubkeys must differ"],
    [
      viewer,
      other.toUpperCase(),
      "Agent pubkey must be 64 lowercase hex characters",
    ],
    [other, viewer, "The agent owner is not your signed-in identity"],
  ])
    await expect(
      run("identity_prepare_remote_agent_authorization", {
        owner,
        agentPubkey,
      }),
    ).rejects.toBe(error);
});

test("signs and deletes only the viewer's own agent records", async () => {
  const record = {
    kind: 30177,
    created_at: 1,
    content: "{}",
    tags: [["d", other]],
  };
  await expect(
    run("relay_sign", { community, event: record }),
  ).resolves.toMatchObject({ kind: 30177 });
  const deletion = (owner: string) => ({
    kind: 5,
    created_at: 1,
    content: "",
    tags: [
      ["a", `30177:${owner}:${other}`],
      ["k", "30177"],
    ],
  });
  await expect(
    run("relay_sign", { community, event: deletion(viewer) }),
  ).resolves.toMatchObject({ kind: 5 });
  await expect(
    run("relay_sign", { community, event: deletion(other) }),
  ).rejects.toBeTruthy();
});

const agentSecret = generateSecretKey();
const agent = getPublicKey(agentSecret);
const toOwner = nip44.v2.utils.getConversationKey(agentSecret, viewer);
const seconds = () => Math.floor(Date.now() / 1000);

test("decodes an agent's telemetry to its owner only", async () => {
  const tags = [
    ["p", viewer],
    ["agent", agent],
    ["frame", "telemetry"],
  ];
  const frame = (tags: string[][], created_at = seconds()) =>
    finalizeEvent(
      {
        kind: 24200,
        created_at,
        tags,
        content: nip44.v2.encrypt('{"type":"turn"}', toOwner),
      },
      agentSecret,
    );
  const event = frame(tags);
  expect(await run("relay_agent_observer", { community, event })).toEqual({
    id: event.id,
    agent,
    createdAt: event.created_at,
    plaintext: '{"type":"turn"}',
  });
  for (const forged of [
    frame([["p", other], ...tags.slice(1)]),
    frame([...tags, ["p", viewer]]),
    frame(tags, seconds() - 400),
    { ...event, content: `${event.content.slice(0, -2)}AA` },
  ])
    await expect(
      run("relay_agent_observer", { community, event: forged }),
    ).rejects.toBeTruthy();
});

test("pages and decodes an agent's memory", async () => {
  const mac = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(toOwner),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const memory = async (body: { slug: string }, created_at: number) => {
    const d = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        mac,
        new TextEncoder().encode(`agent-memory/v1/d-tag\0${body.slug}`),
      ),
    ).toString("hex");
    return finalizeEvent(
      {
        kind: 30174,
        created_at,
        tags: [
          ["d", d],
          ["p", viewer],
        ],
        content: nip44.v2.encrypt(JSON.stringify(body), toOwner),
      },
      agentSecret,
    );
  };
  const events = [
    await memory({ slug: "core", profile: "I sell." } as never, 3),
    await memory({ slug: "mem/leads", value: "two" } as never, 2),
    await memory({ slug: "mem/old", value: null } as never, 2),
    await memory({ slug: "mem/leads", value: "one" } as never, 1),
    { ...(await memory({ slug: "mem/x" }, 1)), sig: "0".repeat(128) },
  ];
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify(events)),
  );
  const read = () =>
    run("relay_agent_memories_read", { community, agent, slug: null });
  expect(await read()).toEqual({
    entries: [
      { slug: "core", body: "I sell.", eventId: events[0]?.id, createdAt: 3 },
      { slug: "mem/leads", body: "two", eventId: events[1]?.id, createdAt: 2 },
    ],
    deleted: [{ slug: "mem/old", createdAt: 2 }],
    partial: true,
  });
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? ""))).toEqual([
    { kinds: [30174], authors: [agent], "#p": [viewer], limit: 100 },
  ]);
  fetchMock.mockImplementation(async () => new Response("", { status: 403 }));
  await expect(read()).rejects.toBe("MemoryDenied");
});

test("round-trips self-encrypted reminders and channel recipes", async () => {
  fetchMock.mockImplementation(async () => new Response("{}"));
  const publish = (event: unknown) =>
    run("relay_http", {
      community,
      path: "/events",
      method: "POST",
      body: JSON.stringify(event),
    });
  const now = Math.floor(Date.now() / 1000);
  const content = {
    target: {
      eventId: "a".repeat(64),
      channelId: channel,
      preview: "hi",
      authorPubkey: other,
    },
    status: "pending",
  };
  const intent = { d: "0".repeat(32), createdAt: now, content };
  const reminder = (await run("relay_sign_reminder", {
    intent: { ...intent, notBefore: now + 60 },
  })) as typeof message & { id: string };
  expect(reminder.tags).toEqual([
    ["d", intent.d],
    ["not_before", String(now + 60)],
  ]);
  // A tampered record is skipped, not fatal to the list.
  expect(
    await run("relay_decode_reminders", {
      events: [reminder, { ...reminder, content: "x" }],
    }),
  ).toEqual([{ eventId: reminder.id, content }]);
  await publish(reminder);
  for (const bad of [
    { ...intent, notBefore: now, content: { ...content, status: "done" } },
    { ...intent, expiration: now + 86_400 },
    { ...intent, notBefore: now, extra: 1 },
  ])
    await expect(run("relay_sign_reminder", { intent: bad })).rejects.toBe(
      "Invalid reminder",
    );

  const record = {
    version: 1,
    community,
    deleted: false,
    value: { type: "team", id: "team-one", name: "Team", agents: [] },
  };
  const parsed = parsePrivateRecord(record, community);
  const tags = [
    ["d", privateCoordinate(parsed)],
    ["t", privateTag(parsed)],
  ];
  const recipe = (await run("relay_kit_sign", {
    community,
    event: {
      kind: 30078,
      created_at: 1,
      tags,
      content: await run("relay_kit_prepare", { community, record }),
    },
  })) as typeof message & { id: string };
  expect(
    await run("relay_kit_decode", { community, events: [recipe] }),
  ).toEqual([{ eventId: recipe.id, record: parsed }]);
  await publish(recipe);
  await expect(
    run("relay_kit_sign", {
      community,
      event: { ...recipe, tags: [["d", "other"], tags[1]] },
    }),
  ).rejects.toBe("Invalid channel recipe");
  await expect(
    run("relay_kit_prepare", { community: "https://relay.test", record: {} }),
  ).rejects.toBe("Invalid channel recipe");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("reads a workflow's runs with an authenticated GET", async () => {
  fetchMock.mockResolvedValue(new Response("[]"));
  await run("relay_workflow_runs", { community, id: channel, cursor: null });
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  const header = new Headers(init?.headers).get("Authorization") ?? "";
  const auth = JSON.parse(atob(header.replace("Nostr ", "")));
  expect(String(url)).toBe(`${community}/workflows/${channel}/runs?limit=20`);
  expect(auth.tags.map(([name]: string[]) => name)).toEqual([
    "u",
    "method",
    "nonce",
  ]);
  await expect(
    run("relay_workflow_runs", { community, id: channel, cursor: {} }),
  ).rejects.toBe("Invalid workflow read");
});
