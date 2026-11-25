import { describe, expect, it, vi } from "vitest";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { readyOwnerReads } from "./reads";

const owner = "a".repeat(64);
const agent = { relay: "wss://relay.example", owner, pubkey: "b".repeat(64) };
const ready = (session: object, over: Partial<RelaySnapshot> = {}) =>
  ({
    status: "ready",
    generation: 1,
    origin: "https://relay.example",
    viewer: owner,
    scope: `https://relay.example:${owner}`,
    session,
    ...over,
  }) as unknown as RelaySnapshot;
const connecting = { status: "connecting", generation: 2 } as RelaySnapshot;

/** A community connection whose snapshot the test publishes. */
function community(first: RelaySnapshot) {
  let snapshot = first;
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as unknown as RelayData;
  return {
    relay,
    listeners,
    publish(next: RelaySnapshot) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A session listing `channels`, which the test relists. */
function session(
  channels: { id: string; channelType?: string }[] = [],
  status = "ready",
) {
  const listeners = new Set<() => void>();
  return {
    workflowAuthority: "c".repeat(64),
    listeners,
    channels: {
      list: () => ({ status, channels }),
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    relist(next = channels) {
      status = "ready";
      channels = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const lost =
  "Workflow request could not start: its community is no longer connected.";

describe("readyOwnerReads", () => {
  it.each([
    ["connecting", connecting],
    ["a cached snapshot", ready(session(), { cached: true })],
  ])(
    "waits through %s for the replacement session's channel list",
    async (_name, first) => {
      const c = community(first);
      const reads = readyOwnerReads(
        c.relay,
        agent,
        new AbortController().signal,
      );
      const settled = vi.fn();
      void reads.then(settled);
      const replacement = session([], "loading");
      c.publish(ready(replacement, { generation: 3 }));
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      replacement.relist();
      expect((await reads).connection).toBe(replacement);
      expect((await reads).workflowAuthority()).toBe("c".repeat(64));
      expect(replacement.listeners.size).toBe(0);
      expect(c.listeners.size).toBe(0);
    },
  );

  it.each([
    [
      "a disconnect",
      { ...connecting, status: "disconnected" } as RelaySnapshot,
    ],
    [
      "another community",
      ready(session(), {
        origin: "https://other.example",
        scope: `https://other.example:${owner}`,
      }),
    ],
  ])("rejects after %s", async (_name, next) => {
    const c = community(connecting);
    const reads = readyOwnerReads(c.relay, agent, new AbortController().signal);
    c.publish(next);
    await expect(reads).rejects.toThrow(lost);
    expect(c.listeners.size).toBe(0);
  });

  it("resolves a DM only the agent can read through the agent's current reads", async () => {
    const c = community(ready(session()));
    const stale = {
      channelLabel: () => undefined,
      subscribeChannels: () => () => {},
      channel: vi.fn(async () => undefined),
    };
    let known = false;
    const listeners = new Set<() => void>();
    const current = {
      channelLabel: () =>
        known ? { name: "DM", channelType: "dm" } : undefined,
      subscribeChannels: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      channel: vi.fn(async () => {
        known = true;
        for (const listener of [...listeners]) listener();
        return undefined;
      }),
    };
    let reads: unknown = stale;
    const ready_ = readyOwnerReads(
      c.relay,
      agent,
      new AbortController().signal,
      "agent-dm",
      "This turn",
      () => reads as never,
    );
    await Promise.resolve();
    expect(stale.channel).toHaveBeenCalledWith("agent-dm");
    reads = current;
    c.publish(ready(session(), { generation: 3 }));
    expect(await ready_).toBe(current);
    expect(current.channel).toHaveBeenCalledWith("agent-dm");
    expect(listeners.size).toBe(0);
  });

  it("asks the agent's reads again, backing off, after a lookup fails", async () => {
    vi.useFakeTimers();
    try {
      const c = community(ready(session()));
      let known = false;
      const reads = {
        channelLabel: () =>
          known ? { name: "DM", channelType: "dm" } : undefined,
        subscribeChannels: () => () => {},
        channel: vi
          .fn()
          .mockRejectedValueOnce(new Error("relay unavailable"))
          .mockResolvedValueOnce(undefined)
          .mockImplementation(async () => {
            known = true;
            return undefined;
          }),
      };
      const settled = vi.fn();
      void readyOwnerReads(
        c.relay,
        agent,
        new AbortController().signal,
        "agent-dm",
        "This turn",
        () => reads as never,
      ).then(settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads.channel).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads.channel).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads.channel).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads.channel).toHaveBeenCalledTimes(3);
      expect(settled).toHaveBeenCalledWith(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off for a reader made afresh at each check", async () => {
    vi.useFakeTimers();
    try {
      const c = community(ready(session()));
      const channel = vi.fn(async () => undefined);
      const deadline = new AbortController();
      const waiting = readyOwnerReads(
        c.relay,
        agent,
        deadline.signal,
        "agent-dm",
        "This turn",
        () =>
          ({
            channelLabel: () => undefined,
            subscribeChannels: () => () => {},
            channel,
          }) as never,
      );
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(channel).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(channel).toHaveBeenCalledTimes(3);
      deadline.abort();
      await expect(waiting).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects on the deadline and stops listening", async () => {
    const c = community(connecting);
    const deadline = new AbortController();
    const reads = readyOwnerReads(c.relay, agent, deadline.signal);
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    await expect(reads).rejects.toThrow(
      "Workflow request could not start: its community did not reconnect before the delivery deadline.",
    );
    expect(c.listeners.size).toBe(0);
  });

  it("waits until the destination is listed and typed", async () => {
    const first = session();
    const c = community(ready(first));
    const settled = vi.fn();
    const reads = readyOwnerReads(
      c.relay,
      agent,
      new AbortController().signal,
      "dm",
    );
    void reads.then(settled);
    first.relist([{ id: "dm" }]);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    first.relist([{ id: "dm", channelType: "dm" }]);
    expect((await reads).connection).toBe(first);
    expect(first.listeners.size).toBe(0);
  });

  it("finds a destination the list lacks through the session's get", async () => {
    const live = session();
    const get = vi.fn(() => ({ id: "dm", channelType: "dm" }));
    Object.assign(live.channels, { get });
    const reads = readyOwnerReads(
      community(ready(live)).relay,
      agent,
      new AbortController().signal,
      "dm",
    );
    expect((await reads).connection).toBe(live);
    expect(get).toHaveBeenCalledWith("dm");
  });
});
