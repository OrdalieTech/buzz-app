/// <reference lib="webworker" />
import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import type { RelayEvent } from "../src/features/relay/events.ts";
import {
  EMPTY_READ_STATE,
  effectiveFrontier,
  mergeReadStates,
  overrideActive,
  parseReadBlob,
  readCoordinate,
  type ReadState,
} from "../src/features/relay/read-state-model.ts";
import { threadReference } from "../src/features/relay/thread-reference.ts";
import { load, loadLegacy, run } from "./vault.ts";

// Background notifications, run in the service worker (web/sw.ts). The relay
// keeps a buzz-push-v1 lease (kind 30350) for this browser and, when a
// mention, direct message or reply arrives, wakes it through the Web Push
// gateway at /webpush. The wake carries no content: the worker fetches what
// woke it with the user's key, so no message transits Apple or Google.

declare const self: ServiceWorkerGlobalScope;

const ICON = "/app-icon.png";
const MAX_SHOWN_PER_WAKE = 3;
const MAX_LINES = 4;
// Wakes are only useful for an hour (the relay drops older ones too).
const LOOKBACK_SECONDS = 3600;
const LEASE_KIND = 30350;
const LEASE_TTL_SECONDS = 29 * 24 * 60 * 60;
// Renewing daily keeps the lease far from expiry and its DM list current.
const RESYNC_MS = 24 * 60 * 60 * 1000;
// Same policy as Buzz mobile: skip "hellthreads" tagging many people.
const P_TAGS_MAX = 20;
const H_PER_FILTER = 50;
const MAX_SUBSCRIPTIONS = 16;

type Filter = Record<string, unknown>;
/** The previous PWA's push record, same database, plus the lease state its
 * page kept in localStorage (`buzz-web-push:<pubkey>`). */
type Context = {
  id: "current";
  pubkey: string;
  relay: string;
  filters: Filter[];
  lastSeen?: number;
  notified?: string[];
  installation?: string;
  generation?: number;
  fingerprint?: string;
  syncedAt?: number;
  active?: boolean;
};
type Line = {
  id: string;
  pubkey: string;
  content: string;
  channelId: string | null;
  rootId: string | null;
  createdAt: number;
};

const store = {
  database: "buzz-desktop-web-push",
  store: "context",
  id: "current",
};
const readContext = () =>
  run<Context>(store, "readonly", (records) => records.get(store.id)).catch(
    () => undefined,
  );
const writeContext = (context: Context) =>
  run(store, "readwrite", (records) => records.put(context), true);

/** The saved key, or the previous PWA's until its owner continues with it. */
export async function identity() {
  return (
    (await load().catch(() => null)) ?? (await loadLegacy().catch(() => null))
  );
}

const now = () => Math.floor(Date.now() / 1000);
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** A NIP-98 POST: the relay's /query and /events, the gateway's /webpush/*. */
async function post<T>(key: Uint8Array, url: string, body: unknown) {
  const text = JSON.stringify(body);
  const auth = finalizeEvent(
    {
      kind: 27235,
      created_at: now(),
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        [
          "payload",
          hex(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(text),
            ),
          ),
        ],
        ["nonce", crypto.randomUUID()],
      ],
    },
    key,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
      "Content-Type": "application/json",
    },
    body: text,
    credentials: "omit",
  });
  if (!response.ok)
    throw Object.assign(new Error(`${url} answered ${response.status}`), {
      status: response.status,
    });
  return (await response.json()) as T;
}
const query = (relay: string, key: Uint8Array, filters: Filter[]) =>
  post<RelayEvent[]>(key, `${relay}/query`, filters);

// --- Wakes -----------------------------------------------------------------

/** Browsers require a notification for every push, so a wake that cannot be
 * read shows a generic one. */
export async function showWake() {
  let handled = false;
  try {
    handled = await showNewMessages();
  } catch (error) {
    console.warn("[sw] push fetch failed:", error);
  }
  if (!handled)
    await self.registration.showNotification("Buzz", {
      body: "You have new messages",
      icon: ICON,
      tag: "buzz-wake",
    });
}

