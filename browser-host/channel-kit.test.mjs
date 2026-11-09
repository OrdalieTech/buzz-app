import { expect, it } from "vitest";
import canvasCases from "../src/features/channel-templates/canvas-signing-contract.json";
import textCases from "../src/features/channel-templates/team-text-admission-contract.json";
import { getPublicKey, nip44 } from "nostr-tools";
import { keypair, signed } from "../src/features/relay/testing.ts";
import {
  coordinate,
  privateCoordinate,
  privateTag,
  KIT_TAG,
  parseKitRecord,
  resolveLineup,
} from "../src/features/channel-templates/model.ts";
import {
  CANVAS_MAX_EVENT_BYTES,
  LIVE_CANVAS_BYTES,
} from "../src/features/channel-templates/canvas-limits.ts";
import {
  canvasEventFits,
  admitChannelKit,
  decodeChannelKit,
  prepareChannelKit,
  validCanvas,
} from "./channel-kit.mjs";

import { TEAM_CHUNK_BYTES } from "../src/features/channel-templates/team-payload.ts";
const community = "https://relay.example.test";
const owner = keypair();
const record = {
  version: 1,
  community,
  deleted: false,
  value: {
    type: "template",
    id: "daily",
    name: "Daily",
    description: "",
    teamIds: [],
    agents: [owner.pubkey],
    canvas: "Private working instructions",
  },
};
function encrypted(value = record, tags) {
  return signed(owner, {
    kind: 30078,
    content: prepareChannelKit(value, owner.secret, community),
    tags: tags ?? [
      ["d", coordinate(value)],
      ["t", KIT_TAG],
    ],
  });
}

it("self-encrypts private recipes and admits only the exact community/coordinate", () => {
  const event = encrypted();
  expect(event.content).not.toContain(record.value.canvas);
  expect(decodeChannelKit([event], owner.secret, community)).toEqual([
    { eventId: event.id, record },
  ]);
  expect(() =>
    admitChannelKit(event, owner.secret, "https://elsewhere.test"),
  ).toThrow();
  expect(() => decodeChannelKit([event], keypair().secret, community)).toThrow(
    /another viewer/,
  );
  expect(() =>
    admitChannelKit(
      { ...event, tags: [...event.tags, ["p", owner.pubkey]] },
      owner.secret,
      community,
    ),
  ).toThrow(/coordinate/);
  expect(() =>
    admitChannelKit(
      {
        ...event,
        tags: [
          ["d", "wrong"],
          ["t", KIT_TAG],
        ],
      },
      owner.secret,
      community,
    ),
  ).toThrow(/coordinate/);
  expect(() =>
    decodeChannelKit(Array(17).fill(event), owner.secret, community),
  ).toThrow(/capacity/);
});

it("rejects malformed/oversized recipes and mismatched ciphertext", () => {
  expect(() =>
    parseKitRecord(
      {
        ...record,
        value: { ...record.value, agents: [owner.pubkey, owner.pubkey] },
      },
      community,
    ),
  ).toThrow(/selection/);
  expect(() =>
    prepareChannelKit(
      { ...record, value: { ...record.value, canvas: "x".repeat(17 * 1024) } },
      owner.secret,
      community,
    ),
  ).toThrow(/16 KiB/);
  expect(() =>
    admitChannelKit(
      { ...encrypted(), content: "broken" },
      owner.secret,
      community,
    ),
  ).toThrow();
  const tombstone = { ...record, deleted: true };
  expect(
    decodeChannelKit([encrypted(tombstone)], owner.secret, community)[0].record
      .deleted,
  ).toBe(true);
});

it("expands multiple teams and individual agents by exact key without namesake collapse", () => {
  const other = keypair().pubkey;
  const entries = ["first", "second"].map((id, i) => ({
    eventId: id,
    createdAt: 1,
    record: {
      ...record,
      value: {
        type: "team",
        id,
        name: id,
        agents: i ? [other] : [owner.pubkey, other],
      },
    },
  }));
  const lineup = {
    teamIds: ["first", "second"],
    agents: [owner.pubkey],
    canvas: "",
  };
  const choices = [owner.pubkey, other].map((pubkey) => ({
    pubkey,
    name: "Namesake",
  }));
  expect(resolveLineup(lineup, entries, choices)).toEqual(choices);
  expect(() => resolveLineup(lineup, [], choices)).toThrow(
    /team is unavailable/,
  );
  expect(() => resolveLineup(lineup, entries, choices.slice(0, 1))).toThrow(
    /unavailable in this community/,
  );
});

it("keeps the shared Canvas signing corpus nonempty", () => {
  expect(canvasCases.length).toBeGreaterThan(0);
});

// Shape only: the broker additionally checks freshness; Rust also deserializes
// EventTemplate and bounds the signed serialization. See contributing.md.
it.each(canvasCases)("Canvas signing shape: $name", ({ accepted, tags }) => {
  expect(validCanvas({ kind: 40100, content: "# Plan", tags })).toBe(accepted);
});

