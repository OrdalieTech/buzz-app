import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, expect, it, vi } from "vitest";
import { PublishRejected } from "./outbox";
import { ReadError } from "./errors";
import { createRelaySession } from "./session";
import {
  archiveRelay,
  keypair,
  signed,
  scriptedTransport,
  roster,
  type Key,
} from "./testing";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { archiveHides, UnattestedProfile } from "./identity-archives";

const viewer = keypair(),
  relay = keypair(),
  other = keypair(),
  target = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const owner of owners.splice(0)) owner.dispose();
});
function snapshot(time = 1, keys = [target.pubkey]) {
  return signed(relay, {
    kind: 13535,
    created_at: time,
    content: "",
    tags: [["-"], ...keys.map((key) => ["p", key])],
  });
}
function harness(authority: string | null = relay.pubkey) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const query = vi.fn(wire.transport.query);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    query,
    ...(authority ? { archiveAuthority: authority } : {}),
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return { ...owner, wire, query, live, archives: owner.session.archives };
}
async function read(h: ReturnType<typeof harness>, events: RelayEvent[]) {
  const pending = h.archives.refresh();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond(events);
  await pending;
}
it("is lazy, exact-author, fresh, bounded and background through the actual session", async () => {
  const h = harness();
  expect(h.query).not.toHaveBeenCalled();
  expect(h.archives.state(target.pubkey)).toBe("unknown");
  const first = h.archives.ensure();
  expect(h.archives.ensure()).toBe(first);
  const request = h.wire.next();
  expect(request.filters).toEqual([
    { kinds: [13535], authors: [relay.pubkey], limit: 1 },
  ]);
  expect(h.query.mock.calls[0]?.[3]).toBe("background");
  request.respond([snapshot()]);
  await first;
  expect(h.archives.state(target.pubkey)).toBe("archived");
  expect(h.archives.state(other.pubkey)).toBe("not-archived");
  expect(h.archives.state("invalid")).toBe("unknown");
  expect(Object.isFrozen(h.archives.snapshot().archived)).toBe(true);
  await h.archives.ensure();
  expect(h.query).toHaveBeenCalledTimes(1);
  const previous = h.session.read([
    { kinds: [13535], authors: [relay.pubkey], limit: 1 },
  ]);
  const oldRequest = h.wire.next();
  const refresh = h.archives.refresh();
  h.wire.next().respond([snapshot(2, [])]);
  await refresh;
  oldRequest.respond([snapshot()]);
  await previous;
  expect(h.archives.state(target.pubkey)).toBe("not-archived");
  expect(h.query).toHaveBeenCalledTimes(3);
});
it("session recovery respects archive admission delays and stops after success", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.live.state({ status: "connected", routes: [] });
  const first = h.archives.ensure();
  const request = h.wire.next();
  request.fail(new ReadError("unavailable", "quota", 429, 60_000));
  await first;
  expect(h.archives.snapshot()).toMatchObject({
    status: "error",
    transient: true,
    retryAt: Date.now() + 60_000,
  });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(h.query).toHaveBeenCalledTimes(1);
  // The existing recovery owner retries on its next capped backoff turn.
  for (let tick = 0; tick < 10 && !h.wire.pending.length; tick++)
    await vi.advanceTimersToNextTimerAsync();
  expect(h.wire.pending).toHaveLength(1);
  expect(Date.now()).toBeGreaterThanOrEqual(h.archives.snapshot().retryAt ?? 0);
  h.wire.next().respond([snapshot()]);
  await h.archives.ensure();
  expect(h.archives.snapshot().status).toBe("ready");
  const count = h.query.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.query).toHaveBeenCalledTimes(count);
});
it("retains an active transient failure across socket loss until HTTP recovery", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.live.state({ status: "connected", routes: [] });
  const first = h.archives.ensure();
  for (let attempt = 0; attempt < 4; attempt++) {
    h.wire.next().fail(new ReadError("unavailable", "offline", 503));
    if (attempt < 3) await vi.advanceTimersToNextTimerAsync();
  }
  await first;
  h.live.state({ status: "retrying", routes: [] });
  expect(h.archives.snapshot()).toMatchObject({
    status: "error",
    transient: true,
  });
  await vi.advanceTimersToNextTimerAsync();
  h.wire.next().respond([snapshot()]);
  await h.archives.ensure();
  expect(h.archives.state(target.pubkey)).toBe("archived");
  expect(h.query).toHaveBeenCalledTimes(5);
});

it("defers new sidebar recovery reads during socket loss", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.live.state({ status: "connected", routes: [] });
  const first = h.archives.ensure({ background: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    h.wire.next().fail(new ReadError("unavailable", "offline", 503));
    if (attempt < 3) await vi.advanceTimersToNextTimerAsync();
  }
  await first;
  h.live.state({ status: "retrying", routes: [] });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.archives.snapshot()).toMatchObject({
    status: "error",
    transient: true,
  });
  expect(h.query).toHaveBeenCalledTimes(4);
  h.live.state({ status: "connected", routes: [] });
  h.wire.next().respond([snapshot()]);
  await h.archives.ensure({ background: true });
  expect(h.archives.state(target.pubkey)).toBe("archived");
  expect(h.query).toHaveBeenCalledTimes(5);
});

