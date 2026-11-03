import { key } from "./commands.ts";
import type { PushSync } from "./push.ts";

// The page side of web/sw.ts. Upstream's browser notifications
// (src/features/notifications/platform.ts) call `new Notification()`, which
// Android and installed iOS apps refuse; this stand-in has the same surface
// and shows them through the service worker, which routes taps back here.
// It also keeps the push lease in step with notification permission and
// preferences whenever the app is shown.

const Native = window.Notification;
const supported = "serviceWorker" in navigator && !!Native;
const ready = supported
  ? navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then(() => navigator.serviceWorker.ready)
      .catch(() => undefined)
  : undefined;
const shown = new Map<string, ServiceWorkerNotification>();

class ServiceWorkerNotification {
  static get permission() {
    return Native.permission;
  }
  static async requestPermission() {
    const permission = await Native.requestPermission();
    void syncPush();
    return permission;
  }
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly tag: string;
  constructor(title: string, options: NotificationOptions = {}) {
    const tag = options.tag || crypto.randomUUID();
    this.tag = tag;
    shown.set(tag, this);
    ready
      ?.then(
        (registration) =>
          registration?.showNotification(title, {
            ...options,
            tag,
            icon: "/app-icon.png",
            data: { page: true },
          }) ?? Promise.reject(),
      )
      .catch(() => {
        shown.delete(tag);
        this.onerror?.();
      });
  }
  close() {
    shown.delete(this.tag);
    void ready
      ?.then((registration) =>
        registration?.getNotifications({ tag: this.tag }),
      )
      .then((list) => {
        for (const notification of list ?? []) notification.close();
      });
  }
}

const sameKey = (subscription: PushSubscription, vapidPublicKey: string) => {
  const key = subscription.options.applicationServerKey;
  // Unknown counts as the same: a needless resubscribe kills a live endpoint.
  return (
    !key ||
    btoa(String.fromCharCode(...new Uint8Array(key)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "") === vapidPublicKey
  );
};

/** Subscribes while notifications are wanted; the worker leases or revokes. */
async function syncPush() {
  const viewer = await (
    key({}, "identity_restore") as Promise<string | null>
  ).catch(() => null);
  const registration = await ready;
  if (!viewer || !registration) return;
  let preferences: { enabled?: boolean; categories?: Record<string, boolean> } =
    {};
  try {
    preferences =
      JSON.parse(
        localStorage.getItem(`buzz-notification-preferences.v1:${viewer}`) ??
          "{}",
      ) ?? {};
  } catch {}
  const { mention, thread, direct } = preferences.categories ?? {};
  const sync: PushSync = {
    mentions: mention !== false || thread !== false,
    direct: direct !== false,
    wanted: false,
    legacy: localStorage.getItem(`buzz-web-push:${viewer}`),
  };
  sync.wanted =
    Native.permission === "granted" &&
    preferences.enabled !== false &&
    (sync.mentions || sync.direct) &&
    "PushManager" in window;
  if (sync.wanted) {
    const config = await fetch("/webpush/config")
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined);
    // No push gateway on this origin.
    if (!config?.vapidPublicKey) return;
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, config.vapidPublicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: config.vapidPublicKey,
    });
  }
  registration.active?.postMessage({ type: "buzz-push-sync", ...sync });
}

if (ready) {
  Object.defineProperty(window, "Notification", {
    value: ServiceWorkerNotification,
    configurable: true,
    writable: true,
  });
  navigator.serviceWorker.addEventListener("message", ({ data }) => {
    if (data?.type !== "buzz-notification-click") return;
    if (data.tag) shown.get(data.tag)?.onclick?.();
    else if (data.hash) location.hash = data.hash;
  });
  navigator.serviceWorker.startMessages();
  // An installed app stays open for days: refresh the lease whenever it is
  // shown, and let the worker close notifications read since.
  const refresh = () => {
    navigator.serviceWorker.controller?.postMessage({
      type: "buzz-close-read",
    });
    if (document.visibilityState === "visible")
      syncPush().catch((error) => console.warn("[web] push sync:", error));
  };
  document.addEventListener("visibilitychange", refresh);
  refresh();
}
