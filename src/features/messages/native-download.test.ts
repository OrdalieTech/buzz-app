import { beforeEach, expect, it, vi } from "vitest";

const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Each test gets the module's listener state fresh, as a new window does.
beforeEach(() => {
  vi.resetModules();
  listen.mockReset();
});

it("serves every card in a window from one host listener", async () => {
  let emit = () => {};
  listen.mockImplementation(async (_event: string, handler: () => void) => {
    emit = handler;
  });
  const { subscribeSavedDownloads } = await import("./native-download");
  const first = vi.fn();
  const second = vi.fn();
  const stop = subscribeSavedDownloads(first);
  subscribeSavedDownloads(second);
  expect(listen).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledWith(
    "saved-downloads-changed",
    expect.any(Function),
  );
  emit();
  stop();
  emit();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
});

it("takes changes from a window's own channel without listening for host events", async () => {
  const { savedDownloadsFromChannel, subscribeSavedDownloads } = await import(
    "./native-download"
  );
  const changed = savedDownloadsFromChannel();
  const card = vi.fn();
  subscribeSavedDownloads(card);
  expect(listen).not.toHaveBeenCalled();
  changed();
  expect(card).toHaveBeenCalledTimes(1);
});
