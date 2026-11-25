import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginModule } from "../../plugins/api";
import { provideNavigation } from "../navigation/service";
import { NotificationsService, type Notifications } from "./service";
import { createNotificationPreferences } from "./preferences";
import type {
  NotificationPlatform,
  NotificationPermissionState,
} from "./platform";

const viewer = "a".repeat(64);
const target = {
  version: 1,
  kind: "settings",
  section: "notifications",
} as const;
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function setup(
  options: {
    requestsAutomatically?: boolean;
    permission?: NotificationPermissionState;
    values?: Map<string, string>;
  } = {},
) {
  const ctx = new Context();
  contexts.push(ctx);
  let module: PluginModule = { apply() {} };
  const runtime = new PluginRuntime(ctx, async () => module);
  ctx.effect(() => () => runtime.dispose());
  const values = options.values ?? new Map<string, string>();
  const host = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window;
  const preferences = createNotificationPreferences(host);
  const navigation = provideNavigation(ctx);
  const clicks: (() => void)[] = [];
  const failures: ((error: Error) => void)[] = [];
  let permission = options.permission ?? "granted";
  let present = true;
  let asking = 0;
  let held: Promise<NotificationPermissionState> | undefined;
  const platform: NotificationPlatform = {
    label: "Test",
    ...(options.requestsAutomatically ? { requestsAutomatically: true } : {}),
    // As macOS 27 does: an unanswered request reads as denied, not as not yet
    // asked.
    permission: vi.fn(async () => (asking ? "denied" : permission)),
    requestPermission: vi.fn(async () => {
      asking++;
      try {
        return (await held) ?? permission;
      } finally {
        asking--;
      }
    }),
    show: vi.fn(async (_item, activate, failed) => {
      clicks.push(activate);
      failures.push(failed);
    }),
    dispose: vi.fn(),
  };
  const plays: string[] = [];
  const service = new NotificationsService(
    ctx,
    navigation.navigation,
    platform,
    preferences,
    undefined,
    (name) => plays.push(name),
    () => present,
  );
  service.selectViewer(viewer);
  return {
    ctx,
    service,
    preferences,
    platform,
    navigation,
    clicks,
    failures,
    values,
    host,
    plays,
    permission(value: NotificationPermissionState) {
      permission = value;
    },
    /** Whether the window is visible and focused. */
    present(value: boolean) {
      present = value;
    },
    /** Keeps system requests unanswered until the returned gate settles them. */
    holdRequest() {
      const gate = deferred<NotificationPermissionState>();
      held = gate.promise;
      // A test that fails before settling must not leave an unhandled rejection.
      gate.promise.catch(() => {});
      return {
        /** The person answers; the OS reports that answer from then on. */
        answer(value: NotificationPermissionState) {
          held = undefined;
          permission = value;
          gate.resolve(value);
        },
        /** Nobody answers: the native wait gives up and the OS keeps reporting denied. */
        timeout() {
          held = undefined;
          permission = "denied";
          gate.reject(
            new Error("Timed out waiting for notification permission"),
          );
        },
      };
    },
    submit(id = "event", eligible: () => boolean | "wait" = () => true) {
      return service.admit(
        "mention",
        "Mentions",
        { sourceKey: id, target },
        () => true,
        eligible,
      );
    },
    install(value: PluginModule) {
      module = value;
      runtime.reconcile([
        {
          manifest: { id: "test.plugin", name: "Test plugin", apiVersion: 1 },
          enabled: true,
          source: "external",
          revision: "v1",
          previous: null,
          reloadable: true,
          error: null,
        },
      ]);
    },
    disable() {
      runtime.reconcile([]);
    },
  };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
const askedKey = "buzz-notification-permission-asked.v1";
/** A fresh install on a platform that may ask on its own: the OS reports not yet asked. */
function firstRun(values?: Map<string, string>) {
  return setup({
    requestsAutomatically: true,
    permission: "default",
    ...(values ? { values } : {}),
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
it("deduplicates in this running session and routes clicks through existing navigation", async () => {
  const t = setup();
  expect(await t.submit()).toBe(true);
  expect(await t.submit()).toBe(false);
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry.target).toEqual(target);
  expect(t.navigation.navigation.snapshot().status).toBe("opening");
});
it("more than 256 sequential alerts do not fill a persistent inbox or pause delivery", async () => {
  const t = setup();
  for (let i = 0; i < 300; i++) {
    expect(await t.submit(String(i))).toBe(true);
    await flush();
  }
  expect(t.platform.show).toHaveBeenCalledTimes(300);
  expect(t.service.snapshot().error).toBeNull();
  expect(Object.keys(t.service.snapshot())).not.toContain("records");
});
it.each([
  ["a platform that cannot ask on its own", false, true],
  ["a platform whose window is not in front", true, false],
])(
  "an arriving alert never asks on %s, and is shown after an explicit Allow",
  async (_name, requestsAutomatically, present) => {
    const t = setup({ requestsAutomatically, permission: "default" });
    t.present(present);
    t.service.setEntered(true);
    await t.service.refreshPermission();
    await t.submit();
    await flush();
    expect(t.platform.requestPermission).not.toHaveBeenCalled();
    expect(t.values.has(askedKey)).toBe(false);
    expect(t.platform.show).not.toHaveBeenCalled();
    t.permission("granted");
    await t.service.requestPermission();
    await flush();
    expect(t.platform.show).toHaveBeenCalledTimes(1);
  },
);
it("without entering the app, nothing asks: not the first read, a window focus or an alert", async () => {
  const t = firstRun();
  await flush();
  expect(t.service.snapshot().permission).toBe("default");
  await t.service.refreshPermission();
  await t.submit();
  await flush();
  // The construction read, the focus read and the alert's own probe all ran.
  expect(t.platform.permission).toHaveBeenCalledTimes(3);
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
  expect(t.platform.show).not.toHaveBeenCalled();
});
it("entering the app while present sends one system request; later entries and focuses send none", async () => {
  const t = firstRun();
  const request = t.holdRequest();
  try {
    t.service.setEntered(true);
    await flush();
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
    expect(t.service.snapshot().requesting).toBe(true);
    expect(t.values.get(askedKey)).toBe("1");
    t.service.setEntered(true);
    await t.service.refreshPermission();
    await flush();
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  } finally {
    // The adversarial answer: the OS still reports not yet asked.
    request.answer("default");
    await flush();
  }
  expect(t.service.snapshot()).toMatchObject({
    requesting: false,
    permission: "default",
  });
  // Nor does this run ask again once the device record is gone.
  t.values.delete(askedKey);
  t.service.setEntered(true);
  await t.service.refreshPermission();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.values.has(askedKey)).toBe(false);
});
it("entering while the window is not in front waits, unspent, for the focus that finds it there", async () => {
  const t = firstRun();
  t.present(false);
  t.service.setEntered(true);
  await t.service.refreshPermission();
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
  t.present(true);
  await t.service.refreshPermission();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.values.get(askedKey)).toBe("1");
});
it.each(["denied", "unknown", "unsupported"] as const)(
  "%s permission never asks on entry",
  async (permission) => {
    const t = setup({ requestsAutomatically: true, permission });
    // Entered before any read completes: the unread initial state is no status.
    t.service.setEntered(true);
    await flush();
    await t.service.refreshPermission();
    expect(t.service.snapshot().permission).toBe(permission);
    expect(t.platform.requestPermission).not.toHaveBeenCalled();
    expect(t.values.has(askedKey)).toBe(false);
  },
);
it("a superseded not-yet-asked reading never asks once the OS itself reports a denial", async () => {
  const t = firstRun();
  await flush();
  expect(t.service.snapshot().permission).toBe("default");
  const stale = deferred<NotificationPermissionState>();
  vi.mocked(t.platform.permission).mockReturnValueOnce(stale.promise);
  t.permission("denied");
  try {
    t.service.setEntered(true);
    // A newer read supersedes the entry's own, which is still outstanding.
    await t.service.refreshPermission();
    expect(t.platform.permission).toHaveBeenCalledTimes(3);
    expect(t.service.snapshot().permission).toBe("denied");
  } finally {
    stale.resolve("default");
    await flush();
  }
  expect(t.service.snapshot().permission).toBe("denied");
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
});
it("the development pause never asks on entry", async () => {
  vi.stubEnv("VITE_BUZZ_NOTIFICATIONS_PAUSED", "1");
  const t = firstRun();
  expect(t.service.snapshot().developmentPaused).toBe(true);
  t.service.setEntered(true);
  await flush();
  expect(t.platform.permission).toHaveBeenCalledTimes(2);
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
});
it("Desktop alerts turned off never ask on entry; the focus after they are turned back on does", async () => {
  const t = firstRun();
  t.service.updatePreferences({ enabled: false });
  t.service.setEntered(true);
  await t.service.refreshPermission();
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
  t.service.updatePreferences({ enabled: true });
  await t.service.refreshPermission();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.values.get(askedKey)).toBe("1");
});
it("leaving the app before the request is sent withdraws it; entering again restores it", async () => {
  const t = firstRun();
  t.service.updatePreferences({ enabled: false });
  t.service.setEntered(true);
  await flush();
  // The last community goes while Desktop alerts are still off.
  t.service.setEntered(false);
  t.service.updatePreferences({ enabled: true });
  await t.service.refreshPermission();
  await flush();
  expect(t.service.snapshot().permission).toBe("default");
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
  t.service.setEntered(true);
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.values.get(askedKey)).toBe("1");
});
it("leaving the app while the entry read is in flight sends nothing", async () => {
  const t = firstRun();
  await flush();
  const read = deferred<NotificationPermissionState>();
  vi.mocked(t.platform.permission).mockImplementationOnce(() => read.promise);
  t.service.setEntered(true);
  try {
    // The construction read and the entry read, which is still unanswered.
    expect(t.platform.permission).toHaveBeenCalledTimes(2);
    t.service.setEntered(false);
  } finally {
    read.resolve("default");
    await flush();
  }
  expect(t.service.snapshot().permission).toBe("default");
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
});
it.each<[string, boolean, string | null]>([
  ["automatic request stays quiet", true, null],
  [
    "explicit request reports it",
    false,
    "Timed out waiting for notification permission",
  ],
])(
  "a request nobody answers is followed by a read of the status, and the %s",
  async (_name, automatic, error) => {
    const t = firstRun();
    const request = t.holdRequest();
    let reads = 0;
    try {
      if (automatic) t.service.setEntered(true);
      else void t.service.requestPermission();
      await flush();
      expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
      expect(t.service.snapshot()).toMatchObject({
        permission: "default",
        requesting: true,
      });
      reads = vi.mocked(t.platform.permission).mock.calls.length;
    } finally {
      request.timeout();
      await flush();
    }
    // Delivery no longer offers a request that macOS will not show again.
    expect(t.platform.permission).toHaveBeenCalledTimes(reads + 1);
    expect(t.service.snapshot()).toMatchObject({
      permission: "denied",
      requesting: false,
      error,
    });
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  },
);
it("the read after a failed explicit request sends no automatic request and spends no device record", async () => {
  // Desktop alerts were saved off in an earlier run on this device.
  const earlier = firstRun();
  earlier.service.updatePreferences({ enabled: false });
  await earlier.ctx.fiber.dispose();
  const t = firstRun(earlier.values);
  expect(t.service.snapshot().preferences.enabled).toBe(false);
  t.service.setEntered(true);
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  // Turned back on in Settings, which keeps the window focused: no focus read.
  t.service.updatePreferences({ enabled: true });
  await flush();
  const reads = vi.mocked(t.platform.permission).mock.calls.length;
  // One click on Allow notifications. The native request rejects, and the OS
  // still reports not yet asked.
  vi.mocked(t.platform.requestPermission).mockRejectedValueOnce(
    new Error("Permission request failed"),
  );
  await t.service.requestPermission();
  await flush();
  expect(t.platform.permission).toHaveBeenCalledTimes(reads + 1);
  expect(t.service.snapshot()).toMatchObject({
    permission: "default",
    requesting: false,
    error: "Permission request failed",
  });
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.values.has(askedKey)).toBe(false);
  // The automatic request is unspent, and still waits for a window focus.
  await t.service.refreshPermission();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(2);
  expect(t.values.get(askedKey)).toBe("1");
});
it("an ignored automatic request is not reported, retried or repeated, and keeps a shown error", async () => {
  const t = firstRun();
  t.service.reportError(new Error("Earlier failure"));
  vi.mocked(t.platform.requestPermission).mockRejectedValueOnce(
    new Error("Timed out waiting for notification permission"),
  );
  t.service.setEntered(true);
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.service.snapshot()).toMatchObject({
    requesting: false,
    error: "Earlier failure",
  });
  t.service.setEntered(true);
  await t.service.refreshPermission();
  await t.submit();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.platform.show).not.toHaveBeenCalled();
  // The explicit request still reports its own failure.
  vi.mocked(t.platform.requestPermission).mockRejectedValueOnce(
    new Error("Permission request failed"),
  );
  await t.service.requestPermission();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(2);
  expect(t.service.snapshot().error).toBe("Permission request failed");
});
it("the automatic request is remembered on this device across runs and accounts; explicit Allow still asks", async () => {
  const first = firstRun();
  first.service.setEntered(true);
  await flush();
  expect(first.platform.requestPermission).toHaveBeenCalledTimes(1);
  await first.ctx.fiber.dispose();
  // A later run as another account on the same device. macOS reports a prompt
  // it has shown as allowed or denied, neither of which asks; a status of not
  // yet asked is the one case left for the device record to stop.
  const next = firstRun(first.values);
  next.service.selectViewer("b".repeat(64));
  next.service.setEntered(true);
  await next.submit();
  await flush();
  expect(next.platform.requestPermission).not.toHaveBeenCalled();
  expect(next.platform.show).not.toHaveBeenCalled();
  // Its alert is held, and the explicit request ignores the record.
  next.permission("granted");
  await next.service.requestPermission();
  await flush();
  expect(next.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(next.platform.show).toHaveBeenCalledTimes(1);
});
it("a device that cannot record the automatic request never sends it", async () => {
  const t = firstRun();
  vi.spyOn(t.host.localStorage, "setItem").mockImplementation(() => {
    throw new Error("disk");
  });
  t.service.setEntered(true);
  await t.submit();
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  t.permission("granted");
  await t.service.requestPermission();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("an alert arriving during an explicit request is kept for its answer and spends no automatic request", async () => {
  const t = firstRun();
  const request = t.holdRequest();
  const allow = t.service.requestPermission();
  try {
    t.service.setEntered(true);
    await t.submit();
    await flush();
    // The construction read and the alert's own probe, which read denied.
    expect(t.platform.permission).toHaveBeenCalledTimes(2);
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
    expect(t.values.has(askedKey)).toBe(false);
    expect(t.platform.show).not.toHaveBeenCalled();
  } finally {
    request.answer("granted");
    await allow;
    await flush();
  }
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
});
it.each<[string, NotificationPermissionState | undefined, number]>([
  ["is shown after Allow", "granted", 1],
  ["is dropped after Don't Allow", "denied", 0],
  ["is not shown after the request times out", undefined, 0],
])(
  "an alert arriving while the automatic request is unanswered %s",
  async (_name, answer, shown) => {
    const t = firstRun();
    const request = t.holdRequest();
    try {
      t.service.setEntered(true);
      await flush();
      expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
      await t.submit();
      await flush();
      // The construction read, the entry read and the alert's own probe, which
      // read denied.
      expect(t.platform.permission).toHaveBeenCalledTimes(3);
      expect(t.platform.show).not.toHaveBeenCalled();
    } finally {
      if (answer) request.answer(answer);
      else request.timeout();
      await flush();
    }
    expect(t.service.snapshot().requesting).toBe(false);
    expect(t.platform.show).toHaveBeenCalledTimes(shown);
    // Settled: a permission granted later brings nothing back.
    t.permission("granted");
    await t.service.refreshPermission();
    await flush();
    expect(t.platform.show).toHaveBeenCalledTimes(shown);
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  },
);
it.each<[string, NotificationPermissionState, number]>([
  ["is shown after Allow", "granted", 1],
  ["is dropped after Don't Allow", "denied", 0],
])(
  "an alert whose permission read straddles the answer %s",
  async (_name, answer, shown) => {
    const t = firstRun();
    const request = t.holdRequest();
    const probe = deferred<NotificationPermissionState>();
    try {
      t.service.setEntered(true);
      await flush();
      expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
      vi.mocked(t.platform.permission).mockImplementationOnce(
        () => probe.promise,
      );
      await t.submit();
      await flush();
      // The construction read, the entry read and the alert's own probe, which
      // is sent while the prompt is up and not yet answered.
      expect(t.platform.permission).toHaveBeenCalledTimes(3);
      request.answer(answer);
      await flush();
      // The request has settled before the probe's reply lands.
      expect(t.service.snapshot()).toMatchObject({
        requesting: false,
        permission: answer,
      });
      expect(t.platform.show).not.toHaveBeenCalled();
    } finally {
      // What macOS said when the probe was sent: an unanswered prompt.
      probe.resolve("denied");
      await flush();
    }
    expect(t.platform.show).toHaveBeenCalledTimes(shown);
    // Settled: a permission granted later brings nothing back.
    t.permission("granted");
    await t.service.refreshPermission();
    await flush();
    expect(t.platform.show).toHaveBeenCalledTimes(shown);
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  },
);
it("the Dock indicator re-reads its permission when a request settles", async () => {
  const t = setup({ permission: "default" });
  const refresh = vi.spyOn(t.service.indicator, "reread");
  const request = t.holdRequest();
  const allow = t.service.requestPermission();
  try {
    await flush();
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    request.answer("granted");
    await allow;
  }
  expect(refresh).toHaveBeenCalledTimes(1);
});
it("an off/on transition during a permission probe cancels the old candidate", async () => {
  const t = setup();
  await flush();
  let release!: (value: NotificationPermissionState) => void;
  vi.mocked(t.platform.permission).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.submit();
  await flush();
  expect(release).toBeTypeOf("function");
  t.service.updatePreferences({ enabled: false });
  t.service.updatePreferences({ enabled: true });
  release("granted");
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
});
it("readiness rechecks fresh candidates; expired candidates never reappear", async () => {
  const t = setup();
  let ready = false;
  await t.submit("waiting", () => (ready ? true : "wait"));
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
  ready = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  ready = false;
  await t.submit("old", () => (ready ? true : "wait"));
  await flush();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 121000);
  ready = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("submission failure is reported once; unrelated alerts are not blocked", async () => {
  const t = setup();
  vi.mocked(t.platform.show).mockRejectedValueOnce(
    new Error("OS outcome unknown"),
  );
  await t.submit();
  await flush();
  expect(t.service.snapshot().error).toBe("OS outcome unknown");
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  await t.submit("next");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(2);
});
it("old account and disposed-host callbacks cannot navigate", async () => {
  const t = setup();
  await t.submit();
  await flush();
  const before = t.navigation.navigation.snapshot().entry;
  t.service.selectViewer("b".repeat(64));
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry).toBe(before);
  await t.submit("other");
  await flush();
  await t.ctx.fiber.dispose();
  t.clicks[1]?.();
  expect(t.navigation.navigation.snapshot().entry).toBe(before);
});
it("installed plugins share the host policy and stale producer handles are rejected", async () => {
  const t = setup();
  let producer: ReturnType<Notifications["register"]> | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      producer = ctx.notifications.register({
        id: "updates",
        label: "Updates",
      });
    },
  });
  await vi.waitFor(() => expect(producer).toBeDefined());
  expect(await producer?.submit({ sourceKey: "one", target })).toBe(true);
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.disable();
  await flush();
  expect(await producer?.submit({ sourceKey: "two", target })).toBe(false);
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry.target).toEqual(target);
});
it("a plugin alert's eligibility is asked again until delivery", async () => {
  const t = setup();
  let producer: ReturnType<Notifications["register"]> | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      producer = ctx.notifications.register({ id: "posts", label: "Posts" });
    },
  });
  await vi.waitFor(() => expect(producer).toBeDefined());
  t.permission("default");
  let eligible: boolean | "wait" = true;
  const held = { sourceKey: "held", target, eligible: () => eligible };
  expect(await producer?.submit(held)).toBe(true);
  await flush();
  eligible = false;
  t.permission("granted");
  await t.service.refreshPermission();
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
  eligible = "wait";
  expect(await producer?.submit({ ...held, sourceKey: "waiting" })).toBe(true);
  expect(
    await producer?.submit({
      sourceKey: "broken",
      target,
      eligible() {
        throw new Error("plugin bug");
      },
    }),
  ).toBe(true);
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
  eligible = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("plugin gates silence alerts until removed or the plugin is disabled", async () => {
  const t = setup();
  let gate: Notifications["gate"] | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      gate = (value) => ctx.notifications.gate(value);
      ctx.notifications.gate({
        id: "broken",
        allows() {
          throw new Error("skipped");
        },
      });
    },
  });
  await vi.waitFor(() => expect(gate).toBeDefined());
  const remove = gate?.({
    id: "solo",
    allows: (value) => value.kind === "conversation",
  });
  expect(t.service.gated(target)).toBe(false);
  expect(await t.submit("gated")).toBe(false);
  remove?.();
  expect(t.service.gated(target)).toBe(true);
  gate?.({ id: "solo", allows: () => false });
  expect(t.service.gated(target)).toBe(false);
  t.disable();
  await flush();
  expect(t.service.gated(target)).toBe(true);
  expect(await t.submit("released")).toBe(true);
});
it("a gate added while an alert is pending keeps it from showing", async () => {
  const t = setup();
  let gate: Notifications["gate"] | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      gate = (value) => ctx.notifications.gate(value);
    },
  });
  await vi.waitFor(() => expect(gate).toBeDefined());
  let ready: boolean | "wait" = "wait";
  expect(await t.submit("waiting", () => ready)).toBe(true);
  gate?.({ id: "solo", allows: () => false });
  ready = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
});
it("off takes effect despite storage failure and account preferences stay separate", () => {
  const t = setup();
  t.service.updatePreferences({ categories: { mention: false }, sound: false });
  t.service.selectViewer("b".repeat(64));
  expect(t.service.snapshot().preferences.sound).toBe(true);
  t.service.selectViewer(viewer);
  expect(t.service.snapshot().preferences.categories.mention).toBe(false);
  vi.spyOn(t.host.localStorage, "setItem").mockImplementation(() => {
    throw new Error("disk");
  });
  expect(t.service.updatePreferences({ enabled: false })).toBe(false);
  expect(t.service.snapshot().preferences.enabled).toBe(false);
  expect(t.service.snapshot().preferencesError).toContain("could not be saved");
});

