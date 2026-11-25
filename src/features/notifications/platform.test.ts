import { afterEach, expect, it, vi } from "vitest";
import { createBrowserNotifications } from "./platform";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native }));
const { native: initial } = vi.hoisted(() => ({ native: false }));
let native = initial;
afterEach(() => {
  native = false;
});
function setup() {
  const shown: FakeNotification[] = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission = vi.fn(async () => FakeNotification.permission);
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn(() => this.onclose?.());
    constructor(
      public title: string,
      public options: NotificationOptions,
    ) {
      shown.push(this);
    }
  }
  const host = {
    Notification: FakeNotification,
    focus: vi.fn(),
  } as unknown as Window;
  return {
    platform: createBrowserNotifications(host),
    host,
    shown,
    FakeNotification,
  };
}
it("browser activation focuses and routes once; close/dispose releases callbacks", async () => {
  const t = setup(),
    activate = vi.fn();
  await t.platform.show(
    {
      id: "one",
      title: "Pinky mentioned you in #Room",
      body: "Hello Wes",
    },
    activate,
    vi.fn(),
  );
  expect(t.shown[0]?.title).toBe("Pinky mentioned you in #Room");
  expect(t.shown[0]?.options).toEqual({
    body: "Hello Wes",
    tag: "one",
    // Sound is app-owned; the OS banner is always submitted silent.
    silent: true,
  });
  t.shown[0]?.onclick?.();
  expect(activate).toHaveBeenCalledTimes(1);
  expect(t.host.focus).toHaveBeenCalledTimes(1);
  expect(t.shown[0]?.onclick).toBeNull();
  await t.platform.show(
    { id: "two", title: "Buzz", body: "New mention" },
    activate,
    vi.fn(),
  );
  t.platform.dispose();
  expect(t.shown[1]?.onclick).toBeNull();
  expect(t.shown[1]?.onerror).toBeNull();
  expect(t.shown[1]?.onclose).toBeNull();
  expect(t.shown[1]?.close).toHaveBeenCalledTimes(1);
});
it("bounded presentation closes the old banner instead of stranding its target", async () => {
  const t = setup();
  for (let i = 0; i < 129; i++)
    await t.platform.show(
      { id: String(i), title: "Buzz", body: "New mention" },
      () => {},
      vi.fn(),
    );
  expect(t.shown[0]?.close).toHaveBeenCalledTimes(1);
  expect(t.shown[0]?.onclick).toBeNull();
  expect(t.shown[0]?.onerror).toBeNull();
  expect(t.shown[0]?.onclose).toBeNull();
  expect(t.shown[128]?.onclick).toBeTypeOf("function");
  t.platform.dispose();
});
it("denial and a native WebView never silently use browser notification delivery", async () => {
  const t = setup();
  // A browser needs a user gesture to ask: it never asks on its own.
  expect(t.platform.requestsAutomatically).toBeUndefined();
  t.FakeNotification.permission = "denied";
  expect(await t.platform.permission()).toBe("denied");
  await expect(
    t.platform.show(
      { id: "one", title: "Buzz", body: "New mention" },
      () => {},
      vi.fn(),
    ),
  ).rejects.toThrow("permission");
  native = true;
  const other = createBrowserNotifications(t.host);
  expect(await other.permission()).toBe("unsupported");
  expect(await other.requestPermission()).toBe("unsupported");
  expect(t.FakeNotification.requestPermission).not.toHaveBeenCalled();
  expect(t.shown).toHaveLength(0);
});

it("asynchronous browser errors report once and retire every callback without retry", async () => {
  const t = setup(),
    failed = vi.fn(),
    activate = vi.fn();
  await t.platform.show(
    { id: "failed", title: "Buzz", body: "New mention" },
    activate,
    failed,
  );
  t.shown[0]?.onerror?.();
  t.shown[0]?.onerror?.();
  expect(failed).toHaveBeenCalledExactlyOnceWith(
    new Error("The browser could not display a notification."),
  );
  expect(t.shown[0]?.onclick).toBeNull();
  expect(t.shown[0]?.onerror).toBeNull();
  expect(t.shown[0]?.onclose).toBeNull();
  expect(t.shown[0]?.close).toHaveBeenCalledTimes(1);
  expect(activate).not.toHaveBeenCalled();
  expect(t.shown).toHaveLength(1);
});
