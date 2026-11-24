// What an agent shares to its community's catalog (NIP-AP kind 30175) and
// exports as a buzz-agent-snapshot v1 file, the format block/buzz writes. Both
// are built from an explicit allowlist: no key, workspace, environment or
// memory crosses this boundary.
import { avatarSource } from "../../shared/avatar-source";
import { cleanPng, pngChunks } from "../messages/image-metadata";
import { newer, type EventData } from "../relay/events";
import type { RelaySession } from "../relay/session";
import { AGENT_CATALOG_KIND, object } from "./catalog-envelope";
import { delivered } from "./relay-removal";
import { sharedModel, sharedRoute } from "./synced-route";
import type { Agent, RegisteredAgentType } from "./service";
import type { SharedAgent } from "./shared-agents";

/** A shared agent apart from who shared it. */
export type SharedDefinition = Omit<SharedAgent, "id" | "owner">;

const MAX_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_PNG_BYTES = 10 * 1024 * 1024;
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const KEYWORD = new TextEncoder().encode("buzz_agent_snapshot\0");
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Heuristic only; free text can still hold what it misses. */
const credentialLike = (value: string) =>
  /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|nsec1[02-9ac-hj-np-z]{58}|gh[pousr]_[A-Za-z0-9]{36,}|(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?[^\s,;"']{8,})/i.test(
    value,
  );

// What block/buzz `validate_agent_definition_text` admits: what a person
// reviews is what the agent receives, so text without a visible glyph is
// refused, apart from the joiners and selectors that compose an emoji. These
// are the Unicode Default_Ignorable_Code_Point ranges.
const IGNORABLE: [number, number][] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
const ignorable = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return IGNORABLE.some(([from, to]) => code >= from && code <= to);
};
const pictographic = (char = "") => /^\p{Extended_Pictographic}$/u.test(char);
const modifier = (char = "") => /^[\u{1F3FB}-\u{1F3FF}]$/u.test(char);