it("a slow old permission probe cannot strand an alert after Allow completes", async () => {
  const t = setup();
  await flush();
  t.permission("default");
  let release!: (permission: NotificationPermissionState) => void;
  vi.mocked(t.platform.permission).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.submit();
  await flush();
  t.permission("granted");
  await t.service.requestPermission();
  await flush();
  release("default");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});

it("late platform errors report without retry and stay fenced to their account lifetime", async () => {
  const t = setup();
  await t.submit();
  await flush();
  t.failures[0]?.(new Error("Late display failure"));
  expect(t.service.snapshot().error).toBe("Late display failure");
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.service.selectViewer("b".repeat(64));
  t.failures[0]?.(new Error("Old account failure"));
  expect(t.service.snapshot().error).toBeNull();
  await t.ctx.fiber.dispose();
  t.failures[0]?.(new Error("Disposed failure"));
  expect(t.service.snapshot().error).toBeNull();
});
it("plays the selected per-category sound once delivery is accepted", async () => {
  const t = setup();
  t.service.updatePreferences({
    sounds: {
      mention: "ping",
      direct: "unison",
      thread: "doop",
      agent: "doodone",
    },
  });
  await t.submit("one");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  expect(t.plays).toEqual(["ping"]);
  // Plugin categories have no per-category choice; they use the default sound.
  await t.service.admit(
    "updates",
    "Updates",
    { sourceKey: "two", target },
    () => true,
  );
  await flush();
  expect(t.plays).toEqual(["ping", "flutter"]);
});
it("sound off delivers silently and a failed submission never plays", async () => {
  const t = setup();
  t.service.updatePreferences({ sound: false });
  await t.submit("one");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  expect(t.plays).toEqual([]);
  t.service.updatePreferences({ sound: true });
  vi.mocked(t.platform.show).mockRejectedValueOnce(
    new Error("SDK unavailable"),
  );
  await t.submit("two");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(2);
  expect(t.plays).toEqual([]);
  expect(t.service.snapshot().error).toBe("SDK unavailable");
});
it("a deferred submission revalidates the sound decision before playing", async () => {
  const t = setup();
  const releases: (() => void)[] = [];
  vi.mocked(t.platform.show).mockImplementation(
    (_item, activate, failed) =>
      new Promise<void>((resolve) => {
        t.clicks.push(activate);
        t.failures.push(failed);
        releases.push(resolve);
      }),
  );
  const settle = async () => {
    releases.shift()?.();
    await flush();
  };
  // Signing out or switching accounts while the submission is outstanding
  // must not leak the prior account's activity as audio.
  await t.submit("switched");
  await flush();
  t.service.selectViewer("b".repeat(64));
  await settle();
  expect(t.plays).toEqual([]);
  t.service.selectViewer(viewer);
  // Turning Sound off mid-flight cancels the outstanding decision — stickily:
  // restoring it before the submission resolves must not resurrect the sound.
  await t.submit("muted");
  await flush();
  t.service.updatePreferences({ sound: false });
  t.service.updatePreferences({ sound: true });
  await settle();
  expect(t.plays).toEqual([]);
  // Master alerts off → on mid-flight stays cancelled.
  await t.submit("alerts-toggled");
  await flush();
  t.service.updatePreferences({ enabled: false });
  t.service.updatePreferences({ enabled: true });
  await settle();
  expect(t.plays).toEqual([]);
  // A banner submitted while Sound was off stays silent after off → on.
  t.service.updatePreferences({ sound: false });
  await t.submit("resurrected");
  await flush();
  t.service.updatePreferences({ sound: true });
  await settle();
  expect(t.plays).toEqual([]);
  // Disabling the category mid-flight cancels the sound, even if re-enabled.
  await t.submit("category-off");
  await flush();
  t.service.updatePreferences({ categories: { mention: false } });
  t.service.updatePreferences({ categories: { mention: true } });
  await settle();
  expect(t.plays).toEqual([]);
  // Losing eligibility (access/producer revocation) mid-flight cancels it,
  // even when eligibility is restored before the submission resolves.
  let eligible: boolean | "wait" = true;
  await t.submit("revoked", () => eligible);
  await flush();
  eligible = false;
  t.service.revalidate();
  eligible = true;
  await settle();
  expect(t.plays).toEqual([]);
  // A native failure can arrive before the command promise resolves. It cancels
  // audio without retrying the accepted candidate.
  await t.submit("early-failure");
  await flush();
  t.failures.at(-1)?.(new Error("Backend rejected notification"));
  await settle();
  expect(t.plays).toEqual([]);
  expect(t.service.snapshot().error).toBe("Backend rejected notification");
  expect(t.platform.show).toHaveBeenCalledTimes(7);
  // An undisturbed deferred submission still plays exactly once.
  await t.submit("intact");
  await flush();
  expect(t.plays).toEqual([]);
  await settle();
  expect(t.plays).toEqual(["flutter"]);
});

