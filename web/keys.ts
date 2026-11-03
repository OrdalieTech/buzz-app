import { schnorr } from "@noble/curves/secp256k1.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  type EventTemplate,
} from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { validateMemberAdministrationTemplate } from "../src/features/channel-members/administration-protocol.ts";
import { validateDetailsTemplate } from "../src/features/relay/channel-details-protocol.ts";
import { validChannelLabel } from "../src/features/relay/channel-labels.ts";
import { validateLifecycleTemplate } from "../src/features/relay/channel-lifecycle-protocol.ts";
import { validDirectMessageParticipants } from "../src/features/relay/direct-message-policy.ts";
import { eventDto, type RelayEvent } from "../src/features/relay/events.ts";
import { validateArchiveRequestTemplate } from "../src/features/relay/identity-archive-protocol.ts";
import {
  parseReadBlob,
  READ_STATE_PLAINTEXT_BYTES,
  readCoordinate,
  record,
  slotId,
  uint32,
} from "../src/features/relay/read-state-model.ts";
import { projectSidebarPreferences } from "../src/features/relay/sidebar-preferences.ts";
import { validTypingTemplate } from "../src/features/relay/typing-protocol.ts";
import { validateWorkflowEvent } from "../src/features/workflows/protocol.ts";
import { heldKey } from "./key-setup.ts";
import * as vault from "./vault.ts";

// The browser host's key boundary, run in a dedicated Worker. Each command
// mirrors the native one in src-tauri/src (identity.rs, relay.rs,
// relay/channel_writes.rs) with its shape checks; there is no generic signer
// or decrypt. Errors are strings, as Tauri commands reject.

// biome-ignore lint/suspicious/noExplicitAny: IPC arguments are untrusted JSON, checked below.
type Args = Record<string, any>;
type RelayResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const KIB = 1024;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVALID_KEY = "Enter a valid nsec private key";
const encoder = new TextEncoder();
const size = (value: unknown) =>
  encoder.encode(typeof value === "string" ? value : JSON.stringify(value))
    .length;
const now = () => Math.floor(Date.now() / 1000);

