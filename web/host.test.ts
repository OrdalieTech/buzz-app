// @vitest-environment jsdom
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { expect, test } from "vitest";
import "./host.ts";

test("answers IPC in the page while isTauri() stays false", async () => {
  expect(isTauri()).toBe(false);
  expect(await invoke("relay_socket_connect", { relay: "wss://x" })).toBe(
    "public",
  );
  await expect(invoke("terminal_spawn")).rejects.toBe(
    "terminal_spawn isn't available in the browser.",
  );
});

test("delivers Channel messages through the installed callbacks", () => {
  const received: number[] = [];
  const channel = new Channel<number>((value) => received.push(value));
  const internals = Reflect.get(window, "__TAURI_INTERNALS__");
  internals.runCallback(channel.id, { index: 0, message: 7 });
  expect(received).toEqual([7]);
});

test("hands an invite page's code to the join flow once", async () => {
  history.replaceState(null, "", "/invite/abc-123#buzz=x");
  expect(await invoke("deep_link_take")).toEqual([
    `buzz://join?relay=${encodeURIComponent(location.origin)}&code=abc-123`,
  ]);
  expect(location.pathname + location.hash).toBe("/#buzz=x");
  expect(await invoke("deep_link_take")).toEqual([]);
});