it("bounds Canvas content in UTF-8 bytes, not JavaScript characters", () => {
  const canvas = {
    kind: 40100,
    tags: [["h", "11111111-1111-4111-8111-111111111111"]],
  };
  const content = "é".repeat(LIVE_CANVAS_BYTES / 2);
  expect(validCanvas({ ...canvas, content })).toBe(true);
  expect(validCanvas({ ...canvas, content: `${content}x` })).toBe(false);
});

it("bounds the complete Canvas event separately from its content", () => {
  const event = {
    kind: 40100,
    tags: [["h", "11111111-1111-4111-8111-111111111111"]],
    content: "",
  };
  const room =
    CANVAS_MAX_EVENT_BYTES - Buffer.byteLength(JSON.stringify(event));
  expect(canvasEventFits({ ...event, content: "x".repeat(room) })).toBe(true);
  expect(canvasEventFits({ ...event, content: "x".repeat(room + 1) })).toBe(
    false,
  );
  // Within the content limit, but every quote escapes to two bytes.
  const quotes = { ...event, content: '"'.repeat(LIVE_CANVAS_BYTES) };
  expect(validCanvas(quotes)).toBe(true);
  expect(canvasEventFits(quotes)).toBe(false);
});

it("encrypts manifest and payload records with exact owner/revision admission", async () => {
  const snapshot = {
    format: "buzz-team-snapshot",
    version: 1,
    team: { name: "Portable", instructions: "TEAM".repeat(10000) },
    members: [
      {
        format: "buzz-agent-snapshot",
        version: 1,
        definition: { name: "Agent", systemPrompt: "INDIVIDUAL" },
        profile: { displayName: "Agent" },
        memory: { level: "none", entries: [] },
      },
    ],
  };
  // Chunked as old Buzz saved portable teams.
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const revision = crypto.randomUUID();
  const manifest = {
    version: 1,
    owner: owner.pubkey,
    revision,
    digest: Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
    bytes: bytes.length,
    chunks: Math.ceil(bytes.length / TEAM_CHUNK_BYTES),
  };
  const payloads = Array.from({ length: manifest.chunks }, (_, index) => ({
    version: 1,
    community,
    owner: owner.pubkey,
    teamId: "portable",
    revision,
    index,
    data: btoa(
      String.fromCharCode(
        ...bytes.subarray(
          index * TEAM_CHUNK_BYTES,
          (index + 1) * TEAM_CHUNK_BYTES,
        ),
      ),
    ),
  }));
  const records = [
    {
      version: 2,
      community,
      deleted: false,
      value: {
        type: "team",
        id: "portable",
        name: "Portable",
        agents: [keypair().pubkey],
        portable: manifest,
      },
    },
    ...payloads.map((payload) => ({
      version: 1,
      community,
      deleted: false,
      value: {
        ...payload,
        type: "team-payload",
        id: `${payload.revision}-${payload.index}`,
      },
    })),
  ];
  for (const record of records) {
    const event = signed(owner, {
      kind: 30078,
      content: prepareChannelKit(record, owner.secret, community),
      tags: [
        ["d", privateCoordinate(record)],
        ["t", privateTag(record)],
      ],
    });
    expect(event.content).not.toContain("INDIVIDUAL");
    expect(decodeChannelKit([event], owner.secret, community)).toEqual([
      { eventId: event.id, record },
    ]);
    expect(() =>
      admitChannelKit(
        {
          ...event,
          tags: [
            ["d", privateCoordinate(record)],
            ["t", KIT_TAG],
          ],
        },
        owner.secret,
        community,
      ),
    ).toThrow("coordinate");
  }
  const wrong = structuredClone(records[0]);
  wrong.value.portable.owner = keypair().pubkey;
  const event = signed(owner, {
    kind: 30078,
    content: prepareChannelKit(wrong, owner.secret, community),
    tags: [
      ["d", privateCoordinate(wrong)],
      ["t", privateTag(wrong)],
    ],
  });
  expect(() => admitChannelKit(event, owner.secret, community)).toThrow(
    "another viewer",
  );
});

// The same corpus runs against native admission in `src-tauri/src/relay/kit.rs`.
it.each(textCases)(
  "team-text head admission: $name",
  ({ accepted, record, tags }) => {
    const textCommunity = "https://relay.test";
    const bind = (value) =>
      JSON.parse(JSON.stringify(value).replaceAll("OWNER", owner.pubkey));
    const key = nip44.v2.utils.getConversationKey(
      owner.secret,
      getPublicKey(owner.secret),
    );
    const event = signed(owner, {
      kind: 30078,
      // Encrypted directly so invalid records reach admission.
      content: nip44.v2.encrypt(JSON.stringify(bind(record)), key),
      tags: bind(tags),
    });
    const admit = () => admitChannelKit(event, owner.secret, textCommunity);
    if (accepted) expect(admit()).toEqual(bind(record));
    else expect(admit).toThrow();
  },
);