/** Hosts this build may reach, from VITE_BUZZ_COMMUNITIES. */
const communities = new Set(
  String(import.meta.env.VITE_BUZZ_COMMUNITIES ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

/** Rust `origin`, restricted to this build's communities. */
function origin(community: unknown) {
  const url =
    typeof community === "string" &&
    community.length <= 2048 &&
    URL.canParse(community)
      ? new URL(community)
      : undefined;
  if (url?.protocol !== "https:" || url.origin !== community)
    throw "Relay access requires an HTTPS origin without credentials or a path";
  if (!communities.has(url.host))
    throw "This community isn't available in this app.";
  return url;
}

const routes: Record<string, string[]> = {
  GET: ["/", "/api/join-policy"],
  POST: [
    "/query",
    "/events",
    "/api/invites",
    "/api/invites/claim",
    "/api/invites/accept-policy",
    "/gifs/search",
    "/profiles/search",
  ],
};
function requestUrl(community: unknown, path: string, method: string) {
  if (!routes[method]?.includes(path)) throw "Unsupported relay request";
  return new URL(path, origin(community));
}

// Identity: create-only, never generated or replaced behind the user's back.
let key: Uint8Array | null | undefined;
let closed = false;
async function restore() {
  if (closed) throw "Buzz is signing out";
  key ??= await vault.load().catch(() => {
    throw "Saved identity is malformed; nothing was changed. Keep your key backup before clearing this site's data.";
  });
  return key && getPublicKey(key);
}
async function secret() {
  await restore();
  if (!key) throw "Set up your identity first";
  return key;
}
async function save(next: Uint8Array) {
  if (await restore()) throw vault.SAVED;
  await vault.save(next);
  key = next;
  return getPublicKey(next);
}
function parseNsec(text: unknown) {
  const value = typeof text === "string" ? text.trim() : "";
  if (value.length !== 63 || !/^nsec1/i.test(value)) throw INVALID_KEY;
  try {
    const decoded = nip19.decode(value.toLowerCase());
    if (decoded.type !== "nsec") throw INVALID_KEY;
    getPublicKey(decoded.data);
    return decoded.data;
  } catch {
    throw INVALID_KEY;
  }
}

function template(raw: unknown, error: string): EventTemplate {
  const { kind, created_at, tags, content } = (raw ?? {}) as EventTemplate;
  if (
    !Number.isInteger(kind) ||
    kind < 0 ||
    kind > 65535 ||
    !Number.isSafeInteger(created_at) ||
    created_at < 0 ||
    typeof content !== "string" ||
    !Array.isArray(tags) ||
    !tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((value) => typeof value === "string"),
    )
  )
    throw error;
  return { kind, created_at, tags, content };
}
/** Rust `Key::sign_bounded`: the commitment's size is bounded before signing. */
function sign(event: EventTemplate, secret: Uint8Array, limit = 64 * KIB) {
  const { kind, created_at, tags, content } = event;
  if (size([0, getPublicKey(secret), created_at, kind, tags, content]) > limit)
    throw "Relay event is too large";
  return finalizeEvent(event, secret);
}
/** A signed event of this viewer's, with a valid signature. */
async function owned(raw: unknown, error: string) {
  let event: RelayEvent;
  try {
    event = eventDto(raw);
  } catch {
    throw error;
  }
  if (event.pubkey !== getPublicKey(await secret())) throw error;
  return event;
}

const pair = (tag: string[] | undefined, name: string) =>
  tag?.length === 2 && tag[0] === name ? tag[1] : undefined;
const positive = (value: string | undefined) =>
  !!value && /^[1-9][0-9]*$/.test(value) && Number(value) <= 2 ** 31 - 1;

/** Rust `valid_message_deletion`. */
function messageDeletion({ content, tags }: EventTemplate) {
  if (
    content ||
    tags.length > 106 ||
    tags.some(
      (tag) =>
        tag.length !== 2 ||
        !["h", "e", "k", "client-id"].includes(tag[0] ?? ""),
    )
  )
    return false;
  const values = (name: string) =>
    tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? "");
  const [channel, ...others] = values("h");
  const targets = values("e");
  const kinds = values("k");
  return (
    !!channel &&
    !others.length &&
    channel.length <= 256 &&
    targets.length >= 1 &&
    targets.length <= 100 &&
    targets.every((id) => HEX.test(id)) &&
    new Set(targets).size === targets.length &&
    kinds.length >= 1 &&
    kinds.length <= 3 &&
    kinds.every((kind) => ["7", "9", "40002"].includes(kind))
  );
}
/** Rust `channel_writes::creation` (kind 9007). */
function creation({ content, tags }: EventTemplate) {
  if (content || tags.length < 4 || tags.length > 47) return false;
  const id = pair(tags[0], "h");
  const name = pair(tags[1], "name");
  if (
    !id ||
    !UUID.test(id) ||
    !name?.trim() ||
    [...name].length > 120 ||
    !["open", "private"].includes(pair(tags[2], "visibility") ?? "") ||
    !["stream", "system"].includes(pair(tags[3], "channel_type") ?? "")
  )
    return false;
  let index = 4;
  if (tags[index]?.[0] === "about") {
    const about = pair(tags[index++], "about");
    if (about === undefined || [...about].length > 1000) return false;
  }
  if (tags[index]?.[0] === "ttl" && !positive(pair(tags[index++], "ttl")))
    return false;
  const distinct = (
    name: string,
    max: number,
    valid: (value: string) => boolean,
  ) => {
    const seen = new Set<string>();
    for (; tags[index]?.[0] === name; index++) {
      const value = pair(tags[index], name);
      if (value === undefined || seen.size >= max || !valid(value))
        return false;
      if (seen.has(value)) return false;
      seen.add(value);
    }
    return true;
  };
  if (
    !distinct("t", 8, validChannelLabel) ||
    !distinct("p", 32, (value) => HEX.test(value))
  )
    return false;
  if (
    tags[index]?.[0] === "client-id" &&
    !UUID.test(pair(tags[index++], "client-id") ?? "")
  )
    return false;
  return index === tags.length;
}
/** Rust `valid_canvas` (kind 40100). */
function canvas({ content, tags }: EventTemplate) {
  const count = (name: string) => tags.filter((tag) => tag[0] === name).length;
  return (
    size(content) <= 24 * KIB &&
    count("h") === 1 &&
    count("expected-revision") <= 1 &&
    tags.every(([name, value, ...rest]) => {
      if (value === undefined || rest.length) return false;
      if (name === "h") return UUID.test(value);
      if (name === "client-id") return value.length <= 128;
      if (name === "expected-revision")
        return value === "none" || HEX.test(value);
      return false;
    })
  );
}
/** Rust `valid_member_command` (NIP-43 kinds 9030-9032). */
function memberCommand({ kind, content, tags }: EventTemplate) {
  const target = HEX.test(pair(tags[0], "p") ?? "");
  const role = ["admin", "member"].includes(pair(tags[1], "role") ?? "");
  return (
    !content &&
    (kind === 9031
      ? tags.length === 1 && target
      : tags.length === 2 && target && role)
  );
}
/** Kinds the native `relay_sign` admits without a dedicated shape. */
const PLAIN = new Set([
  0, 7, 9, 1984, 9000, 9001, 20001, 30030, 30315, 40003, 42000,
]);
const SHAPES: Record<number, [(event: EventTemplate) => boolean, string]> = {
  9007: [
    creation,
    "Agent enrollment or channel operation unavailable or invalid",
  ],
  40100: [canvas, "Malformed Canvas save"],
  28936: [
    ({ content, tags }) => !content && JSON.stringify(tags) === '[["-"]]',
    "A leave request carries no content or other tags",
  ],
  20002: [validTypingTemplate, "Invalid typing indicator"],
  9030: [memberCommand, "Invalid member change"],
  9031: [memberCommand, "Invalid member change"],
  9032: [memberCommand, "Invalid member change"],
};

