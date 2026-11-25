// Signed host-request admission controls, originally contributed by Brain.

import { assert, afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { API_ACTIVE_LIMIT, ApiCapacity, ApiPaused } from "./http-admission";
import { PublishRejected } from "./outbox";
import { hostSigner, signed } from "./testing";
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
});
/** A host whose requests stay in flight until released. Like native IPC, an
 * in-flight request cannot be aborted. */
function heldHost() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bodies: string[] = [];
  const request = vi.fn(async (_url: string, body: string) => {
    bodies.push(body);
    await held;
    const value = JSON.parse(body);
    return Response.json(
      Array.isArray(value) ? [] : { accepted: true, event_id: value.id },
    );
  });
  return { signer: hostSigner(undefined, request), request, bodies, release };
}

it("host requests start together without an admission timer", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const t = await connectSignedTransport(
    hostSigner(undefined, async () => {
      starts.push(performance.now());
      return Response.json([]);
    }),
    "https://fast-sign.test",
    "relay",
  );
  const p = Array.from({ length: 4 }, (_, i) =>
    t.query([{ kinds: [0], limit: i + 1 }]),
  );
  await tick();
  expect(starts).toEqual(Array(4).fill(starts[0]));
  expect(vi.getTimerCount()).toBe(0);
  await Promise.all(p);
});

it("work queued for dispatch cannot bypass a newly learned shared cooldown; refused publication is unsent and manual retry preserves the signed message", async () => {
  vi.useFakeTimers();
  const host = heldHost();
  const event = signed(host.signer.key, {
    kind: 9,
    content: "exact",
    tags: [["h", "c"]],
  });
  host.request.mockImplementationOnce(async (_url, body) => {
    host.bodies.push(body);
    return Response.json(
      { error: "rate-limited: quota exceeded; retry in 2s" },
      { status: 429 },
    );
  });
  const t = await connectSignedTransport(
    host.signer,
    "https://pause-during-dispatch.test",
    "relay",
  );
  assert.exists(t.writer);
  const paused = t.query([{ kinds: [0], limit: 1 }]).catch((error) => error);
  const active = Array.from({ length: API_ACTIVE_LIMIT - 1 }, () =>
    t.query([{ kinds: [0], limit: 1 }]),
  );
  const queuedRead = t.query([{ kinds: [0], limit: 2 }]);
  const queuedPublish = t.writer.publish(event, new AbortController().signal);
  const readRejected = expect(queuedRead).rejects.toBeInstanceOf(ApiPaused);
  const publishRejected =
    expect(queuedPublish).rejects.toBeInstanceOf(PublishRejected);
  await tick();
  expect(await paused).toMatchObject({
    status: 429,
    retryAfterMs: expect.any(Number),
  });
  await readRejected;
  await publishRejected;
  host.release();
  await Promise.all(active);
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT);
  await vi.advanceTimersByTimeAsync(60000);
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT); // No automatic resend.
  await t.writer.publish(event, new AbortController().signal);
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT + 1);
  expect(host.bodies.at(-1)).toBe(JSON.stringify(event));
});

it("cancelled while queued for dispatch never reaches the host or blocks the next signed read", async () => {
  vi.useFakeTimers();
  const host = heldHost();
  const t = await connectSignedTransport(
    host.signer,
    "https://cancel-sign.test",
    "relay",
  );
  const active = Array.from({ length: API_ACTIVE_LIMIT }, () =>
    t.query([{ kinds: [0], limit: 1 }]),
  );
  await tick();
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT);
  const controller = new AbortController();
  const cancelled = t.query([{ kinds: [0], limit: 2 }], controller.signal);
  const rejected = expect(cancelled).rejects.toMatchObject({
    name: "AbortError",
  });
  await tick();
  controller.abort();
  await rejected;
  host.release();
  await Promise.all(active);
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT);
  await t.query([{ kinds: [0], limit: 3 }]);
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT + 1);
  expect(host.bodies.at(-1)).toBe(JSON.stringify([{ kinds: [0], limit: 3 }]));
  expect(vi.getTimerCount()).toBe(0);
});

it("host request ownership is bounded across signed constructor recreation", async () => {
  vi.useFakeTimers();
  const host = heldHost();
  const t = await connectSignedTransport(
    host.signer,
    "https://bounded-sign.test",
    "relay",
  );
  const controller = new AbortController();
  const reads = Array.from({ length: 128 }, (_, i) =>
    t
      .query([{ kinds: [0], limit: i + 1 }], controller.signal)
      .catch((error) => error),
  );
  await tick();
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT);
  const replacement = await connectSignedTransport(
    { ...host.signer },
    "https://bounded-sign.test/",
    "relay",
  );
  await expect(
    replacement.query([{ kinds: [0], limit: 129 }]),
  ).rejects.toBeInstanceOf(ApiCapacity);
  controller.abort();
  await tick();
  // Queued work releases its ownership; in-flight host requests keep their
  // slots until they settle.
  const next = replacement.query([{ kinds: [0], limit: 1 }]);
  await tick();
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT);
  host.release();
  await next;
  expect(host.request).toHaveBeenCalledTimes(API_ACTIVE_LIMIT + 1);
  // Queued reads never reached the host; the in-flight ones settled through it.
  const queued = (await Promise.all(reads)).slice(API_ACTIVE_LIMIT);
  expect(queued.every((error) => error.name === "AbortError")).toBe(true);
});
