import { afterEach, expect, it, vi } from "vitest";
import { createUnreadIndicator, type IndicatorPermission } from "./indicator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
});
function setup(initial: IndicatorPermission = "enabled") {
  const permission = vi.fn(
    async (_request: boolean): Promise<IndicatorPermission> => initial,
  );
  const set = vi.fn(async (_unread: boolean) => {});
  const host = new EventTarget();
  const dock = createUnreadIndicator({ permission, set }, host);
  cleanups.push(dock.dispose);
  return { dock, set, permission, host };
}
it("silently checks on startup and projects unread after allow, independently of alert preferences", async () => {
  const h = setup("default");
  h.dock.setUnread(true);
  await h.dock.refresh();
  expect(h.permission.mock.calls).toEqual([[false]]);
  expect(h.set.mock.calls).toEqual([[false]]);
  h.permission.mockResolvedValueOnce("enabled");
  await h.dock.request();
  expect(h.permission.mock.calls).toEqual([[false], [true]]);
  expect(h.set.mock.calls).toEqual([[false], [true]]);
  h.dock.setUnread(false);
  await h.dock.dispose();
  expect(h.set).toHaveBeenLastCalledWith(false);
});
it.each(["default", "setup", "disabled", "denied", "unavailable"] as const)(
  "withholds the dot for %s and clears on changed system permission",
  async (permission) => {
    const h = setup();
    await h.dock.refresh();
    h.dock.setUnread(true);
    await vi.waitFor(() => expect(h.set).toHaveBeenLastCalledWith(true));
    h.permission.mockResolvedValueOnce(permission);
    await h.dock.refresh();
    expect(h.set).toHaveBeenLastCalledWith(false);
    h.dock.setUnread(true);
    expect(h.set).toHaveBeenLastCalledWith(false);
  },
);
it("refreshes on focus, fails closed, reports errors, and only retries on a later action", async () => {
  const h = setup();
  await h.dock.refresh();
  h.dock.setUnread(true);
  const count = h.permission.mock.calls.length;
  h.permission.mockRejectedValueOnce(new Error("OS unavailable"));
  h.host.dispatchEvent(new Event("focus"));
  await h.dock.refresh();
  expect(h.dock.snapshot()).toMatchObject({
    permission: "unavailable",
    error: "OS unavailable",
  });
  expect(h.set).toHaveBeenLastCalledWith(false);
  expect(h.permission).toHaveBeenCalledTimes(count + 1);
  await h.dock.refresh();
  expect(h.dock.snapshot()).toMatchObject({
    permission: "enabled",
    error: null,
  });
  expect(h.set).toHaveBeenLastCalledWith(true);
});
it("coalesces rapid changes behind one pending native write and makes teardown clear win", async () => {
  const h = setup();
  await h.dock.refresh();
  const pending = deferred<void>();
  h.set.mockImplementationOnce(() => pending.promise);
  h.dock.setUnread(true);
  expect(h.set.mock.calls).toEqual([[false], [true]]);
  h.dock.setUnread(false);
  h.dock.setUnread(true);
  const closing = h.dock.dispose();
  h.dock.setUnread(true);
  expect(h.set.mock.calls).toEqual([[false], [true]]);
  pending.resolve();
  await closing;
  expect(h.set.mock.calls).toEqual([[false], [true], [false]]);
  const count = h.permission.mock.calls.length;
  h.host.dispatchEvent(new Event("focus"));
  await h.dock.refresh();
  expect(h.permission).toHaveBeenCalledTimes(count);
});
it("late permission completion cannot revive a disposed badge", async () => {
  const h = setup();
  await h.dock.refresh();
  const pending = deferred<IndicatorPermission>();
  h.permission.mockImplementationOnce(() => pending.promise);
  const check = h.dock.request();
  h.dock.setUnread(true);
  await h.dock.dispose();
  pending.resolve("enabled");
  await check;
  expect(h.set).toHaveBeenLastCalledWith(false);
});
it("reports native write failure without a retry loop and accepts a later current-intent action", async () => {
  const h = setup();
  await h.dock.refresh();
  h.set.mockRejectedValueOnce(new Error("Dock unavailable"));
  h.dock.setUnread(true);
  await vi.waitFor(() =>
    expect(h.dock.snapshot().error).toBe("Dock unavailable"),
  );
  expect(h.set.mock.calls).toEqual([[false], [true]]);
  await h.dock.refresh();
  expect(h.set.mock.calls).toEqual([[false], [true], [true]]);
});
it("a re-read starts behind a check already in flight, so that check's earlier answer does not stand", async () => {
  const h = setup("default");
  await h.dock.refresh();
  h.dock.setUnread(true);
  // A focus check sent while the system prompt was still unanswered.
  const earlier = deferred<IndicatorPermission>();
  h.permission.mockImplementationOnce(() => earlier.promise);
  h.host.dispatchEvent(new Event("focus"));
  let reread: Promise<void>;
  try {
    await vi.waitFor(() => expect(h.permission).toHaveBeenCalledTimes(2));
    // Allowed. Two re-reads asked for meanwhile share one native read.
    h.permission.mockResolvedValue("enabled");
    reread = h.dock.reread();
    void h.dock.reread();
    expect(h.permission).toHaveBeenCalledTimes(2);
  } finally {
    earlier.resolve("denied");
  }
  await reread;
  expect(h.permission.mock.calls).toEqual([[false], [false], [false]]);
  expect(h.dock.snapshot().permission).toBe("enabled");
  await vi.waitFor(() => expect(h.set).toHaveBeenLastCalledWith(true));
  expect(h.set.mock.calls).toEqual([[false], [true]]);
});
it("keeps an explicit request when a focus check was already pending", async () => {
  const h = setup("default");
  await h.dock.refresh();
  const pending = deferred<IndicatorPermission>();
  h.permission.mockImplementationOnce(() => pending.promise);
  const check = h.dock.refresh();
  const request = h.dock.request();
  pending.resolve("default");
  await check;
  await request;
  expect(h.permission.mock.calls).toEqual([[false], [false], [true]]);
});