/** Rust `validate_event`. Agent-only kinds (catalogs, agent records and
 * presence, config artifacts) wait for agents in the browser. */
function validateEvent(
  community: unknown,
  event: EventTemplate,
  viewer: string,
) {
  const relay = origin(community);
  const { kind, content, tags } = event;
  if (kind === 22242) {
    relay.protocol = "wss:";
    const relays = tags.filter((tag) => tag[0] === "relay");
    const challenges = tags.filter((tag) => tag[0] === "challenge");
    const tagged = pair(relays[0], "relay") ?? "";
    const challenge = pair(challenges[0], "challenge");
    if (
      content ||
      tags.length !== 2 ||
      relays.length !== 1 ||
      !URL.canParse(tagged) ||
      new URL(tagged).href !== relay.href ||
      challenges.length !== 1 ||
      !challenge ||
      challenge.length > 4096
    )
      throw "Relay authentication does not match this community";
    return;
  }
  if (kind === 5 && messageDeletion(event)) return;
  if (kind === 5 || kind === 30620 || kind === 46020) {
    validateWorkflowEvent({ ...event, id: "", pubkey: viewer }, viewer);
    return;
  }
  const shape = SHAPES[kind];
  if (shape ? !shape[0](event) : !PLAIN.has(kind))
    throw shape?.[1] ?? "This event is not supported in the browser yet";
}

/** NIP-98 for exactly this request, built here so no caller can mint tokens. */
async function send(
  url: URL,
  method: string,
  body?: string,
  signal?: AbortSignal,
): Promise<RelayResponse> {
  const headers: Record<string, string> = {};
  if (method === "POST") {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(body ?? ""),
    );
    const payload = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const auth = sign(
      {
        kind: 27235,
        created_at: now(),
        content: "",
        tags: [
          ["u", url.href],
          ["method", method],
          ["payload", payload],
          ["nonce", crypto.randomUUID()],
        ],
      },
      await secret(),
    );
    headers.Authorization = `Nostr ${btoa(JSON.stringify(auth))}`;
    headers["Content-Type"] = "application/json";
  } else headers.Accept = "application/nostr+json";
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ?? null,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: signal ?? null,
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  } catch {
    // Native's cancelled-read answer (relay.rs CANCELLED_READ).
    if (signal?.aborted) return { status: 499, headers: {}, body: "" };
    throw "Relay request could not be confirmed";
  }
}

