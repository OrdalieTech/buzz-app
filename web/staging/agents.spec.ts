import { expect, type Page, test } from "@playwright/test";
import {
  type EventTemplate,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
} from "nostr-tools";

const port = process.env.STAGING_PORT ?? "9443";
const community = `https://buzz.localhost:${port}`;
const relay = `wss://buzz.localhost:${port}`;
const run = Date.now().toString(36);
// The agent below talks to the relay from Node, through Caddy's local CA.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const invoke = (page: Page, command: string, args?: object) =>
  page.evaluate(
    ([command, args]) =>
      Reflect.get(window, "__TAURI_INTERNALS__").invoke(command, args),
    [command, args] as const,
  );

/** An agent as buzz-acp runs it: its own key, admitted through its owner's
 * NIP-OA tag in its NIP-42 authentication. */
async function connectAgent(secret: Uint8Array, auth: string[]) {
  const socket = new WebSocket(relay);
  const acks = new Map<string, (ok: boolean, reason: string) => void>();
  const challenge = new Promise<string>((resolve) => {
    socket.onmessage = ({ data }) => {
      const [type, id, ok, reason] = JSON.parse(String(data));
      if (type === "AUTH") resolve(id);
      if (type === "OK") acks.get(id)?.(ok, reason);
    };
  });
  const send = (type: string, template: EventTemplate) =>
    new Promise<void>((resolve, reject) => {
      const event = finalizeEvent(template, secret);
      acks.set(event.id, (ok, reason) =>
        ok ? resolve() : reject(new Error(`${template.kind}: ${reason}`)),
      );
      socket.send(JSON.stringify([type, event]));
    });
  const now = () => Math.floor(Date.now() / 1000);
  await send("AUTH", {
    kind: 22242,
    created_at: now(),
    content: "",
    tags: [["relay", relay], ["challenge", await challenge], auth],
  });
  return {
    publish: (kind: number, tags: string[][], content: string) =>
      send("EVENT", { kind, created_at: now(), tags, content }),
    close: () => socket.close(),
  };
}

test("pairs a remote agent and reads what it publishes", async ({
  browser,
}) => {
  const owner = await (await browser.newContext()).newPage();
  await owner.goto("/");
  await owner.getByRole("button", { name: "Other options" }).click();
  await expect(async () => {
    await owner
      .getByLabel("Community address or invite link")
      .fill(`buzz.localhost:${port}`, { timeout: 2000 });
    await owner
      .getByRole("button", { name: "Continue" })
      .click({ timeout: 2000 });
    await expect(
      owner.getByRole("button", { name: "I already have a key" }),
    ).toBeVisible({ timeout: 2000 });
  }).toPass();
  await owner.getByRole("button", { name: "I already have a key" }).click();
  await owner
    .getByLabel("Private key or backup")
    .fill(nip19.nsecEncode(generateSecretKey()));
  await owner.getByRole("button", { name: "Continue with this key" }).click();
  await owner.getByRole("button", { name: "Join", exact: true }).click();
  await owner.getByLabel("Display name").fill(`Owner ${run}`);
  await owner.getByRole("button", { name: "Continue", exact: true }).click();
  const viewer = (await invoke(owner, "identity_restore")) as string;

  // A channel for the agent to post in.
  await owner.getByRole("button", { name: "Create channel" }).click();
  await owner.getByLabel("Name").fill(`orb-${run}`);
  await owner
    .getByRole("dialog")
    .getByRole("button", { name: "Create channel" })
    .click();
  const channel = await owner
    .getByRole("complementary", { name: "Sidebar" })
    .locator("[data-channel-id]", { hasText: `orb-${run}` })
    .getAttribute("data-channel-id");

  // Pair: paste the npub, confirm it in full, and get the tag to install.
  const agentSecret = generateSecretKey();
  const agent = getPublicKey(agentSecret);
  const name = `Beanie ${run}`;
  await owner.getByRole("tab", { name: "Agents" }).click();
  await owner.getByRole("button", { name: "Create your first agent" }).click();
  const dialog = owner.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Agent public key").fill(nip19.npubEncode(agent));
  await expect(dialog.getByText(nip19.npubEncode(agent))).toBeVisible();
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(
    dialog.getByText("Confirm that this agent is yours."),
  ).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Create agent" }).click();
  const line = await owner
    .locator("code", { hasText: "BUZZ_AUTH_TAG=" })
    .textContent();
  const auth = JSON.parse(line?.replace("BUZZ_AUTH_TAG=", "") ?? "");
  expect(auth.slice(0, 3)).toEqual(["auth", viewer, ""]);

  // The owner's record names the Orb runtime.
  const { body } = (await invoke(owner, "relay_http", {
    community,
    path: "/query",
    method: "POST",
    body: JSON.stringify([
      { kinds: [30177], authors: [viewer], "#d": [agent] },
    ]),
  })) as { body: string };
  expect(JSON.parse(body)[0].tags).toContainEqual(["runtime", "orb/agent"]);

  // The agent comes online with the tag, publishes its owner-attested
  // profile, a memory to its owner and a message.
  const live = await connectAgent(agentSecret, auth);
  await live.publish(0, [auth], JSON.stringify({ name }));
  const toOwner = nip44.v2.utils.getConversationKey(agentSecret, viewer);
  const mac = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(toOwner),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const address = async (slug: string) =>
    Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        mac,
        new TextEncoder().encode(`agent-memory/v1/d-tag\0${slug}`),
      ),
    ).toString("hex");
  await live.publish(
    30174,
    [
      ["d", await address("mem/leads")],
      ["p", viewer],
    ],
    nip44.v2.encrypt(
      JSON.stringify({ slug: "mem/leads", value: `Call Ada ${run}` }),
      toOwner,
    ),
  );
  await live.publish(9, [["h", channel ?? ""]], `hello from ${name}`);

  // Memory and Activity for the paired agent.
  await owner.getByRole("tab", { name: "Memory" }).click();
  await owner.getByRole("button", { name: "mem/leads" }).click();
  await expect(owner.getByText(`Call Ada ${run}`)).toBeVisible();
  await owner.getByRole("tab", { name: "Activity" }).click();
  const frame = (kind: string, payload: object) => ({
    kind,
    timestamp: new Date().toISOString(),
    channelId: channel,
    turnId: `turn-${run}`,
    payload,
  });
  await expect(async () => {
    await live.publish(
      24200,
      [
        ["p", viewer],
        ["agent", agent],
        ["frame", "telemetry"],
      ],
      nip44.v2.encrypt(
        JSON.stringify({
          kind: "batch",
          payload: {
            events: [
              frame("turn_started", { source: "channel" }),
              frame("acp_read", {
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `Thinking about ${run}` },
                  },
                },
              }),
            ],
          },
        }),
        toOwner,
      ),
    );
    await expect(owner.getByText(`Thinking about ${run}`)).toBeVisible({
      timeout: 3000,
    });
  }).toPass();

  // Its message reads as the owner's agent.
  await owner.getByRole("tab", { name: "Messages" }).click();
  await owner
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("button", { name: `orb-${run}` })
    .click();
  await expect(owner.getByText(`hello from ${name}`)).toBeVisible();
  await owner.getByRole("button", { name: `View ${name} profile` }).click();
  await expect(owner.getByRole("tab", { name: "Memory" })).toBeVisible();
  live.close();
});
