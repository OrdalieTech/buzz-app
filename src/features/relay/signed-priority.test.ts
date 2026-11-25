// Reader-to-host priority propagation control contributed by Brain.

import { afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { ACTIVE_READS, createRelayReader } from "./reader";
import { API_ACTIVE_LIMIT } from "./http-admission";
import { hostSigner } from "./testing";
afterEach(() => {
  vi.useRealTimers();
});
it("production reader prioritizes queued work at real capacity, not a clock interval", async () => {
  vi.useFakeTimers();
  const calls: number[] = [];
  const release: Array<() => void> = [];
  const signer = hostSigner(undefined, async (_url, body) => {
    calls.push(JSON.parse(body)[0].limit);
    await new Promise<void>((resolve) => release.push(resolve));
    return Response.json([]);
  });
  const t = await connectSignedTransport(
    signer,
    "https://priority-review.test",
    "relay",
  );
  const r = createRelayReader(t);
  try {
    const active = Array.from({ length: ACTIVE_READS }, (_, i) =>
      r.reader.read([{ kinds: [0], limit: i + 1 }]),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(ACTIVE_READS));
    const b = r.reader.read([{ kinds: [0], limit: ACTIVE_READS + 1 }], {
      priority: "background",
    });
    const f = r.reader.read([{ kinds: [0], limit: ACTIVE_READS + 2 }], {
      priority: "foreground",
    });
    release.shift()?.();
    await vi.waitFor(() => expect(calls).toHaveLength(ACTIVE_READS + 1));
    expect(calls.at(-1)).toBe(ACTIVE_READS + 2);
    release.shift()?.();
    await vi.waitFor(() => expect(calls).toHaveLength(ACTIVE_READS + 2));
    expect(calls.at(-1)).toBe(ACTIVE_READS + 1);
    for (const finish of release) finish();
    await Promise.all([...active, b, f]);
  } finally {
    r.dispose();
  }
});

it("signed transport forwards query priority to host request admission", async () => {
  const calls: number[] = [];
  const release: Array<() => void> = [];
  const t = await connectSignedTransport(
    hostSigner(undefined, async (_url, body) => {
      calls.push(JSON.parse(body)[0].limit);
      await new Promise<void>((resolve) => release.push(resolve));
      return Response.json([]);
    }),
    "https://priority-forwarding.test",
    "relay",
  );
  const active = Array.from({ length: API_ACTIVE_LIMIT }, (_, i) =>
    t.query([{ kinds: [0], limit: i + 1 }]),
  );
  await vi.waitFor(() => expect(calls).toHaveLength(API_ACTIVE_LIMIT));
  const background = t.query(
    [{ kinds: [0], limit: API_ACTIVE_LIMIT + 1 }],
    undefined,
    "read",
    "background",
  );
  const foreground = t.query(
    [{ kinds: [0], limit: API_ACTIVE_LIMIT + 2 }],
    undefined,
    "read",
    "foreground",
  );
  release.shift()?.();
  await vi.waitFor(() => expect(calls).toHaveLength(API_ACTIVE_LIMIT + 1));
  expect(calls.at(-1)).toBe(API_ACTIVE_LIMIT + 2);
  release.shift()?.();
  await vi.waitFor(() => expect(calls).toHaveLength(API_ACTIVE_LIMIT + 2));
  expect(calls.at(-1)).toBe(API_ACTIVE_LIMIT + 1);
  for (const finish of release) finish();
  await Promise.all([...active, background, foreground]);
});