it("reconciles an active read completed during an outage on reconnect", async () => {
  const h = harness();
  h.live.state({ status: "connected", routes: [] });
  const first = h.archives.ensure({ background: true });
  const held = h.wire.next();
  expect(h.archives.ensure()).toBe(first);
  h.live.state({ status: "retrying", routes: [] });
  held.respond([snapshot()]);
  await first;
  expect(h.archives.state(target.pubkey)).toBe("archived");
  h.live.state({ status: "connected", routes: [] });
  expect(h.archives.snapshot().status).toBe("idle");
  const reconciled = h.archives.ensure({ background: true });
  h.wire.next().respond([snapshot(2, [])]);
  await reconciled;
  expect(h.archives.state(target.pubkey)).toBe("not-archived");
  expect(h.query).toHaveBeenCalledTimes(2);
});
it("retires an in-flight read released across reconnect and rereads once", async () => {
  const h = harness();
  h.live.state({ status: "connected", routes: [] });
  const first = h.archives.ensure({ background: true });
  const held = h.wire.next();
  h.live.state({ status: "retrying", routes: [] });
  h.live.state({ status: "connected", routes: [] });
  expect(h.archives.snapshot().status).toBe("loading");
  held.respond([snapshot()]);
  await first;
  // Visibility keeps the old list; no consumer may treat it as current.
  expect(h.archives.snapshot()).toMatchObject({
    status: "idle",
    archived: [target.pubkey],
  });
  expect(h.archives.state(target.pubkey)).toBe("unknown");
  expect(h.query).toHaveBeenCalledTimes(1);
  const reconciled = h.archives.ensure({ background: true });
  h.wire.next().respond([snapshot(2, [])]);
  await reconciled;
  expect(h.archives.state(target.pubkey)).toBe("not-archived");
  expect(h.archives.snapshot().status).toBe("ready");
  expect(h.query).toHaveBeenCalledTimes(2);
});
it.each(["sidebar", "active"] as const)(
  "keeps %s recovery demand through a socket drop",
  async (demand) => {
    const background = demand === "sidebar";
    vi.useFakeTimers();
    const h = harness();
    h.live.state({ status: "connected", routes: [] });
    const initial = h.archives.ensure({ background });
    for (let attempt = 0; attempt < 4; attempt++) {
      h.wire.next().fail(new ReadError("unavailable", "offline", 503));
      if (attempt < 3) await vi.advanceTimersToNextTimerAsync();
    }
    await initial;
    expect(h.archives.snapshot()).toMatchObject({
      status: "error",
      transient: true,
    });
    await vi.advanceTimersToNextTimerAsync();
    const retry = h.wire.next();
    expect(h.query).toHaveBeenCalledTimes(5);
    h.live.state({ status: "retrying", routes: [] });
    expect(retry.signal?.aborted).toBe(false);
    if (!background) {
      retry.respond([snapshot()]);
      await h.archives.ensure();
      expect(h.archives.snapshot().status).toBe("ready");
      expect(h.query).toHaveBeenCalledTimes(5);
      return;
    }
    retry.respond([snapshot()]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.query).toHaveBeenCalledTimes(5);
    h.live.state({ status: "connected", routes: [] });
    const reconciliation = h.archives.ensure({ background: true });
    const resumed = h.wire.next();
    expect(h.query).toHaveBeenCalledTimes(6);
    resumed.respond([snapshot()]);
    await reconciliation;
    expect(h.archives.snapshot().status).toBe("ready");
  },
);
it.each(["startup", "reconnect"] as const)(
  "keeps an archive admission deadline through socket flaps after %s",
  async (phase) => {
    vi.useFakeTimers();
    const h = harness();
    if (phase === "reconnect")
      h.live.state({ status: "connected", routes: [] });
    const first = h.archives.ensure({ background: true });
    h.wire.next().fail(new ReadError("unavailable", "quota", 429, 60_000));
    await first;
    const deadline = Date.now() + 60_000;
    for (let flap = 0; flap < 4; flap++) {
      h.live.state({ status: "retrying", routes: [] });
      h.live.state({ status: "connected", routes: [] });
      void h.archives.ensure({ background: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.archives.snapshot().retryAt).toBe(deadline);
      expect(h.query).toHaveBeenCalledTimes(1);
    }
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.query).toHaveBeenCalledTimes(1);
    for (let tick = 0; tick < 10 && !h.wire.pending.length; tick++)
      await vi.advanceTimersToNextTimerAsync();
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    const retry = h.wire.next();
    retry.respond([snapshot()]);
    await h.archives.ensure();
    expect(h.archives.snapshot().status).toBe("ready");
  },
);
it.each(["background", "active"] as const)(
  "keeps a fresh admission deadline when a read held across reconnect fails (%s ensure)",
  async (demand) => {
    vi.useFakeTimers();
    const h = harness();
    h.live.state({ status: "connected", routes: [] });
    const first = h.archives.ensure({ background: true });
    const held = h.wire.next();
    h.live.state({ status: "retrying", routes: [] });
    h.live.state({ status: "connected", routes: [] });
    held.fail(new ReadError("unavailable", "quota", 429, 60_000));
    await first;
    const deadline = Date.now() + 60_000;
    expect(h.archives.snapshot()).toMatchObject({
      status: "error",
      transient: true,
      retryAt: deadline,
    });
    await h.archives.ensure({ background: demand === "background" });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.query).toHaveBeenCalledTimes(1);
    for (let tick = 0; tick < 10 && !h.wire.pending.length; tick++)
      await vi.advanceTimersToNextTimerAsync();
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    h.wire.next().respond([snapshot()]);
    await h.archives.ensure();
    expect(h.archives.state(target.pubkey)).toBe("archived");
  },
);
it.each([null, "invalid"])(
  "does not infer archive authority from relayAuthor (%s)",
  async (authority) => {
    const h = harness(authority);
    await h.archives.refresh();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.archives.snapshot().status).toBe("unavailable");
    expect(h.archives.state(target.pubkey)).toBe("unknown");
  },
);
it("replaces the whole list, ignores invalid p keys and extra p elements, and keeps relay scopes separate", async () => {
  const h = harness(),
    elsewhere = harness();
  await read(h, [
    signed(relay, {
      kind: 13535,
      created_at: 1,
      content: "",
      tags: [
        ["-"],
        ["p", target.pubkey, "ignored", other.pubkey],
        ["p", target.pubkey],
        ["p", "invalid"],
        ["p"],
        ["p", target.pubkey.toUpperCase()],
      ],
    }),
  ]);
  expect(h.archives.snapshot().archived).toEqual([target.pubkey]);
  expect(elsewhere.archives.state(target.pubkey)).toBe("unknown");
  await read(elsewhere, [snapshot(2, [])]);
  expect(elsewhere.archives.state(target.pubkey)).toBe("not-archived");
  await read(h, [snapshot(3, [other.pubkey])]);
  expect(h.archives.snapshot().archived).toEqual([other.pubkey]);
});
it.each([
  ["empty", () => []],
  [
    "wrong author",
    () => [signed(other, { kind: 13535, tags: [["-"]], content: "" })],
  ],
  [
    "wrong kind",
    () => [signed(relay, { kind: 8002, tags: [["-"]], content: "" })],
  ],
  [
    "missing protected marker",
    () => [signed(relay, { kind: 13535, content: "", tags: [] })],
  ],
  [
    "duplicate marker",
    () => [signed(relay, { kind: 13535, tags: [["-"], ["-"]], content: "" })],
  ],
  [
    "malformed marker",
    () => [signed(relay, { kind: 13535, tags: [["-", "extra"]], content: "" })],
  ],
  [
    "nonempty content",
    () => [signed(relay, { kind: 13535, tags: [["-"]], content: "secret" })],
  ],
  ["multiple snapshots", () => [snapshot(1), snapshot(2)]],
  [
    "oversize",
    () => [
      signed(relay, {
        kind: 13535,
        content: "",
        tags: [["-"], ["extra", "x".repeat(2 * 1024 * 1024)]],
      }),
    ],
  ],
] as const)(
  "%s evidence cannot present known active state; known archives stay hidden but unconfirmed",
  async (_label, events) => {
    const h = harness();
    await read(h, [snapshot()]);
    const { readAt } = h.archives.snapshot();
    await read(h, events());
    expect(h.archives.snapshot()).toMatchObject({
      status: "error",
      archived: [target.pubkey],
      readAt,
    });
    expect(h.archives.snapshot().error).not.toContain("secret");
    // Visibility keeps the known archive; deletion and confirmation, which
    // read state(), need a fresh read.
    expect(archiveHides(h.archives, target.pubkey, viewer.pubkey)).toBe(true);
    expect(h.archives.state(target.pubkey)).toBe("unknown");
    expect(h.archives.state(other.pubkey)).toBe("unknown");
  },
);
it("keeps the last known archives while rereading", async () => {
  const h = harness();
  await read(h, [snapshot()]);
  const pending = h.archives.refresh();
  expect(h.archives.snapshot()).toMatchObject({
    status: "loading",
    archived: [target.pubkey],
    readAt: expect.any(Number),
  });
  expect(archiveHides(h.archives, target.pubkey, viewer.pubkey)).toBe(true);
  expect(h.archives.state(target.pubkey)).toBe("unknown");
  expect(h.archives.state(other.pubkey)).toBe("unknown");
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond([snapshot(2, [])]);
  await pending;
  expect(h.archives.state(target.pubkey)).toBe("not-archived");
});
it("read failures redact payload and remain retryable", async () => {
  const h = harness();
  const pending = h.archives.refresh();
  h.wire.next().fail(new Error("secret upstream body"));
  await pending;
  expect(h.archives.snapshot().status).toBe("error");
  expect(h.archives.snapshot().error).not.toContain("secret");
  await read(h, [snapshot()]);
  expect(h.archives.state(target.pubkey)).toBe("archived");
});
it("archives no one before the relay's first snapshot, but never rolls back to none", async () => {
  const h = harness();
  await read(h, []);
  expect(h.archives.snapshot().status).toBe("ready");
  expect(h.archives.state(target.pubkey)).toBe("not-archived");
  await read(h, [snapshot()]);
  expect(h.archives.state(target.pubkey)).toBe("archived");
  await h.clearCache();
  await read(h, []);
  expect(h.archives.snapshot().status).toBe("error");
  expect(h.archives.state(target.pubkey)).toBe("unknown");
});
it("rejects rollback across refresh, failure and cache clear; permits the same head and lower-id tie winner", async () => {
  const h = harness();
  const a = snapshot(5),
    b = snapshot(5, []);
  const [winner, loser] = [a, b].sort((x, y) => x.id.localeCompare(y.id));
  if (!winner || !loser) throw new Error("fixture");
  await read(h, [loser]);
  await read(h, [winner]);
  expect(h.archives.snapshot().eventId).toBe(winner.id);
  await h.clearCache();
  await read(h, [snapshot(4)]);
  expect(h.archives.snapshot().status).toBe("error");
  await read(h, [loser]);
  expect(h.archives.snapshot().status).toBe("error");
  await read(h, [winner]);
  expect(h.archives.snapshot().eventId).toBe(winner.id);
  await read(h, [snapshot(6)]);
  expect(h.archives.snapshot().createdAt).toBe(6);
});
it.each(["cache", "dispose"] as const)(
  "%s invalidation fences late results and discards archive visibility",
  async (action) => {
    const h = harness();
    h.live.state({ status: "connected", routes: [] });
    await read(h, [snapshot()]);
    const pending = h.archives.refresh();
    const req = h.wire.next();
    if (action === "cache") await h.clearCache();
    else h.dispose();
    expect(req.signal?.aborted).toBe(true);
    expect(archiveHides(h.archives, target.pubkey, viewer.pubkey)).toBe(false);
    expect(h.archives.state(target.pubkey)).toBe("unknown");
    req.respond([snapshot(2)]);
    await pending;
    expect(h.archives.snapshot()).toMatchObject({
      status: action === "dispose" ? "unavailable" : "idle",
      archived: [],
    });
    expect(h.archives.snapshot().readAt).toBeUndefined();
    if (action === "dispose") {
      // Closing is not lack of support: callers must not read it as "none".
      expect(h.archives.supported).toBe(true);
      const calls = h.query.mock.calls.length;
      await h.archives.refresh();
      expect(h.query).toHaveBeenCalledTimes(calls);
    }
  },
);
it("retained historical messages remain visible when their author is archived", async () => {
  const h = harness();
  const message = signed(target, {
    kind: 9,
    content: "history",
    tags: [["h", "room"]],
  });
  const view = h.session.observe([{ kinds: [9], "#h": ["room"], limit: 20 }]);
  const refresh = view.refresh();
  h.wire.next().respond([message]);
  await refresh;
  await read(h, [snapshot()]);
  expect(view.snapshot().events.map((event) => event.id)).toContain(message.id);
  view.dispose();
});

