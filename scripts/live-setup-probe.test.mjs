import { afterEach, expect, it, vi } from "vitest";
import { generateSecretKey } from "nostr-tools";
import {
  discoverRoster,
  parseStrategy,
  probe,
  runStrategy,
} from "./live-setup-probe.mjs";

afterEach(() => vi.useRealTimers());
/** A relay 20 ms away that answers every REQ at once and caps filters at 10.
 * `answer` may replace the reply to a channel REQ (or return null for none),
 * `other` the reply to any other REQ, and `delay` the reply latency. */
function fakeRelay(
  answer = (id) => ["EOSE", id],
  { other = (id) => ["EOSE", id], delay = () => 40 } = {},
) {
  const sockets = [];
  const factory = () => {
    const socket = {
      readyState: 1,
      send(text) {
        const [kind, id, ...filters] = JSON.parse(text);
        if (kind === "AUTH") return reply(["OK", id.id, true]);
        if (kind !== "REQ") return;
        if (filters.length > 10)
          return reply(["CLOSED", id, "invalid: too many filters"]);
        const channel = filters.some((filter) => filter["#h"]);
        const frame = channel ? answer(id) : other(id);
        if (frame) reply(frame, delay(id, channel));
      },
      close() {
        this.readyState = 3;
      },
    };
    const reply = (frame, ms = 40) =>
      setTimeout(() => {
        if (socket.readyState === 1)
          socket.onmessage?.({ data: JSON.stringify(frame) });
      }, ms);
    setTimeout(
      () => socket.onmessage?.({ data: JSON.stringify(["AUTH", "c"]) }),
      20,
    );
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}
const options = (relay) => ({
  url: "wss://relay.test",
  key: generateSecretKey(),
  socketFactory: relay.factory,
  now: () => Date.now(),
});
async function run(name, channels, answer, relayOptions) {
  const relay = fakeRelay(answer, relayOptions);
  const result = runStrategy({
    ...options(relay),
    channels,
    strategy: parseStrategy(name),
  });
  await vi.runAllTimersAsync();
  return { ...(await result), sockets: relay.sockets.length };
}
const channels = Array.from({ length: 20 }, (_, i) => `channel-${i}`);

it("measures coverage for the app's subscriber and for raw batch shapes", async () => {
  vi.useFakeTimers();
  const one = await run("client:1", channels);
  const four = await run("client:4", channels);
  const packed = await run("filters:10", channels);
  const single = await run("multi-h:all", channels);
  // One live batch and two global routes. The client can also start replay.
  expect([one.reqs, four.reqs, packed.reqs, single.reqs]).toEqual([4, 4, 2, 1]);
  for (const result of [one, four, packed, single])
    expect(result).toMatchObject({
      channels: 20,
      failed: 0,
      authMs: 60,
      canaryMs: expect.any(Number),
      sockets: 1,
    });
  // Three serial live setups at K=1; all three fit in one round trip at K=4.
  expect(one.coverageMs).toBe(3 * 40);
  expect(four.coverageMs).toBe(40);
  expect(packed.coverageMs).toBe(40);
  expect(single.reqMs).toEqual([40]);
});

it("keeps live coverage when the separate replay sample fails", async () => {
  vi.useFakeTimers();
  let first = true;
  const result = await run(
    "client:4",
    channels,
    (id) => {
      if (first) {
        first = false;
        return ["EOSE", id];
      }
      return ["CLOSED", id, "error: replay unavailable"];
    },
    { delay: (id) => (id === "probe-canary" ? 1000 : 40) },
  );
  expect(result).toMatchObject({
    channels: 20,
    failed: 0,
    coverageMs: 40,
    canaryMs: 1000,
    failures: { "error: replay unavailable": 1 },
  });
});

it("reports relay refusals and an idle baseline canary", async () => {
  vi.useFakeTimers();
  const refused = await run("filters:11", channels);
  // Eleven channels in the refused REQ; the remaining nine fit under the cap.
  expect(refused).toMatchObject({
    reqs: 2,
    failed: 11,
    failures: { "invalid: too many filters": 1 },
  });
  // Partial coverage is not coverage.
  expect(refused.coverageMs).toBeUndefined();
  const idle = await run("idle", channels);
  expect(idle).toMatchObject({ reqs: 0, failed: 0, canaryMs: 40 });
  expect(() => parseStrategy("client:0")).toThrow();
  expect(() => parseStrategy("batch:4")).toThrow();
});

it("finishes when the app's subscriber gives up on quota refusals without a frame", async () => {
  vi.useFakeTimers();
  // A cooldown over 60 s makes the subscriber stop its whole unsent queue locally.
  const refused = await run("client:1", channels, (id) => [
    "CLOSED",
    id,
    "rate-limited: quota exceeded; retry in 120s",
  ]);
  // Profiles, membership, then the one channel REQ that was refused.
  expect(refused).toMatchObject({ reqs: 3, failed: 20 });
  expect(refused.error).toBeUndefined();
  expect(refused.coverageMs).toBeUndefined();
});

it("reports timed-out runs and gives no coverage median unless every run finished", async () => {
  vi.useFakeTimers();
  let answered = 0;
  // The first run's channel REQs are never answered; later runs are.
  const relay = fakeRelay((id) => (answered++ < 2 ? null : ["EOSE", id]));
  const report = probe({
    ...options(relay),
    channels: channels.slice(0, 2),
    strategies: [parseStrategy("multi-h:1")],
    runs: 3,
    pauseMs: 0,
    timeoutMs: 1000,
  });
  await vi.runAllTimersAsync();
  const { summary, results } = await report;
  expect(results.map((result) => result.error)).toEqual([
    "timed out",
    undefined,
    undefined,
  ]);
  expect(summary[0]).toMatchObject({ runs: 3, incomplete: 1, failed: 2 });
  expect(summary[0].coverageMs).toBeUndefined();
});

it("gives no coverage median when any run leaves channels refused", async () => {
  vi.useFakeTimers();
  let answered = 0;
  // The first run refuses both channels; later runs answer.
  const relay = fakeRelay((id) =>
    answered++ < 2 ? ["CLOSED", id, "restricted: no"] : ["EOSE", id],
  );
  const report = probe({
    ...options(relay),
    channels: channels.slice(0, 2),
    strategies: [parseStrategy("multi-h:1")],
    runs: 3,
    pauseMs: 0,
  });
  await vi.runAllTimersAsync();
  const { summary, results } = await report;
  expect(results.map((result) => result.failed)).toEqual([2, 0, 0]);
  expect(summary[0]).toMatchObject({ incomplete: 1, failed: 2 });
  expect(summary[0].coverageMs).toBeUndefined();
});

it("reports a refused canary as a refusal, not as canary latency", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay(undefined, {
    other: (id) =>
      id === "probe-canary"
        ? ["CLOSED", id, "rate-limited: slow down"]
        : ["EOSE", id],
    delay: (id) => (id === "probe-canary" ? 1 : 40),
  });
  const report = probe({
    ...options(relay),
    channels: channels.slice(0, 2),
    strategies: [parseStrategy("multi-h:all")],
    runs: 1,
    pauseMs: 0,
  });
  await vi.runAllTimersAsync();
  const { summary, results } = await report;
  // It still finishes as soon as the channels are live, not at the timeout.
  expect(results[0]).toMatchObject({
    coverageMs: 40,
    canaryRefused: "canary: rate-limited: slow down",
    failures: { "canary: rate-limited: slow down": 1 },
  });
  expect(results[0].error).toBeUndefined();
  expect(results[0].canaryMs).toBeUndefined();
  expect(summary[0]).toMatchObject({ canaryRefused: 1 });
  expect(summary[0].canaryMs).toBeUndefined();
});