it.each(["mention"] as const)(
  "Silent for %s preserves banners and other categories' audio across reload",
  async (category) => {
    const t = setup();
    t.service.updatePreferences({
      sounds: {
        ...t.service.snapshot().preferences.sounds,
        [category]: "silent",
      },
    });
    t.service.reloadPreferences();
    expect(t.service.snapshot().preferences.sounds[category]).toBe("silent");
    await t.service.admit(
      category,
      category,
      { sourceKey: "silent", target },
      () => true,
    );
    await flush();
    expect(t.platform.show).toHaveBeenCalledTimes(1);
    expect(t.plays).toEqual([]);
    const other = category === "mention" ? "direct" : "mention";
    await t.service.admit(
      other,
      other,
      { sourceKey: "audible", target },
      () => true,
    );
    await flush();
    expect(t.platform.show).toHaveBeenCalledTimes(2);
    expect(t.plays).toEqual(["flutter"]);
  },
);

it.each([true, false])(
  "Silent before=%s or during submission cannot resurrect pending audio",
  async (initiallySilent) => {
    const t = setup();
    const sounds = t.service.snapshot().preferences.sounds;
    if (initiallySilent)
      t.service.updatePreferences({ sounds: { ...sounds, mention: "silent" } });
    let release!: () => void;
    vi.mocked(t.platform.show).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await t.submit("pending");
    await flush();
    expect(t.platform.show).toHaveBeenCalledOnce();
    try {
      t.service.updatePreferences({ sounds: { ...sounds, mention: "silent" } });
      t.service.updatePreferences({ sounds });
    } finally {
      release();
      await flush();
    }
    expect(t.plays).toEqual([]);
  },
);

