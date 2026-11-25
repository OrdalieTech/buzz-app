import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export type NotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "unknown";
export type NotificationPresentation = Readonly<{
  id: string;
  title: string;
  body: string;
}>;
export interface NotificationPlatform {
  readonly label: string;
  readonly systemManaged?: boolean;
  /** The system prompt needs no user gesture, so Buzz may send it once on
   * its own. */
  readonly requestsAutomatically?: boolean;
  permission(): Promise<NotificationPermissionState>;
  requestPermission(): Promise<NotificationPermissionState>;
  show(
    item: NotificationPresentation,
    activate: () => void,
    failed: (error: Error) => void,
  ): Promise<void>;
  dispose(): void;
}

type DesktopResponse = Readonly<{
  id: string;
  kind: "activated" | "closed" | "failed";
  error?: string;
}>;

/** One native presentation owner, with its callback registered before sending. */
export function createNotifications(): NotificationPlatform {
  if (!isTauri()) return createBrowserNotifications();
  let disposed = false;
  const active = new Map<string, Channel<DesktopResponse>>();
  const release = (id: string, channel: Channel<DesktopResponse>) => {
    channel.onmessage = () => {};
    active.delete(id);
  };
  const macOS = /Mac/i.test(globalThis.navigator?.platform ?? "");
  return {
    label: "Desktop notifications",
    systemManaged: !macOS,
    requestsAutomatically: macOS,
    // macOS uses Dock's UNUserNotificationCenter authorization source. Other
    // desktop backends have no permission query in this bridge.
    permission: () =>
      macOS
        ? invoke<NotificationPermission>("notification_permission_state")
        : Promise.resolve("unknown"),
    requestPermission: () =>
      macOS
        ? invoke<NotificationPermission>("request_notification_access")
        : Promise.resolve("unknown"),
    async show(item, activate, failed) {
      if (disposed) throw new Error("Desktop notifications have stopped");
      // Native admission explicitly returns the ID it withdrew. Match that ID,
      // not local insertion order: a webview reload can leave older native cards.
      if (!macOS && active.size >= 128)
        throw new Error("Too many active desktop notifications (maximum 128)");
      const channel = new Channel<DesktopResponse>((response) => {
        if (disposed || response.id !== item.id || !active.has(item.id)) return;
        release(item.id, channel);
        if (response.error) failed(new Error(response.error));
        if (response.kind === "activated") activate();
      });
      active.set(item.id, channel);
      try {
        // Native code restores/focuses the main window before returning the click.
        // No destination or account data crosses this boundary.
        const retired = await invoke<string | null>("notification_show", {
          id: item.id,
          title: item.title,
          body: item.body,
          onEvent: channel,
        });
        if (retired) {
          const oldChannel = active.get(retired);
          if (oldChannel) release(retired, oldChannel);
        }
      } catch (error) {
        release(item.id, channel);
        throw error;
      }
    },
    dispose() {
      disposed = true;
      for (const [id, channel] of active) release(id, channel);
    },
  };
}

/** Running-tab alerts. Native delivery never falls back to a WebView API. */
export function createBrowserNotifications(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
): NotificationPlatform {
  const api =
    host && !isTauri() && "Notification" in host
      ? (host as Window & { Notification: typeof Notification }).Notification
      : undefined;
  const active = new Map<string, Notification>();
  function release(id: string, notification: Notification) {
    notification.onclick = null;
    notification.onclose = null;
    notification.onerror = null;
    active.delete(id);
  }
  function retire(id: string, notification: Notification) {
    release(id, notification);
    notification.close();
  }
  return {
    label: isTauri()
      ? "Native notifications unavailable in this build"
      : "Browser notifications",
    permission: async () => api?.permission ?? "unsupported",
    requestPermission: () =>
      api ? api.requestPermission() : Promise.resolve("unsupported"),
    async show(item, activate, failed) {
      if (api?.permission !== "granted")
        throw new Error("Notification permission is not granted");
      // Closing the oldest presentation also retires its callback; never strand
      // an open banner by independently evicting its only navigation target.
      if (active.size >= 128) {
        const first = active.entries().next().value;
        if (first) retire(...first);
      }
      const notification = new api(item.title, {
        body: item.body,
        tag: item.id,
        // Sound is app-owned: the notifications service plays the selected
        // bundled sound after delivery, so the banner is always submitted silent.
        silent: true,
      });
      active.set(item.id, notification);
      notification.onclick = () => {
        host?.focus();
        activate();
        retire(item.id, notification);
      };
      notification.onclose = () => release(item.id, notification);
      notification.onerror = () => {
        retire(item.id, notification);
        failed(new Error("The browser could not display a notification."));
      };
    },
    dispose() {
      for (const [id, item] of active) retire(id, item);
    },
  };
}