it("the session deadline releases a held archive read without claiming anyone active", async () => {
  vi.useFakeTimers();
  const h = harness();
  const pending = h.archives.refresh();
  const req = h.wire.next();
  await vi.advanceTimersByTimeAsync(10_001);
  await pending;
  expect(req.signal?.aborted).toBe(true);
  expect(h.archives.snapshot().status).toBe("error");
  req.respond([snapshot()]);
  await Promise.resolve();
  expect(h.archives.state(target.pubkey)).toBe("unknown");
  await read(h, [snapshot(2)]);
  expect(h.archives.state(target.pubkey)).toBe("archived");
});
it("reentrant cache clear before dispatch prevents a read; a successor is not clobbered by the old completion", async () => {
  const h = harness();
  const stop = h.archives.subscribe(() => {
    if (h.archives.snapshot().status === "loading") void h.clearCache();
  });
  await h.archives.refresh();
  expect(h.query).not.toHaveBeenCalled();
  stop();
  const first = h.archives.refresh();
  const old = h.wire.next();
  await h.clearCache();
  const second = h.archives.refresh();
  const current = h.wire.next();
  old.respond([snapshot(3)]);
  await first;
  expect(h.archives.refresh()).toBe(second);
  current.respond([snapshot(2)]);
  await second;
  expect(h.archives.snapshot().createdAt).toBe(2);
});

