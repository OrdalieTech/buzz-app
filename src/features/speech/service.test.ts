import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "../relay/testing";
import { type Connect, listenHosted } from "./listen";
import {
  SPEECH_PROVIDER_KEY,
  SpeechService,
  type SpeechProvider,
  type SpeechProviderStatus,
} from "./service";

vi.mock("./listen", async (original) => ({
  ...(await original<typeof import("./listen")>()),
  listenHosted: vi.fn(() => ({ stop() {}, cancel() {} })),
}));

beforeEach(() => {
  vi.mocked(listenHosted).mockClear();
});
afterEach(() => vi.useRealTimers());

const BUILDERLAB = "block.builderlab/builderlab";
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  } as unknown as Storage & { values: Map<string, string> };
}
async function setup(storage: Storage = memory()) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new SpeechService(root, storage);
  const plugin = async (id: string, provider: Partial<SpeechProvider>) => {
    const fiber = root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => ctx.speech.registerProvider(fake(provider)));
    await fiber.await();
    await flush();
    return fiber;
  };
  await flush();
  return { root, service, plugin };
}
function fake(provider: Partial<SpeechProvider>): SpeechProvider {
  return {
    id: "main",
    label: "Fake",
    description: "A test provider.",
    status: () => "ready",
    subscribe: () => () => {},
    connect: async () => ({ outcome: "answered", sdp: "answer" }),
    ...provider,
  };
}
/** The connect that the service hands the hosted listen. */
function lastConnect(): Connect {
  const call = vi.mocked(listenHosted).mock.calls.at(-1);
  if (!call) throw new Error("no hosted listen");
  return call[1];
}

it("listens with Builderlab by default, and reports none without it", async () => {
  const { service, plugin } = await setup();
  expect(service.backend()).toBeUndefined();
  expect(service.status()).toBe("unavailable");
  const onError = vi.fn();
  const onState = vi.fn();
  service.listen({ onText() {}, onEnd() {}, onError, onState });
  await flush();
  expect(onError).toHaveBeenCalledWith("unavailable", expect.any(String));
  expect(onState).toHaveBeenCalledWith("idle");
  expect(listenHosted).not.toHaveBeenCalled();

  // Another provider never listens without the user's choice.
  await plugin("example.speech", { label: "Example", order: -1 });
  expect(service.backend()).toBeUndefined();

  await plugin("block.builderlab", { id: "builderlab", label: "Builderlab" });
  expect(service.backend()).toBe(BUILDERLAB);
  expect(service.providers().map((each) => each.key)).toEqual([
    "example.speech/main",
    BUILDERLAB,
  ]);
  service.listen({ onText() {}, onEnd() {} });
  expect(listenHosted).toHaveBeenCalledOnce();
});