it("times channel coverage by channel EOSE only", async () => {
  vi.useFakeTimers();
  // Profiles and membership settle at 1 s and the canary at 5 s, both after
  // every channel is live at 40 ms.
  const result = await run("client:all", channels.slice(0, 2), undefined, {
    delay: (id, channel) =>
      channel ? 40 : id === "probe-canary" ? 5000 : 1000,
  });
  expect(result).toMatchObject({ failed: 0, coverageMs: 40, canaryMs: 5000 });
});

it("keeps a timed-out batch failed when its EOSE arrives after CLOSE", async () => {
  vi.useFakeTimers();
  let first = true;
  // The first full batch answers 30 ms after its deadline. The second
  // batch keeps the socket open until 40 ms after that deadline.
  const batchChannels = Array.from({ length: 2058 }, (_, i) => `channel-${i}`);
  const result = await run("client:1", batchChannels, undefined, {
    delay: (_id, channel) => {
      if (!channel) return 40;
      const late = first;
      first = false;
      return late ? 10030 : 40;
    },
  });
  expect(result).toMatchObject({ reqs: 5, failed: 2048 });
  expect(result.coverageMs).toBeUndefined();
  expect(result.error).toBeUndefined();
});

it("fails a roster read that is refused or truncated instead of probing part of it", async () => {
  /** A relay that sends `count` roster events, then `end`. */
  const rosterRelay = (count, end) => () => {
    const socket = {
      send(text) {
        const [kind, id] = JSON.parse(text);
        if (kind === "AUTH") return deliver(["OK", id.id, true]);
        if (kind !== "REQ") return;
        for (let i = 0; i < count; i++)
          deliver(["EVENT", id, { tags: [["d", `channel-${i}`]] }]);
        deliver(end);
      },
      close() {},
    };
    const deliver = (frame) =>
      queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(frame) }));
    deliver(["AUTH", "c"]);
    return socket;
  };
  const read = (count, end) =>
    discoverRoster({
      url: "wss://relay.test",
      key: generateSecretKey(),
      socketFactory: rosterRelay(count, end),
    });
  await expect(read(2, ["EOSE", "roster"])).resolves.toEqual([
    "channel-0",
    "channel-1",
  ]);
  await expect(
    read(2, ["CLOSED", "roster", "rate-limited: quota exceeded"]),
  ).rejects.toThrow("Roster read refused: rate-limited: quota exceeded");
  await expect(read(500, ["EOSE", "roster"])).rejects.toThrow(
    "may be truncated",
  );
});
