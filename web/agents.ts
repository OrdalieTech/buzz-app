import { getPublicKey, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { memorySlug } from "../src/features/agents/memory.ts";
import {
  OBSERVER_KIND,
  observerFrame,
} from "../src/features/agents/observer.ts";
import { eventDto, type RelayEvent } from "../src/features/relay/events.ts";

// What an owner reads from its remote agents, decoded in the key Worker:
// browser-host/agent-observer.mjs and agent-memory.mjs made browser-safe, with
// the envelope caps of src-tauri/src/relay/agent.rs. Errors are strings.

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const now = () => Math.floor(Date.now() / 1000);
const conversation = (secret: Uint8Array, agent: string) =>
  nip44.v2.utils.getConversationKey(secret, agent);

/** Rust `verified` plus one exact `name` tag check. */
function envelope(raw: unknown, error: string) {
  let event: RelayEvent;
  try {
    event = eventDto(raw);
  } catch {
    throw error;
  }
  if (
    event.content.length > 87472 ||
    event.tags.length > 64 ||
    event.tags.some(
      (tag) => tag.length > 16 || tag.some((v) => bytes(v) > 4096),
    )
  )
    throw error;
  const exact = (name: string, value: string) => {
    const tags = event.tags.filter((tag) => tag[0] === name);
    return tags.length === 1 && tags[0]?.length === 2 && tags[0][1] === value;
  };
  return { event, exact };
}

/** Rust `decode_observer_with_key`: one live telemetry frame to its owner. */
export function decodeObserver(raw: unknown, secret: Uint8Array) {
  const invalid = "Invalid observer envelope";
  const { event, exact } = envelope(raw, invalid);
  if (
    event.kind !== OBSERVER_KIND ||
    !exact("p", getPublicKey(secret)) ||
    !exact("agent", event.pubkey) ||
    !exact("frame", "telemetry") ||
    event.created_at > now() + 300 ||
    now() - event.created_at > 300 ||
    event.content.length < 132
  )
    throw invalid;
  try {
    return observerFrame({
      id: event.id,
      agent: event.pubkey,
      createdAt: event.created_at,
      plaintext: nip44.v2.decrypt(
        event.content,
        conversation(secret, event.pubkey),
      ),
    });
  } catch {
    throw "Invalid observer frame";
  }
}

/** The HMAC key of an agent's memory addresses (`d` tags). */
export function memoryKey(secret: Uint8Array, agent: string) {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(conversation(secret, agent)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
/** The `d` tag of memory `slug`, so the relay never sees slugs. */
export async function memoryAddress(key: CryptoKey, slug: string) {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`agent-memory/v1/d-tag\0${slug}`),
  );
  return bytesToHex(new Uint8Array(mac));
}

// JSON.parse validates grammar; the token walk also rejects duplicate names at
// any depth, including escaped spellings, as Rust's `Unique` visitor does.
function uniqueJson(text: string) {
  const value = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  tokens.forEach((token, i) => {
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"')) {
      const decoded: string = JSON.parse(token);
      // A lone surrogate, which `String#isWellFormed` would reject.
      if (/\p{Cs}/u.test(decoded)) throw "Invalid memory Unicode";
      if (tokens[i + 1] === ":") {
        const names = stack.at(-1);
        if (!names || names.has(decoded)) throw "Duplicate memory field";
        names.add(decoded);
      }
    }
  });
  return value;
}

type Entry = {
  slug: string;
  body: string | null;
  eventId: string;
  createdAt: number;
};
const MEMORY_TEXT_BYTES = 8 * 1024 * 1024;

/** Rust `decode_memory_events`: verified NIP-AE records of `agent` to this
 * owner, newest per address; a record that fails a check marks it partial. */
export async function decodeMemories(
  events: readonly unknown[],
  secret: Uint8Array,
  agent: string,
) {
  const viewer = getPublicKey(secret);
  const key = conversation(secret, agent);
  const mac = await memoryKey(secret, agent);
  const heads = new Map<string, Entry>();
  let partial = false;
  let total = 0;
  for (const raw of events) {
    let entry: Entry;
    try {
      const { event, exact } = envelope(raw, "Invalid memory envelope");
      const d = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
      if (
        event.kind !== 30174 ||
        event.pubkey !== agent ||
        !exact("d", d) ||
        !exact("p", viewer) ||
        !/^[0-9a-f]{64}$/.test(d)
      )
        throw "Invalid memory envelope";
      const text = nip44.v2.decrypt(event.content, key);
      // Decryption decodes UTF-8 lossily; require an exact round trip with
      // the original nonce before trusting the plaintext.
      const nonce = Uint8Array.from(atob(event.content), (c) =>
        c.charCodeAt(0),
      ).subarray(1, 33);
      if (nip44.v2.encrypt(text, key, nonce) !== event.content)
        throw "Noncanonical memory plaintext";
      const body = uniqueJson(text);
      const slug = body?.slug;
      const value = slug === "core" ? body.profile : body?.value;
      if (
        !memorySlug(slug) ||
        d !== (await memoryAddress(mac, slug)) ||
        (typeof value !== "string" && (slug === "core" || value !== null))
      )
        throw "Invalid memory body";
      entry = {
        slug,
        body: value,
        eventId: event.id,
        createdAt: event.created_at,
      };
    } catch {
      partial = true;
      continue;
    }
    const previous = heads.get(entry.slug);
    if (
      previous &&
      (previous.createdAt > entry.createdAt ||
        (previous.createdAt === entry.createdAt &&
          previous.eventId <= entry.eventId))
    )
      continue;
    total +=
      bytes(JSON.stringify(entry)) -
      (previous ? bytes(JSON.stringify(previous)) : 0);
    if (total > MEMORY_TEXT_BYTES) {
      partial = true;
      break;
    }
    heads.set(entry.slug, entry);
  }
  const all = [...heads.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  // A write that recreates a deleted slug must be dated after its tombstone.
  const deleted = all
    .filter((entry) => entry.body === null)
    .map(({ slug, createdAt }) => ({ slug, createdAt }));
  return {
    entries: all.filter((entry) => entry.body !== null),
    ...(deleted.length ? { deleted } : {}),
    partial,
  };
}