const parse = (text: unknown) => {
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
};

const reads = new Map<string, AbortController>();

function conversation(secret: Uint8Array) {
  return nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
}

/** Rust `decode_read_state`: verified, self-authored NIP-RS slots only. */
async function decodeReadState(events: unknown) {
  const invalid = "Invalid read-state event";
  if (!Array.isArray(events) || events.length > 16 || size(events) > 512 * KIB)
    throw "Read-state decode capacity exceeded";
  const owner = await secret();
  const key = conversation(owner);
  const decoded = [];
  for (const raw of events) {
    if (size(raw) > 96 * KIB) throw invalid;
    const event = await owned(raw, invalid);
    if (!readCoordinate(event)) throw invalid;
    let blob: unknown;
    try {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (size(plaintext) > 128 * KIB)
        throw "Read-state plaintext capacity exceeded";
      blob = JSON.parse(plaintext);
      parseReadBlob(blob);
    } catch (error) {
      throw typeof error === "string" ? error : invalid;
    }
    decoded.push({ eventId: event.id, blob });
  }
  return decoded;
}

const SIDEBAR = [
  "channel-sections",
  "channel-stars",
  "channel-mutes",
  "channel-sort",
  "channel-filter",
  "main-agent",
];
/** Rust `decode_sidebar`: verified, self-authored sidebar coordinates only. */
async function decodeSidebar(events: unknown) {
  const invalid = "Invalid sidebar record";
  if (!Array.isArray(events) || events.length > 5 || size(events) > 960 * KIB)
    throw "Invalid sidebar records";
  const key = conversation(await secret());
  const decoded: Record<string, unknown> = {};
  for (const raw of events) {
    const event = await owned(raw, invalid);
    const ds = event.tags.filter((tag) => tag[0] === "d");
    const coordinate = ds[0]?.[1] ?? "";
    if (
      event.kind !== 30078 ||
      ds.length !== 1 ||
      !SIDEBAR.includes(coordinate) ||
      Object.hasOwn(decoded, coordinate)
    )
      throw invalid;
    try {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (size(plaintext) > 128 * KIB)
        throw "Sidebar plaintext budget exceeded";
      decoded[coordinate] = JSON.parse(plaintext);
    } catch (error) {
      throw typeof error === "string" ? error : invalid;
    }
  }
  return decoded;
}
/** Rust `validate_sidebar_payload`, through the shared projection. */
function validateSidebarPayload(coordinate: string, payload: unknown) {
  if (coordinate === "main-agent") {
    const { version, agent, ...rest } = (payload ?? {}) as Args;
    if (version === 1 && HEX.test(agent) && !Object.keys(rest).length) return;
    throw "Invalid sidebar payload";
  }
  const at = SIDEBAR.indexOf(coordinate);
  if (at < 0) throw "Invalid sidebar coordinate";
  try {
    const slots: unknown[] = [undefined, undefined, undefined, undefined];
    slots[at] = payload;
    const [sections, stars, mutes, sort] = slots;
    projectSidebarPreferences(
      sections,
      stars,
      mutes,
      sort,
      undefined,
      at === 4 ? payload : undefined,
    );
  } catch {
    throw "Invalid sidebar payload";
  }
}
/** Rust `admit_sidebar`: only a record shaped like `relay_sign_sidebar` output. */
async function admitSidebar(event: unknown) {
  const [entry] = Object.entries(await decodeSidebar([event]));
  const [coordinate, payload] = entry ?? [];
  if (
    !coordinate ||
    JSON.stringify((event as RelayEvent).tags) !==
      JSON.stringify([
        ["d", coordinate],
        ["t", coordinate],
      ])
  )
    throw "Invalid sidebar record";
  validateSidebarPayload(coordinate, payload);
}