it("follows the default provider's status", async () => {
  let status: SpeechProviderStatus = "checking";
  const listeners = new Set<() => void>();
  const { service, plugin } = await setup();
  await plugin("block.builderlab", {
    id: "builderlab",
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
  expect(service.status()).toBe("checking");
  status = "needs-setup";
  const changed = vi.fn();
  service.subscribe(changed);
  for (const listener of listeners) listener();
  expect(changed).toHaveBeenCalled();
  expect(service.status()).toBe("needs-setup");
  status = "ready";
  expect(service.status()).toBe("ready");
  expect(service.backend()).toBe(BUILDERLAB);
});

it("keeps the user's choice, and never sends speech elsewhere while it is missing", async () => {
  const storage = memory();
  const first = await setup(storage);
  await first.plugin("block.builderlab", { id: "builderlab" });
  const fiber = await first.plugin("example.speech", { label: "Example" });
  first.service.setBackend("example.speech/main");
  expect(storage.getItem(SPEECH_PROVIDER_KEY)).toBe("example.speech/main");
  first.service.setBackend("nobody/else");
  expect(first.service.backend()).toBe("example.speech/main");

  // Builderlab, the default, does not take over.
  fiber.dispose();
  await flush();
  expect(first.service.backend()).toBeUndefined();
  expect(first.service.status()).toBe("unavailable");

  // After a reload, the saved choice holds once its plugin registers again.
  const second = await setup(storage);
  await second.plugin("block.builderlab", { id: "builderlab" });
  expect(second.service.backend()).toBeUndefined();
  await second.plugin("example.speech", {});
  expect(second.service.backend()).toBe("example.speech/main");
});

it("falls back to the default after a plugin retires its saved provider", async () => {
  const storage = memory({ [SPEECH_PROVIDER_KEY]: "example.speech/old" });
  const { root, service, plugin } = await setup(storage);
  await plugin("block.builderlab", { id: "builderlab" });
  expect(service.backend()).toBeUndefined();
  const scoped = root.extend({ pluginOwner: { id: "other", revision: "1" } });
  scoped.speech.retireProvider("old");
  expect(service.backend()).toBeUndefined();
  const owner = root.extend({
    pluginOwner: { id: "example.speech", revision: "1" },
  });
  expect(() => owner.speech.retireProvider("a/b")).toThrow();
  owner.speech.retireProvider("old");
  expect(storage.getItem(SPEECH_PROVIDER_KEY)).toBeNull();
  expect(service.backend()).toBe(BUILDERLAB);
  expect(() => root.speech.retireProvider("old")).toThrow();
});

it("asks for a call length only when the caller sets a valid one, and returns the granted cap", async () => {
  const connect = vi.fn<SpeechProvider["connect"]>(async () => ({
    outcome: "answered",
    sdp: "v=0 answer",
    maxSeconds: 900,
  }));
  const { service, plugin } = await setup();
  await plugin("block.builderlab", { id: "builderlab", connect });
  const signal = new AbortController().signal;

  service.listen({ maxSeconds: 3_600, onText() {}, onEnd() {} });
  await expect(lastConnect()("offer", signal)).resolves.toEqual({
    outcome: "answered",
    sdp: "v=0 answer",
    maxSeconds: 900,
  });
  expect(connect).toHaveBeenLastCalledWith(
    { offer: "offer", maxSeconds: 3_600, timeoutMs: 20_000 },
    { signal: expect.any(AbortSignal) },
  );

  // A voice command sets none, so the provider's default applies.
  for (const maxSeconds of [undefined, 0, -5, 1.5, Number.NaN]) {
    service.listen({
      ...(maxSeconds === undefined ? {} : { maxSeconds }),
      onText() {},
      onEnd() {},
    });
    await lastConnect()("offer", signal);
    expect(connect).toHaveBeenLastCalledWith(
      { offer: "offer", timeoutMs: 20_000 },
      { signal: expect.any(AbortSignal) },
    );
  }

  // A cap that is not whole seconds is dropped from the reply.
  connect.mockResolvedValueOnce({
    outcome: "answered",
    sdp: "v=0 answer",
    maxSeconds: -1,
  });
  service.listen({ onText() {}, onEnd() {} });
  await expect(lastConnect()("offer", signal)).resolves.toEqual({
    outcome: "answered",
    sdp: "v=0 answer",
  });
});

it("passes the offer and community to the provider and checks its reply", async () => {
  const connect = vi.fn<SpeechProvider["connect"]>(async () => ({
    outcome: "answered",
    sdp: "v=0 answer",
  }));
  const { service, plugin } = await setup();
  await plugin("block.builderlab", { id: "builderlab", connect });
  service.listen({
    community: "wss://relay.example.org",
    onText() {},
    onEnd() {},
  });
  const signal = new AbortController().signal;
  await expect(lastConnect()("offer", signal)).resolves.toEqual({
    outcome: "answered",
    sdp: "v=0 answer",
  });
  expect(connect).toHaveBeenCalledWith(
    { offer: "offer", community: "wss://relay.example.org", timeoutMs: 20_000 },
    { signal: expect.any(AbortSignal) },
  );

  const replies: unknown[] = [
    { outcome: "failed", reason: "rate_limited" },
    { outcome: "failed", reason: "made_up" },
    { outcome: "answered", sdp: "" },
    "nonsense",
  ];
  for (const reply of replies) {
    connect.mockResolvedValueOnce(reply as never);
    service.listen({ onText() {}, onEnd() {} });
    replies[replies.indexOf(reply)] = await lastConnect()("offer", signal);
  }
  connect.mockRejectedValueOnce(new Error("boom"));
  service.listen({ onText() {}, onEnd() {} });
  replies.push(await lastConnect()("offer", signal));
  expect(replies.map((reply) => (reply as { reason: string }).reason)).toEqual([
    "rate_limited",
    "invalid_response",
    "invalid_response",
    "invalid_response",
    "service_error",
  ]);
});

it("stops waiting at the deadline and when the listen ends", async () => {
  let seen: AbortSignal | undefined;
  const connect = vi.fn<SpeechProvider["connect"]>((_, { signal }) => {
    seen = signal;
    return new Promise(() => {});
  });
  const { service, plugin } = await setup();
  await plugin("block.builderlab", { id: "builderlab", connect });
  vi.useFakeTimers();
  service.listen({ onText() {}, onEnd() {} });
  const reply = lastConnect()("offer", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(20_000);
  await expect(reply).resolves.toEqual({
    outcome: "failed",
    reason: "timeout",
  });
  expect(seen?.aborted).toBe(true);

  const ended = new AbortController();
  service.listen({ onText() {}, onEnd() {} });
  const cancelled = lastConnect()("offer", ended.signal);
  ended.abort();
  await expect(cancelled).resolves.toEqual({
    outcome: "failed",
    reason: "timeout",
  });
  expect(seen?.aborted).toBe(true);
});