async function showNewMessages() {
  const context = await readContext();
  const key = await identity();
  if (!context?.filters?.length || !key || getPublicKey(key) !== context.pubkey)
    return false;
  const since = Math.max(context.lastSeen ?? 0, now() - LOOKBACK_SECONDS);
  const [events, read] = await Promise.all([
    query(
      context.relay,
      key,
      context.filters.map((filter) => ({ ...filter, since, limit: 10 })),
    ),
    readState(context, key),
  ]);
  const newest = [
    ...new Map(
      events
        .filter(
          (event) => event.pubkey !== context.pubkey && verifyEvent(event),
        )
        .map((event) => [event.id, event]),
    ).values(),
  ].sort((a, b) => b.created_at - a.created_at);
  if (!newest[0]) return false;
  await closeNotifications(read);
  const notified = new Set(context.notified);
  const toShow = newest
    .filter((event) => !notified.has(event.id))
    .map(lineOf)
    .filter((line) => !isRead(read, line))
    .slice(0, MAX_SHOWN_PER_WAKE);
  await writeContext({
    ...context,
    lastSeen: Math.max(since, newest[0].created_at),
    notified: [...toShow.map((line) => line.id), ...notified].slice(0, 200),
  });
  if (!toShow.length) {
    // Already read elsewhere or already shown. iOS revokes subscriptions
    // after a few silent pushes, so show one quietly and take it back.
    await self.registration.showNotification("Buzz", {
      icon: ICON,
      silent: true,
      tag: "buzz-wake",
    });
    for (const notification of await self.registration.getNotifications({
      tag: "buzz-wake",
    }))
      notification.close();
    return true;
  }
  const [names, channels] = await Promise.all([
    profileNames(context.relay, key, [
      ...new Set(toShow.map((line) => line.pubkey)),
    ]),
    channelNames(context.relay, key, [
      ...new Set(toShow.flatMap((line) => line.channelId ?? [])),
    ]),
  ]);
  for (const line of toShow.reverse()) {
    const channel = line.channelId ? channels.get(line.channelId) : undefined;
    const sender = names.get(line.pubkey) ?? "Someone";
    const title = channel?.name && !channel.dm ? `#${channel.name}` : sender;
    const text = preview(line.content);
    // One notification per conversation: a new message joins its unread lines.
    const tag = line.channelId ?? line.id;
    const [previous] = await self.registration.getNotifications({ tag });
    const lines = [
      ...((previous?.data?.lines ?? []) as Line[]).filter(
        (old) => !isRead(read, old),
      ),
      { ...line, content: title === sender ? text : `${sender}: ${text}` },
    ].slice(-MAX_LINES);
    await self.registration.showNotification(title, {
      body: lines.map((entry) => entry.content).join("\n"),
      // buzz-app's navigation target (src/features/navigation/targets.ts).
      data: {
        lines,
        target: line.channelId && {
          version: 1,
          kind: "conversation",
          scope: { viewer: context.pubkey, communityOrigin: context.relay },
          channelId: line.channelId,
          messageId: line.id,
          ...(line.rootId ? { threadRootId: line.rootId } : {}),
        },
      },
      icon: ICON,
      tag,
      renotify: true,
      timestamp: line.createdAt * 1000,
    } as NotificationOptions);
  }
  return true;
}

function lineOf(event: RelayEvent): Line {
  return {
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    channelId: event.tags.find((tag) => tag[0] === "h")?.[1] ?? null,
    rootId: threadReference(event)?.rootId ?? null,
    createdAt: event.created_at,
  };
}