const channelRoutes: Record<
  string,
  (event: EventTemplate, viewer: string) => void
> = {
  "channel-details": validateDetailsTemplate,
  "channel-lifecycle": validateLifecycleTemplate,
  "identity-archive": validateArchiveRequestTemplate,
  "member-administration": validateMemberAdministrationTemplate,
};
async function channelCommand(route: unknown, raw: unknown, signed: boolean) {
  const invalid = "Invalid channel lifecycle command";
  const validate = typeof route === "string" ? channelRoutes[route] : undefined;
  if (!validate) throw invalid;
  const viewer = getPublicKey(await secret());
  const event = signed ? await owned(raw, invalid) : template(raw, invalid);
  try {
    validate(event, viewer);
  } catch {
    throw invalid;
  }
  return event;
}

export const keyCommands: Record<string, (args: Args) => unknown> = {
  identity_restore: restore,
  identity_create: () => save(generateSecretKey()),
  // An npub names a key first run holds unsaved (key-setup.ts).
  identity_import: ({ nsec }) => save(heldKey(nsec) ?? parseNsec(nsec)),
  identity_export: async () => nip19.nsecEncode(await secret()),
  identity_legacy_available: async () => !!(await vault.legacyRecord()),
  async identity_import_legacy() {
    if (await restore()) throw vault.SAVED;
    const legacy = await vault.loadLegacy().catch(() => null);
    if (!legacy)
      throw "The earlier Buzz app's identity is malformed; nothing was changed";
    return save(legacy);
  },
  /** Communities our previous PWA saved (its `buzz-communities` list), for
   * the identity its vault holds and only those this build may reach. */
  async legacy_communities({ saved }) {
    const pubkey = (await vault.legacyRecord())?.pubkey;
    const list = parse(saved);
    if (!pubkey || !Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      const relayUrl = entry?.relayUrl;
      return typeof relayUrl === "string" &&
        URL.canParse(relayUrl) &&
        communities.has(new URL(relayUrl).host)
        ? [{ relayUrl, pubkey }]
        : [];
    });
  },
  async sign_out() {
    closed = true;
    key = null;
    await vault.remove();
  },
  async relay_sign({ community, event }) {
    const owner = await secret();
    const parsed = template(event, "Invalid relay event");
    validateEvent(community, parsed, getPublicKey(owner));
    return sign(parsed, owner);
  },
  async relay_http({ community, path, method, body, id }) {
    const url = requestUrl(community, path, method);
    if (
      (body !== null && typeof body !== "string") ||
      size(body ?? "") > 1024 * KIB ||
      (method === "GET") !== (body === null)
    )
      throw "Invalid relay request body";
    if (path === "/events") {
      let event: Args;
      try {
        event = JSON.parse(body);
      } catch {
        throw "Invalid relay request body";
      }
      const kind = event?.kind;
      if (kind === 41010) throw "Choose between one and eight other people.";
      if (kind === 30078) await admitSidebar(event);
      if (kind === 30300)
        throw "Reminders aren't available in the browser yet.";
      if (kind === 9007) {
        const invalid =
          "Agent enrollment or channel operation unavailable or invalid";
        if (!creation(await owned(event, invalid))) throw invalid;
      }
      if ([9002, 9008, 9021, 9022, 41012, 9035, 9036].includes(kind))
        throw "Invalid outgoing signature";
    }
    if (id === undefined) return send(url, method, body ?? undefined);
    if (
      typeof id !== "string" ||
      !UUID.test(id) ||
      !["/query", "/profiles/search", "/gifs/search"].includes(path)
    )
      throw "Relay writes cannot be cancelled";
    const controller = new AbortController();
    reads.set(id, controller);
    try {
      return await send(url, method, body, controller.signal);
    } finally {
      reads.delete(id);
    }
  },
  relay_http_cancel({ id }) {
    reads.get(id)?.abort();
  },
  relay_verify_signatures({ claims }) {
    if (!Array.isArray(claims)) throw "Invalid signature claims";
    return claims.map((claim) => {
      try {
        return schnorr.verify(
          hexToBytes(claim.sig),
          hexToBytes(claim.id),
          hexToBytes(claim.pubkey),
        );
      } catch {
        return false;
      }
    });
  },
  async relay_channel_sign({ community, route, event }) {
    origin(community);
    return sign(await channelCommand(route, event, false), await secret());
  },
  async relay_channel_publish({ community, route, event }) {
    const url = requestUrl(community, "/events", "POST");
    const body = JSON.stringify(await channelCommand(route, event, true));
    if (size(body) > 1024 * KIB) throw "Invalid relay request body";
    return send(url, "POST", body);
  },
  async relay_direct_message({ community, pubkeys }) {
    const url = requestUrl(community, "/events", "POST");
    const owner = await secret();
    if (
      !Array.isArray(pubkeys) ||
      !pubkeys.every((value) => typeof value === "string") ||
      !validDirectMessageParticipants(pubkeys, getPublicKey(owner))
    )
      throw "Choose between one and eight other people.";
    const event = sign(
      {
        kind: 41010,
        created_at: now(),
        content: "",
        tags: [
          ...pubkeys.map((pubkey) => ["p", pubkey]),
          ["client", crypto.randomUUID()],
        ],
      },
      owner,
    );
    const response = await send(url, "POST", JSON.stringify(event));
    const receipt = parse(response.body);
    const message = receipt?.message;
    if (
      response.status !== 200 ||
      receipt?.event_id !== event.id ||
      receipt.accepted !== true ||
      typeof message !== "string" ||
      !message.startsWith("response:")
    )
      throw "The direct message could not be opened. Try again.";
    const channel = parse(message.slice(9))?.channel_id;
    if (typeof channel !== "string" || !UUID.test(channel))
      throw "The relay returned an invalid direct message.";
    return channel;
  },
  relay_decode_read_state({ community, events }) {
    origin(community);
    return decodeReadState(events);
  },
  async relay_sign_read_state({ community, intent }) {
    origin(community);
    const owner = await secret();
    if (
      !record(intent) ||
      !slotId(intent.slot) ||
      !uint32(intent.createdAt) ||
      Math.abs(intent.createdAt - now()) > 60
    )
      throw "Invalid read-state signing intent";
    try {
      parseReadBlob(intent.blob);
    } catch {
      throw "Unsupported read-state blob";
    }
    const plaintext = JSON.stringify(intent.blob);
    if (size(plaintext) > READ_STATE_PLAINTEXT_BYTES)
      throw "Read-state publication capacity exceeded";
    return sign(
      {
        kind: 30078,
        created_at: intent.createdAt,
        content: nip44.v2.encrypt(plaintext, conversation(owner)),
        tags: [
          ["d", `read-state:${intent.slot}`],
          ["t", "read-state"],
        ],
      },
      owner,
    );
  },
  async relay_publish_read_state({ community, event }) {
    const url = requestUrl(community, "/events", "POST");
    const body = JSON.stringify(event);
    if (size(body) > 64 * KIB) throw "Invalid read-state event";
    await decodeReadState([event]);
    return send(url, "POST", body);
  },
  relay_decode_sidebar: ({ events }) => decodeSidebar(events),
  async relay_sign_sidebar({ coordinate, payload, createdAt }) {
    validateSidebarPayload(coordinate, payload);
    const plaintext = JSON.stringify(payload);
    if (size(plaintext) > 128 * KIB) throw "Sidebar plaintext budget exceeded";
    if (!Number.isSafeInteger(createdAt) || createdAt < 0)
      throw "Invalid sidebar payload";
    const owner = await secret();
    return sign(
      {
        kind: 30078,
        created_at: createdAt,
        content: nip44.v2.encrypt(plaintext, conversation(owner)),
        tags: [
          ["d", coordinate],
          ["t", coordinate],
        ],
      },
      owner,
      192 * KIB,
    );
  },
};
