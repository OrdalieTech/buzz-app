/// <reference lib="webworker" />
import { finalizeEvent } from "nostr-tools";
import { closeRead, identity, showWake, syncLease } from "./push.ts";

// The web build's service worker, /sw.js (the previous PWA's name and scope,
// so existing push subscriptions survive): signed relay media, notification
// taps and push wakes. A push arrives with no page open and a service worker
// cannot start the key Worker, so this is the one other context that reads
// the vault.

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

const communities = new Set(
  String(import.meta.env.VITE_BUZZ_COMMUNITIES ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const BLOB = /^\/media\/[0-9a-f]{64}(?:\.(?:[a-z0-9]{1,8}|thumb\.jpg))?$/;

/** `/api/relay/<community>/media?url=<relay media URL>`, the shape web/host.ts
 * gives `convertFileSrc(url, "buzz-media")`: null when the target is not a
 * relay blob this build may reach, undefined for every other request. */
function mediaTarget(request: Request) {
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    !/^\/api\/relay\/[^/]+\/media$/.test(url.pathname)
  )
    return undefined;
  const target = url.searchParams.get("url") ?? "";
  const media = URL.canParse(target) ? new URL(target) : undefined;
  return request.method === "GET" &&
    media?.protocol === "https:" &&
    media.href === target &&
    !media.username &&
    !media.password &&
    !media.search &&
    !media.hash &&
    communities.has(media.host) &&
    BLOB.test(media.pathname)
    ? media
    : null;
}

self.addEventListener("fetch", (event) => {
  const target = mediaTarget(event.request);
  if (target !== undefined)
    event.respondWith(
      target
        ? media(target, event.request)
        : new Response(null, { status: 403 }),
    );
});

/** One freshly signed Blossom `get` per request, Range passed through (native
 * `send_media`), and native's `media_type` rule for what renders inline. */
async function media(url: URL, request: Request) {
  const key = await identity();
  if (!key) return new Response(null, { status: 401 });
  const now = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      content: "Get buzz-media",
      tags: [
        ["t", "get"],
        ["server", url.host],
        ["expiration", String(now + 60)],
      ],
    },
    key,
  );
  const headers = new Headers({
    Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
  });
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  const upstream = await fetch(url, {
    headers,
    credentials: "omit",
    redirect: "error",
    signal: request.signal,
  }).catch(() => undefined);
  if (upstream?.status !== 200 && upstream?.status !== 206)
    return new Response(null, { status: upstream?.status ?? 502 });
  const type = (upstream.headers.get("Content-Type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  const inline =
    !!type &&
    /^(image|video|audio)\/[a-z0-9.+-]+$/.test(type) &&
    type !== "image/svg+xml";
  const response = new Headers({
    "Content-Type": inline ? type : "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
  if (!inline) response.set("Content-Disposition", "attachment");
  for (const name of ["Content-Length", "Content-Range"]) {
    const value = upstream.headers.get(name);
    if (value) response.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: response,
  });
}

// A tap focuses the app and routes it: running-tab alerts (web/notifications.ts)
// to the page's own click handler, push alerts to their conversation.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { data, tag } = event.notification;
  event.waitUntil(
    (async () => {
      const hash = data?.target
        ? `#buzz=${encodeURIComponent(JSON.stringify(data.target))}`
        : "";
      const [client] = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if (!client) {
        await self.clients.openWindow(`/${hash}`);
        return;
      }
      client.postMessage({
        type: "buzz-notification-click",
        ...(data?.page ? { tag } : { hash }),
      });
      await client.focus().catch(() => {});
    })(),
  );
});

self.addEventListener("push", (event) => event.waitUntil(showWake()));

self.addEventListener("message", (event) => {
  const work =
    event.data?.type === "buzz-push-sync"
      ? syncLease(event.data)
      : event.data?.type === "buzz-close-read"
        ? closeRead()
        : undefined;
  if (work)
    event.waitUntil(
      work.catch((error) => console.warn(`[sw] ${event.data.type}:`, error)),
    );
});