function preview(content: string) {
  const text = content
    .replace(/nostr:(npub1|nprofile1)[\da-z]+/g, "@someone")
    .replace(/!?\[([^\]]*)\]\(<?https?:[^)]*>?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Sent an attachment";
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Read once the channel, thread or message frontier passes it, unless the
 * channel was marked unread since (the app's unread rule). */
function isRead(state: ReadState, line: Line) {
  const frontier = effectiveFrontier(
    state,
    `msg:${line.id}`,
    line.channelId ?? undefined,
    line.rootId ?? undefined,
  );
  return (
    frontier !== undefined &&
    line.createdAt <= frontier &&
    !(
      line.channelId &&
      overrideActive(state.overrides[line.channelId], frontier)
    )
  );
}

/** The user's NIP-RS read state from every device. Unreadable means nothing
 * read, so a failure here never hides a message. */
async function readState(context: Context, key: Uint8Array) {
  const events = await query(context.relay, key, [
    {
      kinds: [30078],
      authors: [context.pubkey],
      "#t": ["read-state"],
      limit: 16,
    },
  ]).catch(() => []);
  const conversation = nip44.v2.utils.getConversationKey(key, context.pubkey);
  const states = events.flatMap((event) => {
    try {
      if (!readCoordinate(event) || !verifyEvent(event)) return [];
      return [
        parseReadBlob(JSON.parse(nip44.v2.decrypt(event.content, conversation)))
          .state,
      ];
    } catch {
      return [];
    }
  });
  try {
    return mergeReadStates(...states);
  } catch {
    return EMPTY_READ_STATE;
  }
}

async function closeNotifications(state: ReadState) {
  for (const notification of await self.registration.getNotifications()) {
    const lines = notification.data?.lines as Line[] | undefined;
    if (lines?.length && lines.every((line) => isRead(state, line)))
      notification.close();
  }
}

/** Closes the notifications read since, here or on another device. The open
 * app asks when it is shown or hidden; the wait lets read state, published
 * 5 s after the last read, reach the relay first. */
export async function closeRead() {
  await new Promise((done) => setTimeout(done, 6000));
  const context = await readContext();
  const key = await identity();
  if (context && key && getPublicKey(key) === context.pubkey)
    await closeNotifications(await readState(context, key));
}

async function profileNames(relay: string, key: Uint8Array, pubkeys: string[]) {
  const names = new Map<string, string>();
  const profiles = await query(relay, key, [
    { kinds: [0], authors: pubkeys },
  ]).catch(() => []);
  for (const profile of profiles.sort((a, b) => a.created_at - b.created_at))
    try {
      const { display_name, name } = JSON.parse(profile.content);
      if (display_name || name) names.set(profile.pubkey, display_name || name);
    } catch {}
  return names;
}

/** Signed NIP-29 metadata (kind 39000): the name, and whether it is a DM. */
async function channelNames(relay: string, key: Uint8Array, ids: string[]) {
  const channels = new Map<string, { name?: string; dm: boolean }>();
  if (!ids.length) return channels;
  const events = await query(relay, key, [{ kinds: [39000], "#d": ids }]).catch(
    () => [],
  );
  for (const { tags } of events) {
    const id = tags.find((tag) => tag[0] === "d")?.[1];
    const name = tags.find((tag) => tag[0] === "name")?.[1];
    if (id)
      channels.set(id, {
        ...(name ? { name } : {}),
        dm: tags.some(([kind, value]) => kind === "t" && value === "dm"),
      });
  }
  return channels;
}

// --- Lease -----------------------------------------------------------------

type Descriptor = {
  origin: string;
  keys: Array<{ id: string; pubkey: string; current?: boolean }>;
  // Transport -> lease classes; the gateway stands in for the APNs one.
  class_support: Record<string, string[]>;
  push_kinds: number[];
};
export type PushSync = {
  /** Notifications on in Buzz and allowed by the browser. */
  wanted: boolean;
  mentions: boolean;
  direct: boolean;
  /** The previous PWA's `buzz-web-push:<pubkey>` lease state, if any. */
  legacy?: string | null;
};

/** Mentions (which also reach replies, since those p-tag the people they
 * address) plus every joined DM, never the user's own messages. */
export function leaseSubscriptions(
  me: string,
  dms: string[],
  kinds: number[],
  mentions: boolean,
) {
  const ignore = [{ kinds, authors: [me] }];
  const suppress = { p_tags_max: P_TAGS_MAX };
  const filters: Filter[] = mentions ? [{ kinds, "#p": [me] }] : [];
  for (let index = 0; index < dms.length; index += H_PER_FILTER)
    filters.push({ kinds: [9], "#h": dms.slice(index, index + H_PER_FILTER) });
  return filters
    .slice(0, MAX_SUBSCRIPTIONS)
    .map((filter) => ({ filter, class: "default", ignore, suppress }));
}

/** The DM channels this viewer belongs to: relay-signed rosters naming them,
 * whose metadata marks a DM. */
async function directChannels(relay: string, key: Uint8Array, me: string) {
  const rosters = await query(relay, key, [
    { kinds: [39002], "#p": [me], limit: 1000 },
  ]);
  const ids = rosters.flatMap(
    (event) => event.tags.find((tag) => tag[0] === "d")?.[1] ?? [],
  );
  const channels = await channelNames(relay, key, ids);
  return ids.filter((id) => channels.get(id)?.dm).sort();
}

/** Keeps this browser's lease in step with the notification setting: lease
 * while wanted and subscribed, revoke otherwise. Cheap when nothing changed. */
export async function syncLease(sync: PushSync) {
  const key = await identity();
  if (!key) return;
  const me = getPublicKey(key);
  const relay = self.location.origin;
  const saved = await readContext();
  let legacy: Partial<Context> = {};
  try {
    legacy = JSON.parse(sync.legacy ?? "{}") ?? {};
  } catch {}
  const state: Partial<Context> =
    saved?.pubkey === me && saved.installation ? saved : legacy;
  const subscription = await self.registration.pushManager.getSubscription();
  const wanted = sync.wanted && !!subscription;
  if (!wanted && !state.active) return;
  const info = await fetch(relay, {
    headers: { Accept: "application/nostr+json" },
  }).then((response) => response.json());
  const push: Descriptor | undefined = info.supported_extensions?.includes(
    "buzz-push-v1",
  )
    ? info.push
    : undefined;
  if (!push) return;
  const installation =
    state.installation ??
    hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const generation = Math.max(Date.now(), (state.generation ?? 0) + 1);
  const executor = push.keys.find((entry) => entry.current) ?? push.keys[0];
  if (!executor) return;
  const publish = async (lease: Record<string, unknown>) => {
    const receipt = await post<{ accepted?: boolean; message?: string }>(
      key,
      `${relay}/events`,
      finalizeEvent(
        {
          kind: LEASE_KIND,
          created_at: now(),
          content: nip44.v2.encrypt(
            JSON.stringify({ v: 1, origin: push.origin, generation, ...lease }),
            nip44.v2.utils.getConversationKey(key, executor.pubkey),
          ),
          tags: [
            ["d", installation],
            ["expiration", String(now() + LEASE_TTL_SECONDS)],
            ["exec", executor.id],
            ["alt", "Push lease"],
          ],
        },
        key,
      ),
    );
    if (!receipt.accepted)
      throw new Error(`push lease refused: ${receipt.message}`);
  };
  const base: Context = {
    // Notify only about messages from the moment notifications came on.
    lastSeen: now(),
    ...(saved?.pubkey === me ? saved : { notified: [] }),
    id: "current",
    pubkey: me,
    relay,
    filters: [],
    installation,
    generation,
  };

  if (!wanted) {
    await publish({ active: false });
    await writeContext({ ...base, active: false, fingerprint: "" });
    if (subscription) {
      await post(key, `${relay}/webpush/unregister`, {
        endpoint: subscription.endpoint,
      }).catch(() => {});
      await subscription.unsubscribe();
    }
    return;
  }

  const dms = sync.direct ? await directChannels(relay, key, me) : [];
  const subscriptions = leaseSubscriptions(
    me,
    dms,
    push.push_kinds,
    sync.mentions,
  );
  const [transport] = Object.keys(push.class_support);
  const fingerprint = JSON.stringify([
    transport,
    subscription.endpoint,
    subscriptions,
  ]);
  const filters = subscriptions.map((entry) => entry.filter);
  if (
    state.active &&
    state.fingerprint === fingerprint &&
    Date.now() - (state.syncedAt ?? 0) < RESYNC_MS
  ) {
    // Also adopts the previous PWA's lease on first run.
    await writeContext({ ...base, filters, active: true, fingerprint });
    return;
  }
  let grant: string;
  try {
    ({ endpoint_grant: grant } = await post<{ endpoint_grant: string }>(
      key,
      `${relay}/webpush/register`,
      { subscription: subscription.toJSON(), generation },
    ));
  } catch (error) {
    // The push service has dropped this endpoint: the page subscribes anew.
    if ((error as { status?: number }).status === 410)
      await subscription.unsubscribe();
    throw error;
  }
  await publish({
    transport,
    endpoint: grant,
    active: true,
    subscriptions,
  });
  await writeContext({
    ...base,
    filters,
    active: true,
    fingerprint,
    syncedAt: Date.now(),
  });
}
