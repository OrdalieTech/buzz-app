import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactStorageService,
  OpenArtifactCollection,
} from "../artifact-storage/service";
import { provideArtifactStoreSync } from "./artifact-store-sync";
import { ArtifactIncrementalError } from "./artifact-incremental-reader";
import {
  reconcileArtifactDelta,
  reconcileArtifactCurrent,
} from "./artifact-reconcile";
import { keypair, signed } from "./testing";
import { eventDto, type EventData, type RelayEvent } from "./events";
vi.mock("./artifact-reconcile", async (original) => ({
  ...(await original<typeof import("./artifact-reconcile")>()),
  reconcileArtifactDelta: vi.fn(async () => {}),
  reconcileArtifactCurrent: vi.fn(async () => {}),
}));
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(reconcileArtifactDelta).mockReset().mockResolvedValue(undefined);
  vi.mocked(reconcileArtifactCurrent).mockReset().mockResolvedValue(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal("navigator", {
    locks: { request: vi.fn(async (_key, _options, callback) => callback()) },
  });
  const listeners = new Set<() => void>();
  const liveListeners = new Set<() => void>();
  let receive: (value: { events: readonly RelayEvent[] }) => void = () => {};
  let accepted: (event: EventData) => void = () => {};
  let opened: (entry: OpenArtifactCollection) => void = () => {};
  let online = true;
  let scoped = true;
  const session = {
    artifactIncremental: {},
    live: {
      snapshot: () => ({ status: online ? "connected" : "retrying" }),
      subscribe: (listener: () => void) => {
        liveListeners.add(listener);
        return () => {
          liveListeners.delete(listener);
        };
      },
    },
    subscribeLive: (listener: typeof receive) => {
      receive = listener;
      return () => {
        receive = () => {};
      };
    },
    outbox: {
      observeSend: (
        listener: (
          event: EventData,
        ) => ((pending: readonly EventData[]) => void) | undefined,
      ) => {
        accepted = (event) => listener(event)?.([]);
        return () => {
          accepted = () => {};
        };
      },
    },
  };
  const ctx = {
    relay: {
      snapshot: () => ({
        ...(scoped ? { viewer: "viewer", origin: "https://relay.test" } : {}),
        status: scoped ? "ready" : "connecting",
        cached: false,
        session,
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    effect: (effect: () => () => void) => {
      stops.push(effect());
    },
  };
  provideArtifactStoreSync(
    ctx as unknown as Context,
    {
      onOpen: (listener: typeof opened) => {
        opened = listener;
        return () => {};
      },
    } as unknown as ArtifactStorageService,
  );
  const add = (version = 1) => {
    const controller = new AbortController();
    const collection = { applyBatch: vi.fn(async () => {}) };
    opened({
      viewer: "viewer",
      relay: "https://relay.test",
      owner: "test.plugin",
      definition: { name: "tasks", type: "test.task", version },
      collection,
      signal: controller.signal,
    } as unknown as OpenArtifactCollection);
    return { controller, collection };
  };
  return {
    add,
    scope: (value: boolean) => {
      scoped = value;
      for (const listener of listeners) listener();
    },
    confirmed: (event: RelayEvent) => receive({ events: [event] }),
    accepted: (event: EventData) => accepted(event),
    connection: (value: boolean) => {
      online = value;
      for (const listener of liveListeners) listener();
    },
  };
}
it("coalesces collection repair and retires closed collections", async () => {
  const h = setup();
  const entry = h.add();
  await vi.advanceTimersByTimeAsync(0);
  expect(navigator.locks.request).toHaveBeenCalledTimes(1);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
  entry.controller.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
});
it("aborts reconciliation on disconnect and starts a new capture on reconnect", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(
    async (_reader, _collection, _type, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const signal = vi.mocked(reconcileArtifactDelta).mock.calls[0]?.[3];
  h.connection(false);
  expect(signal?.aborted).toBe(true);
  h.connection(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
});
it("keeps an open collection through a reconnect without relay scope", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(
    async (_reader, _collection, _type, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  const entry = h.add();
  await vi.advanceTimersByTimeAsync(0);
  const signal = vi.mocked(reconcileArtifactDelta).mock.calls[0]?.[3];
  h.scope(false);
  expect(signal?.aborted).toBe(true);
  expect(entry.controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  h.scope(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["d", "task"],
        ["type", "test.task"],
      ],
    }),
  );
  h.confirmed(event);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  h.accepted(event);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(3);
  expect(navigator.locks.request).toHaveBeenCalledOnce();
});
it("refreshes after proven acceptance without writing raw revisions", async () => {
  const h = setup();
  const entry = h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = signed(keypair(), {
    kind: 45010,
    content: "{}",
    tags: [
      ["d", "task"],
      ["h", "channel"],
      ["ar", "1"],
      ["type", "test.task"],
      ["op", "create"],
    ],
  });
  h.confirmed(eventDto(event));
  await vi.advanceTimersByTimeAsync(0);
  expect(entry.collection.applyBatch).not.toHaveBeenCalled();
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
});

it("releases an expired version so a current collection can own sync", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactDelta).mockRejectedValueOnce(
    new Error("Artifact collection version changed"),
  );
  const old = h.add();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  old.controller.abort();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  expect(navigator.locks.request).toHaveBeenCalledTimes(2);
});

it("coalesces live invalidations during a capture into one later refresh", async () => {
  const h = setup();
  let release = () => {};
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const entry = h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  for (let i = 0; i < 50; i++) h.confirmed(event);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  expect(entry.collection.applyBatch).not.toHaveBeenCalled();
});

it("keeps capture admission failures on the repair interval despite live traffic", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactDelta).mockRejectedValue(
    new ArtifactIncrementalError("incremental_limit", "Too many memberships"),
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  for (let i = 0; i < 20; i++) {
    h.confirmed(event);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
});
it.each([
  [0, 60_000],
  [0.5, 75_000],
  [0.99999, 89_999],
])(
  "keeps random draw %s behind its %s ms retry deadline",
  async (draw, delay) => {
    const h = setup();
    vi.spyOn(Math, "random").mockReturnValueOnce(draw).mockReturnValue(0);
    vi.mocked(reconcileArtifactDelta).mockRejectedValue(
      new ArtifactIncrementalError("incremental_limit", "Capture limit"),
    );
    h.add();
    await vi.advanceTimersByTimeAsync(0);
    const event = eventDto(
      signed(keypair(), {
        kind: 45010,
        content: "{}",
        tags: [
          ["type", "test.task"],
          ["d", "task"],
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(delay - 1);
    h.confirmed(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcileArtifactDelta).toHaveBeenCalledTimes(3);
  },
);
it("spreads retries across owners after simultaneous capture refusals", async () => {
  const owners = Array.from({ length: 32 }, () => setup());
  const random = vi.spyOn(Math, "random");
  for (let index = 0; index < owners.length; index++)
    random.mockReturnValueOnce(index / owners.length);
  vi.mocked(reconcileArtifactDelta).mockRejectedValue(
    new ArtifactIncrementalError("incremental_unavailable", "Capture busy"),
  );
  for (const owner of owners) owner.add();
  await vi.advanceTimersByTimeAsync(7000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(128);
  vi.mocked(reconcileArtifactDelta).mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(128);
  let elapsed = 59_999;
  for (let index = 0; index < owners.length; index++) {
    const deadline = 60_000 + Math.floor((index / owners.length) * 30_000);
    await vi.advanceTimersByTimeAsync(deadline - elapsed);
    expect(reconcileArtifactDelta).toHaveBeenCalledTimes(129 + index);
    elapsed = deadline;
  }
});
it("keeps a current handle when an older in-flight version fails", async () => {
  const h = setup();
  let fail = () => {};
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(async () => {
    await new Promise<void>((_resolve, reject) => {
      fail = () => reject(new Error("Artifact collection version changed"));
    });
  });
  const old = h.add(1);
  await vi.advanceTimersByTimeAsync(0);
  const current = h.add(2);
  fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
  expect(vi.mocked(reconcileArtifactDelta).mock.calls[1]?.[1]).toBe(
    current.collection,
  );
  old.controller.abort();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(3);
  expect(navigator.locks.request).toHaveBeenCalledOnce();
});
it("keeps duplicate delayed hints behind an in-flight current read", async () => {
  const h = setup();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  let finish = () => {};
  vi.mocked(reconcileArtifactCurrent).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  h.confirmed(event);
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 50; i++) h.confirmed(event);
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(2);
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
});
it("uses bounded current reads and requests a delta after live overflow", async () => {
  const h = setup();
  let finish = () => {};
  vi.mocked(reconcileArtifactDelta).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const key = keypair();
  for (let i = 0; i < 1002; i++)
    h.confirmed(
      eventDto(
        signed(key, {
          kind: 45010,
          content: "{}",
          tags: [
            ["type", "test.task"],
            ["d", `task-${i}`],
          ],
        }),
      ),
    );
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(10);
  expect(
    vi
      .mocked(reconcileArtifactCurrent)
      .mock.calls.every((call) => call[3].length <= 100),
  ).toBe(true);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
}, 15_000); // This case signs and verifies 1,002 distinct live events.

it("keeps capacity backoff when a live read starts before the repair timer", async () => {
  const h = setup();
  h.add();
  await vi.advanceTimersByTimeAsync(30_000);
  vi.mocked(reconcileArtifactCurrent).mockRejectedValueOnce(
    new ArtifactIncrementalError("incremental_limit", "Large"),
  );
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  h.confirmed(event);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  h.confirmed(event);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(2);
});

it("keeps transient retry times under live hints and reports a persistent current failure", async () => {
  const h = setup();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(reconcileArtifactCurrent).mockRejectedValue(
    new Error("Disconnected"),
  );
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  h.confirmed(event);
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 10; i++) {
    h.confirmed(event);
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(reconcileArtifactCurrent).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(4000);
  expect(reconcileArtifactCurrent).toHaveBeenCalledTimes(4);
  expect(vi.mocked(reconcileArtifactCurrent).mock.calls[3]?.[5]).toEqual({
    reportFailure: true,
  });
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
});

it("keeps the periodic delta deadline under continuing live hints", async () => {
  const h = setup();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(9000);
    h.confirmed(event);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(reconcileArtifactDelta).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(6000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(2);
});

it("keeps a failed delta retry round ahead of queued live reads", async () => {
  const h = setup();
  vi.mocked(reconcileArtifactDelta).mockRejectedValue(
    new Error("Disconnected"),
  );
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  const event = eventDto(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  h.confirmed(event);
  await vi.advanceTimersByTimeAsync(7000);
  expect(reconcileArtifactDelta).toHaveBeenCalledTimes(4);
  expect(vi.mocked(reconcileArtifactDelta).mock.calls[3]?.[4]).toEqual({
    reportFailure: true,
  });
  expect(reconcileArtifactCurrent).not.toHaveBeenCalled();
});

it("requests a current read from the existing outbox acceptance observer", async () => {
  const h = setup();
  h.add();
  await vi.advanceTimersByTimeAsync(0);
  h.accepted(
    signed(keypair(), {
      kind: 45010,
      content: "{}",
      tags: [
        ["type", "test.task"],
        ["d", "task"],
      ],
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileArtifactCurrent).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "test.task",
    ["task"],
    expect.any(AbortSignal),
    expect.anything(),
  );
});