function visible(value: string, label: string, layout: boolean) {
  const chars = Array.from(value);
  chars.forEach((char, index) => {
    // A joiner follows an emoji, past its selectors and skin tones.
    let base = index - 1;
    if (char === "\u200D")
      while (chars[base] === "\uFE0F" || modifier(chars[base])) base--;
    const emoji =
      char === "\uFE0F"
        ? /^[#*0-9]$/.test(chars[index - 1] ?? "") ||
          pictographic(chars[index - 1])
        : char === "\u200D" &&
          pictographic(chars[base]) &&
          pictographic(chars[index + 1]);
    if (
      (/\p{Cc}/u.test(char) && !(layout && (char === "\n" || char === "\t"))) ||
      (ignorable(char) && !emoji)
    )
      throw new Error(
        `${label} contains prohibited invisible or formatting character U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`,
      );
  });
}

/** Refuses a name or instructions block/buzz would refuse. */
export function checkText(name: string, instructions: string) {
  const chars = Array.from(name).length;
  if (chars > 128)
    throw new Error(`Display name is too long (${chars} characters, max 128)`);
  const bytes = new TextEncoder().encode(instructions).length;
  if (bytes > 64 * 1024)
    throw new Error(
      `Agent instructions are too long (${bytes} bytes, max ${64 * 1024})`,
    );
  visible(name, "Display name", false);
  visible(instructions, "Agent instructions", true);
}

const https = (value: unknown) => {
  const picture = avatarSource(value);
  return picture?.startsWith("https:") ? picture : undefined;
};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** What sharing or exporting `agent` publishes. */
export function shareable(
  agent: Agent,
  type: RegisteredAgentType | undefined,
): SharedDefinition {
  // Its synced settings and instructions are left out of `config` then.
  if (agent.configProblem) throw new Error(agent.configProblem);
  const shared = type?.exportShared?.(agent.config);
  if (!type || !shared)
    throw new Error(
      `Agent '${agent.name}' uses a runtime that cannot be shared with the community catalog.`,
    );
  const instructions = type.carry?.(agent.config).instructions ?? "";
  checkText(agent.name, instructions);
  // A query or fragment can carry a token, so such a picture stays behind
  // whole, as in earlier Buzz, rather than cut into a broken URL.
  const source = https(agent.picture);
  const picture = source && !/[?#]/.test(source) ? source : undefined;
  const definition = {
    name: agent.name,
    ...(picture && { picture }),
    model: shared.model.trim(),
    runtime: shared.runtime,
    ...(shared.provider?.trim() && { provider: shared.provider.trim() }),
    instructions,
  };
  if (
    [
      definition.name,
      instructions,
      definition.model,
      shared.provider ?? "",
      picture ?? "",
    ]
      .filter(Boolean)
      .some(credentialLike)
  )
    throw new Error(
      "Portable configuration appears to contain a credential. Remove it before sharing or exporting.",
    );
  return definition;
}

/** A kind 30175 body, in NIP-AP field order. Agents here run on stock
 * transport, which a shared head names. */
export function catalogContent(definition: SharedDefinition): string {
  const { name, picture, instructions, runtime, provider } = definition;
  // A route goes in `model_route`, so an older reader runs its default.
  const { model, route } = sharedRoute(definition.model);
  return JSON.stringify({
    display_name: name,
    system_prompt: instructions,
    acp_command: "buzz-acp",
    ...(picture && { avatar_url: picture }),
    runtime,
    ...(model && { model }),
    ...(route && { model_route: route }),
    ...(provider && { provider }),
  });
}

/** The owner's newest catalog head for the agent, which is addressed by its
 * pubkey. The relay shows an author their own unshared heads. */
export async function catalogHead(
  session: Pick<RelaySession, "read">,
  owner: string,
  pubkey: string,
  signal: AbortSignal,
): Promise<EventData | undefined> {
  const events = await session.read(
    [
      {
        kinds: [AGENT_CATALOG_KIND],
        authors: [owner],
        "#d": [pubkey],
        limit: 10,
        consistency: "strong",
      },
    ],
    { signal, fresh: true },
  );
  return events
    .filter((event) => event.pubkey === owner)
    .reduce<EventData | undefined>(newer, undefined);
}

export const isShared = (head: EventData | undefined) =>
  !!head?.tags.some(([name, value]) => name === "shared" && value === "true");

/** Replaces `head` with `content`, shared or not, and settles with the new head
 * once the relay accepts it. Unshared, the relay keeps it from everyone but its
 * author. */
export async function publishShare(
  session: Pick<RelaySession, "outbox">,
  pubkey: string,
  content: string,
  shared: boolean,
  head: EventData | undefined,
  signal: AbortSignal,
): Promise<EventData> {
  const outbox = session.outbox;
  if (!outbox?.supports(AGENT_CATALOG_KIND))
    throw new Error("This community cannot update catalog sharing.");
  await outbox.ready();
  signal.throwIfAborted();
  const id = outbox.send(
    {
      kind: AGENT_CATALOG_KIND,
      content,
      tags: [["d", pubkey], ...(shared ? [["shared", "true"]] : [])],
      ...(head && { supersedes: head.created_at }),
    },
    undefined,
    () => !signal.aborted,
  );
  const sent = outbox.snapshot().find((item) => item.event.id === id)?.event;
  if (!sent) throw new Error("Try again.");
  await delivered(outbox, id, signal, "Try again.");
  await outbox.dismiss(id);
  return sent;
}

/** Takes a deleted agent's catalog share down: a shared head is replaced
 * by its content without the tag, which supersedes it whatever its clock, and
 * this settles once a fresh read no longer finds it shared. */
export async function unshare(
  session: Pick<RelaySession, "read" | "outbox">,
  owner: string,
  pubkey: string,
  signal: AbortSignal,
) {
  const head = await catalogHead(session, owner, pubkey, signal);
  if (!head || !isShared(head)) return;
  await publishShare(session, pubkey, head.content, false, head, signal);
  if (isShared(await catalogHead(session, owner, pubkey, signal)))
    throw new Error("Its catalog share is still listed. Try again.");
}

/** A buzz-agent-snapshot v1 `.agent.json` without memory. */
export function snapshotJson(definition: SharedDefinition): string {
  const { name, picture, instructions, runtime, provider } = definition;
  const { model, route } = sharedRoute(definition.model);
  return JSON.stringify(
    {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: {
        name,
        ...(instructions && { systemPrompt: instructions }),
        runtime,
        ...(model && { model }),
        ...(route && { modelRoute: route }),
        ...(provider && { provider }),
      },
      profile: { displayName: name, ...(picture && { avatarUrl: picture }) },
      memory: { level: "none", entries: [] },
    },
    null,
    2,
  );
}

/** A transparent 1×1 PNG, the artwork of a snapshot without a picture. */
const BLANK =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const bytesOf = (binary: string) =>
  Uint8Array.from(binary, (char) => char.charCodeAt(0));

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** A buzz-agent-snapshot v1 `.agent.png`: `artwork`, a PNG, with the manifest
 * in a `buzz_agent_snapshot` tEXt chunk and none of the artwork's metadata. */
export function snapshotPng(
  definition: SharedDefinition,
  artwork = bytesOf(atob(BLANK)),
): Blob {
  const manifest = new TextEncoder().encode(snapshotJson(definition));
  const base64 = btoa(
    Array.from(manifest, (byte) => String.fromCharCode(byte)).join(""),
  );
  // Length, type and data, then the CRC of the type and data.
  const typed = new TextEncoder().encode(`tEXtbuzz_agent_snapshot\0${base64}`);
  const chunk = new Uint8Array(typed.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, typed.length - 4);
  chunk.set(typed, 4);
  view.setUint32(typed.length + 4, crc32(typed));
  const png = cleanPng(artwork, chunk);
  if (png.size > MAX_PNG_BYTES)
    throw new Error("Snapshot exceeds the size limit.");
  return png;
}

/** The base64 manifest in a snapshot PNG's `buzz_agent_snapshot` tEXt chunk. */
function pngManifest(bytes: Uint8Array): Uint8Array {
  let chunks: ReturnType<typeof pngChunks>;
  try {
    chunks = pngChunks(bytes);
  } catch {
    throw new Error("Invalid PNG snapshot.");
  }
  const chunk = chunks.find(
    ({ kind, payload }) =>
      kind === "tEXt" && KEYWORD.every((byte, i) => payload[i] === byte),
  );
  if (!chunk)
    throw new Error("PNG does not contain a buzz_agent_snapshot tEXt chunk.");
  try {
    const encoded = decoder.decode(chunk.payload.subarray(KEYWORD.length));
    return bytesOf(atob(encoded));
  } catch {
    throw new Error("Invalid PNG snapshot.");
  }
}

/** Reads an `.agent.json` or `.agent.png` snapshot, refusing an oversized one
 * before reading it in. What a Buzz agent has no place for, such as memory or
 * an inline avatar, stays behind. */
export async function readSnapshot(file: Blob): Promise<SharedDefinition> {
  const head = new Uint8Array(await file.slice(0, PNG.length).arrayBuffer());
  const png = PNG.every((byte, i) => head[i] === byte);
  if (file.size > (png ? MAX_PNG_BYTES : MAX_JSON_BYTES))
    throw new Error("Snapshot exceeds the size limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const manifest = png ? pngManifest(bytes) : bytes;
  let snapshot: Record<string, unknown> | undefined;
  try {
    snapshot = object(decoder.decode(manifest));
  } catch {}
  if (!snapshot) throw new Error("Invalid snapshot JSON.");
  if (snapshot.format !== "buzz-agent-snapshot")
    throw new Error("Unsupported snapshot format.");
  if (snapshot.version !== 1) throw new Error("Unsupported snapshot version.");
  const definition = record(snapshot.definition);
  const profile = record(snapshot.profile);
  const name = text(profile.displayName) || text(definition.name);
  if (!name) throw new Error("Display name is required");
  const picture = https(profile.avatarUrl);
  const runtime = text(definition.runtime);
  const provider = text(definition.provider);
  const instructions =
    typeof definition.systemPrompt === "string" ? definition.systemPrompt : "";
  checkText(name, instructions);
  return {
    name,
    ...(picture && { picture }),
    model: sharedModel(text(definition.model), definition.modelRoute),
    ...(runtime && { runtime }),
    ...(provider && { provider }),
    instructions,
  };
}