it("plugin display text is flattened and bounded, with the category text as fallback", async () => {
  const t = setup();
  let producer: ReturnType<Notifications["register"]> | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      producer = ctx.notifications.register({
        id: "updates",
        label: "Updates",
      });
    },
  });
  await vi.waitFor(() => expect(producer).toBeDefined());
  await producer?.submit({
    sourceKey: "rich",
    target,
    title: `Due\u0007 **now**\n${"t".repeat(200)}`,
    body: `**Call** [Ana](https://x.example)\n\n<b>raw</b> ${"b".repeat(300)}`,
  });
  await producer?.submit({ sourceKey: "plain", target });
  await expect(
    producer?.submit({ sourceKey: "bad", target, body: 1 as never }),
  ).rejects.toThrow("Invalid notification text");
  await flush();
  const shown = vi.mocked(t.platform.show).mock.calls.map(([item]) => item);
  const [rich = { title: "", body: "" }] = shown;
  expect(Array.from(rich.title)).toHaveLength(128);
  expect(rich.title.startsWith(`Due **now** ttt`)).toBe(true);
  expect(rich.title.endsWith("…")).toBe(true);
  expect(rich.body.startsWith("Call Ana <b>raw</b> bbb")).toBe(true);
  expect(Array.from(rich.body)).toHaveLength(200);
  expect(shown[1]).toMatchObject({ title: "Buzz", body: "New updates" });
});