function authTag(agent: Key, owner: Key, conditions = "") {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agent.pubkey}:${conditions}`)
    .digest();
  return [
    "auth",
    owner.pubkey,
    conditions,
    bytesToHex(schnorr.sign(new Uint8Array(digest), owner.secret)),
  ];
}
function attested(
  agent: Key,
  owner: Key,
  tags: string[][] = [],
  auth = [authTag(agent, owner)],
) {
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Agent", is_agent: true }),
    tags: [...auth, ...tags],
  });
}
function writable(fixture: ReturnType<typeof archiveRelay>) {
  const owner = createRelaySession(fixture.transport);
  owners.push(owner);
  return owner.session.archives;
}
it.each(
  (["archive", "unarchive"] as const).flatMap((action) =>
    (["consent", "sign", "confirmation"] as const).map((phase) => ({
      action,
      phase,
    })),
  ),
)(
  "socket transitions preserve $action during $phase over healthy HTTP",
  async ({ action, phase }) => {
    const fixture = archiveRelay(viewer, relay, [attested(target, viewer)]);
    if (action === "unarchive") fixture.archiveExternally(target.pubkey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: (signal: AbortSignal | undefined) => void;
    const entered = new Promise<AbortSignal | undefined>((resolve) => {
      started = resolve;
    });
    const writer = fixture.transport.identityArchive;
    if (!writer) throw new Error("fixture writer");
    const sign = writer.sign.bind(writer);
    writer.sign = async (template, signal) => {
      if (phase === "sign") {
        started(signal);
        await gate;
      }
      return sign(template, signal);
    };
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...fixture.transport,
      async query(filters, signal, ...rest) {
        if (
          (phase === "consent" &&
            filters.some((f) => f.kinds?.includes(13534))) ||
          (phase === "confirmation" &&
            filters.some((f) => f.kinds?.includes(13535)))
        ) {
          started(signal);
          await gate;
        }
        return fixture.transport.query(filters, signal, ...rest);
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    owners.push(owner);
    live.state({ status: "connected", routes: [] });
    live.state({ status: "retrying", routes: [] });
    const outcome = owner.session.archives.request(action, target.pubkey).then(
      () => undefined,
      (error: unknown) => error,
    );
    const signal = await entered;
    try {
      live.state({ status: "connected", routes: [] });
      expect(signal?.aborted).toBe(false);
      live.state({ status: "retrying", routes: [] });
      expect(signal?.aborted).toBe(false);
    } finally {
      release();
    }
    expect(await outcome).toBeUndefined();
    expect(fixture.published).toHaveLength(1);
    await owner.session.archives.ensure();
    expect(owner.session.archives.state(target.pubkey)).toBe(
      action === "archive" ? "archived" : "not-archived",
    );
  },
);

it("an active ensure reads healthy HTTP while the socket is down", async () => {
  const h = harness();
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  const active = h.archives.ensure();
  const req = h.wire.next();
  h.live.state({ status: "connected", routes: [] });
  expect(req.signal?.aborted).toBe(false);
  req.respond([snapshot()]);
  await active;
  // The reconnect landed mid-read, so the consumer's next demand rereads.
  expect(h.archives.snapshot()).toMatchObject({
    status: "idle",
    archived: [target.pubkey],
  });
  const reread = h.archives.ensure();
  h.wire.next().respond([snapshot()]);
  await reread;
  expect(h.archives.state(target.pubkey)).toBe("archived");
  expect(h.query).toHaveBeenCalledTimes(2);
});

it("channel-only revocation preserves the pending relay-wide archive read", async () => {
  const h = harness();
  h.live.state({ status: "connected", routes: [] });
  h.live.receive([roster(relay, "room", [viewer.pubkey], 1)]);
  const pending = h.archives.ensure();
  const req = h.wire.next();
  h.live.receive([roster(relay, "room", [], 2)]);
  expect(req.signal?.aborted).toBe(false);
  req.respond([snapshot()]);
  await pending;
  expect(h.archives.state(target.pubkey)).toBe("archived");
  expect(
    h.query.mock.calls.filter(([filters]) =>
      filters.some((f) => f.kinds?.includes(13535)),
    ),
  ).toHaveLength(1);
});
it("owner path attaches the target's exact live auth tag and confirms by re-read", async () => {
  const head = attested(target, viewer);
  const fixture = archiveRelay(viewer, relay, [head]);
  const archives = writable(fixture);
  expect(archives.writable).toBe(true);
  await archives.ensure();
  expect(archives.state(target.pubkey)).toBe("not-archived");
  await archives.request("archive", target.pubkey);
  const [event] = fixture.published;
  expect(event?.kind).toBe(9035);
  expect(event?.pubkey).toBe(viewer.pubkey);
  expect(event?.content).toBe("");
  expect(Math.abs((event?.created_at ?? 0) - Date.now() / 1000)).toBeLessThan(
    5,
  );
  expect(event?.tags).toEqual([
    ["-"],
    ["p", target.pubkey],
    head.tags.find(([name]) => name === "auth"),
  ]);
  expect(archives.state(target.pubkey)).toBe("archived");
  await archives.request("unarchive", target.pubkey);
  expect(fixture.published[1]?.kind).toBe(9036);
  expect(archives.state(target.pubkey)).toBe("not-archived");
});
it("relay owner/admin path signs without an auth tag; members and foreign owners have no path", async () => {
  const stranger = keypair();
  const admin = archiveRelay(viewer, relay, [attested(target, stranger)], {
    [viewer.pubkey]: "admin",
  });
  const adminArchives = writable(admin);
  await adminArchives.request("archive", target.pubkey);
  expect(admin.published[0]?.tags).toEqual([["-"], ["p", target.pubkey]]);
  for (const roles of [{ [viewer.pubkey]: "member" }, {}]) {
    const denied = archiveRelay(
      viewer,
      relay,
      [attested(target, stranger)],
      roles,
    );
    const archives = writable(denied);
    expect(
      await archives.consent(target.pubkey, new AbortController().signal),
    ).toBeNull();
    await expect(archives.request("archive", target.pubkey)).rejects.toThrow(
      "You can no longer archive this identity",
    );
    expect(denied.signedBy).toEqual([]);
    expect(denied.published).toEqual([]);
  }
});
it("rejects a changed signer echo before publishing", async () => {
  const fixture = archiveRelay(viewer, relay, [attested(target, viewer)]);
  const writer = fixture.transport.identityArchive;
  if (!writer) throw new Error("fixture writer");
  const sign = writer.sign.bind(writer);
  writer.sign = async (template, signal) =>
    sign({ ...template, tags: [...template.tags, ["reason", "x"]] }, signal);
  const archives = writable(fixture);
  await expect(archives.request("archive", target.pubkey)).rejects.toThrow(
    "Signer changed the archive request",
  );
  expect(fixture.published).toEqual([]);
});
it("an accepted but unconfirmed request fails instead of presenting the new state", async () => {
  const fixture = archiveRelay(viewer, relay, [attested(target, viewer)]);
  fixture.script.apply = false;
  const archives = writable(fixture);
  await expect(archives.request("archive", target.pubkey)).rejects.toThrow(
    "The relay did not confirm the change. Retry.",
  );
  expect(fixture.published).toHaveLength(1);
  expect(archives.state(target.pubkey)).toBe("not-archived");
});
it("offers no writer without an archive authority", () => {
  const fixture = archiveRelay(viewer, relay);
  const { archiveAuthority: _, ...transport } = fixture.transport;
  const owner = createRelaySession(transport);
  owners.push(owner);
  expect(owner.session.archives.writable).toBe(false);
  expect(owner.session.archives.supported).toBe(false);
});
it("owner consent ignores kind clauses but enforces request time bounds", async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const restricted = archiveRelay(viewer, relay, [
    attested(
      target,
      viewer,
      [],
      [authTag(target, viewer, `kind=9&created_at<${future}`)],
    ),
  ]);
  await writable(restricted).request("archive", target.pubkey);
  expect(restricted.published).toHaveLength(1);
  const expired = archiveRelay(viewer, relay, [
    attested(target, viewer, [], [authTag(target, viewer, "created_at<2")]),
  ]);
  const archives = writable(expired);
  expect(
    await archives.consent(target.pubkey, new AbortController().signal),
  ).not.toBeNull();
  await expect(archives.request("archive", target.pubkey)).rejects.toThrow(
    "You can no longer archive this identity",
  );
  expect(expired.signedBy).toEqual([]);
});
const outOfBounds = () => [
  ["expired", "created_at<2"],
  ["future-bound", `created_at>${Math.floor(Date.now() / 1000) + 3600}`],
];
it.each(outOfBounds())(
  "an owner who is also relay admin archives and unarchives despite a %s credential",
  async (_label, conditions) => {
    const fixture = archiveRelay(
      viewer,
      relay,
      [attested(target, viewer, [], [authTag(target, viewer, conditions)])],
      { [viewer.pubkey]: "admin" },
    );
    const archives = writable(fixture);
    // Ownership evidence stays visible to the UI alongside role authority.
    const path = await archives.consent(
      target.pubkey,
      new AbortController().signal,
    );
    expect(path?.auth?.[2]).toBe(conditions);
    expect(path?.admin).toBe(true);
    await archives.request("archive", target.pubkey);
    expect(archives.state(target.pubkey)).toBe("archived");
    await archives.request("unarchive", target.pubkey);
    expect(archives.state(target.pubkey)).toBe("not-archived");
    expect(fixture.published.map(({ kind, tags }) => [kind, tags])).toEqual([
      [9035, [["-"], ["p", target.pubkey]]],
      [9036, [["-"], ["p", target.pubkey]]],
    ]);
  },
);
it.each(outOfBounds())(
  "a non-admin owner with a %s credential can neither archive nor unarchive",
  async (_label, conditions) => {
    const fixture = archiveRelay(
      viewer,
      relay,
      [attested(target, viewer, [], [authTag(target, viewer, conditions)])],
      { [viewer.pubkey]: "member" },
    );
    const archives = writable(fixture);
    for (const action of ["archive", "unarchive"] as const)
      await expect(archives.request(action, target.pubkey)).rejects.toThrow(
        "You can no longer archive this identity",
      );
    expect(fixture.signedBy).toEqual([]);
  },
);
it.each([
  [
    "duplicate auth tags",
    () =>
      attested(
        target,
        viewer,
        [],
        [authTag(target, viewer), authTag(target, viewer)],
      ),
  ],
  [
    "an auth tag bound to another target",
    () => attested(target, viewer, [], [authTag(other, viewer)]),
  ],
  [
    "malformed conditions",
    () => attested(target, viewer, [], [authTag(target, viewer, "kind=x")]),
  ],
])("%s grant no owner path", async (_label, profile) => {
  const fixture = archiveRelay(viewer, relay, [profile()]);
  const archives = writable(fixture);
  expect(
    await archives.consent(target.pubkey, new AbortController().signal),
  ).toBeNull();
});
it("an unknown publish outcome reconciles by re-read; a definitive rejection does not", async () => {
  const fixture = archiveRelay(viewer, relay, [attested(target, viewer)]);
  const writer = fixture.transport.identityArchive;
  if (!writer) throw new Error("fixture writer");
  const publish = writer.publish.bind(writer);
  writer.publish = async (event, signal) => {
    await publish(event, signal);
    throw new Error("Relay delivery could not be confirmed (502)");
  };
  const archives = writable(fixture);
  await archives.request("archive", target.pubkey);
  expect(archives.state(target.pubkey)).toBe("archived");
  fixture.script.apply = false;
  await expect(archives.request("unarchive", target.pubkey)).rejects.toThrow(
    "Relay delivery could not be confirmed (502)",
  );
  expect(archives.state(target.pubkey)).toBe("archived");
  writer.publish = async () => {
    throw new PublishRejected("blocked");
  };
  await expect(archives.request("unarchive", target.pubkey)).rejects.toThrow(
    "blocked",
  );
});
it.each(["cancel", "cache", "dispose"] as const)(
  "%s during confirmation settles without presenting unconfirmed state",
  async (action) => {
    const fixture = archiveRelay(viewer, relay, [attested(target, viewer)]);
    let release!: () => void;
    fixture.script.hold = new Promise((resolve) => {
      release = resolve;
    });
    const owner = createRelaySession(fixture.transport);
    owners.push(owner);
    const archives = owner.session.archives;
    const caller = new AbortController();
    const request = archives.request("archive", target.pubkey, caller.signal);
    await vi.waitFor(() => expect(fixture.signedBy).toHaveLength(1));
    if (action === "cancel") caller.abort();
    else if (action === "cache") await owner.clearCache();
    else owner.dispose();
    release();
    if (action === "dispose") {
      await expect(request).rejects.toThrow("Archive request was interrupted");
      expect(archives.state(target.pubkey)).toBe("unknown");
    } else {
      // The held publish applied; reconciliation confirms it by fresh re-read.
      await request;
      expect(archives.state(target.pubkey)).toBe("archived");
    }
  },
);
it.each(
  outOfBounds().map(([label, conditions]) => [
    `a ${label} profile proof`,
    [attested(target, viewer, [], [authTag(target, viewer, conditions)])],
  ]) as [string, RelayEvent[]][],
)(
  "an owner archives with a proof issued now when there is %s",
  async (_label, profiles) => {
    const fixture = archiveRelay(viewer, relay, profiles);
    const archives = writable(fixture);
    const issued = authTag(target, viewer);
    const issue = vi.fn(async () => issued);
    await archives.request("archive", target.pubkey, undefined, issue);
    expect(issue).toHaveBeenCalledWith(target.pubkey, expect.any(AbortSignal));
    expect(fixture.published).toHaveLength(1);
    expect(fixture.published[0]?.tags).toContainEqual(issued);
    expect(archives.state(target.pubkey)).toBe("archived");
  },
);
/** Republishes the agent's own profile naming its saved owner, as the app's
 * forced profile publication does. */
function attestAs(
  fixture: ReturnType<typeof archiveRelay>,
  agent: Key,
  owner: Key = viewer,
) {
  return vi.fn(async (_signal: AbortSignal) => {
    fixture.publishProfile(
      signed(agent, {
        kind: 0,
        content: JSON.stringify({ name: "Agent", bot: true }),
        tags: [authTag(agent, owner)],
        created_at: 1_700_000_001,
      }),
    );
  });
}
it("a profile without an owner proof is replaced by the agent's own, naming its owner, then archived with a proof issued now", async () => {
  const bare = signed(target, {
    kind: 0,
    content: JSON.stringify({ name: "Agent", lud16: "a@b" }),
    tags: [["i", "github:agent", "proof"]],
  });
  const fixture = archiveRelay(viewer, relay, [bare]);
  const archives = writable(fixture);
  const issued = authTag(target, viewer, "created_at>1");
  const attest = attestAs(fixture, target);
  await archives.request(
    "archive",
    target.pubkey,
    undefined,
    async () => issued,
    attest,
  );
  expect(attest).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(fixture.published).toHaveLength(1);
  expect(fixture.published[0]?.tags).toContainEqual(issued);
  expect(archives.state(target.pubkey)).toBe("archived");
});
it("doesn't archive when the republished profile names another owner", async () => {
  const fixture = archiveRelay(viewer, relay);
  await expect(
    writable(fixture).request(
      "archive",
      target.pubkey,
      undefined,
      async () => authTag(target, viewer),
      attestAs(fixture, target, other),
    ),
  ).rejects.toThrow(
    "The relay didn't accept its profile with your owner proof",
  );
  expect(fixture.signedBy).toEqual([]);
});
it("the relay refuses an issued request proof alone while the profile names no owner", async () => {
  const fixture = archiveRelay(viewer, relay);
  const archives = writable(fixture);
  // Without the identity's key nothing can republish its profile.
  await expect(
    archives.request("archive", target.pubkey, undefined, async () =>
      authTag(target, viewer),
    ),
  ).rejects.toBeInstanceOf(UnattestedProfile);
  expect(fixture.signedBy).toEqual([]);
  // The fixture enforces the relay's rule, so a request can't hide it.
  const request = signed(viewer, {
    kind: 9035,
    content: "",
    tags: [["p", target.pubkey], authTag(target, viewer)],
  });
  await expect(
    fixture.transport.identityArchive?.publish(
      request,
      new AbortController().signal,
    ),
  ).rejects.toThrow("invalid: missing auth tag");
});
it("archives nothing when its profile isn't republished, and a retry finishes", async () => {
  const fixture = archiveRelay(viewer, relay);
  const archives = writable(fixture);
  const issue = async () => authTag(target, viewer);
  await expect(
    archives.request("archive", target.pubkey, undefined, issue, async () => {
      throw new Error("The community refused the agent event");
    }),
  ).rejects.toThrow("The community refused the agent event");
  // Published nowhere: a profile the relay never took confirms nothing either.
  await expect(
    archives.request(
      "archive",
      target.pubkey,
      undefined,
      issue,
      async () => {},
    ),
  ).rejects.toThrow(
    "The relay didn't accept its profile with your owner proof",
  );
  expect(fixture.signedBy).toEqual([]);
  expect(fixture.archived.has(target.pubkey)).toBe(false);
  await archives.request(
    "archive",
    target.pubkey,
    undefined,
    issue,
    attestAs(fixture, target),
  );
  expect(archives.state(target.pubkey)).toBe("archived");
});
it("refuses an issued proof that names another owner or agent", async () => {
  for (const issued of [authTag(target, other), authTag(other, viewer)]) {
    const fixture = archiveRelay(viewer, relay);
    await expect(
      writable(fixture).request(
        "archive",
        target.pubkey,
        undefined,
        async () => issued,
        attestAs(fixture, target),
      ),
    ).rejects.toThrow("The owner proof issued for this identity is invalid");
    expect(fixture.signedBy).toEqual([]);
  }
});
it("issues no proof when the profile's own or the admin path is usable", async () => {
  const issue = vi.fn(async () => authTag(target, viewer));
  const owned = archiveRelay(viewer, relay, [attested(target, viewer)]);
  await writable(owned).request("archive", target.pubkey, undefined, issue);
  const admin = archiveRelay(viewer, relay, [], { [viewer.pubkey]: "admin" });
  await writable(admin).request("archive", target.pubkey, undefined, issue);
  expect(issue).not.toHaveBeenCalled();
  expect(admin.published[0]?.tags.some(([name]) => name === "auth")).toBe(
    false,
  );
});
it("a proof that can't be issued archives nothing", async () => {
  const fixture = archiveRelay(viewer, relay);
  await expect(
    writable(fixture).request(
      "archive",
      target.pubkey,
      undefined,
      () => Promise.reject(new Error("Set up your identity first")),
      attestAs(fixture, target),
    ),
  ).rejects.toThrow("Set up your identity first");
  expect(fixture.signedBy).toEqual([]);
});
