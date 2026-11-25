// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type Connect,
  type ListenOptions,
  listenHosted,
  transcriptItems,
} from "./listen";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function callbacks() {
  const onText = vi.fn();
  const onPause = vi.fn();
  const onEnd = vi.fn();
  const onError = vi.fn();
  const onState = vi.fn();
  const onCallLimit = vi.fn();
  const options: ListenOptions = {
    onText,
    onPause,
    onEnd,
    onError,
    onState,
    onCallLimit,
  };
  return { options, onText, onPause, onEnd, onError, onState, onCallLimit };
}

const DELTA = "conversation.item.input_audio_transcription.delta";
const COMPLETED = "conversation.item.input_audio_transcription.completed";
const COMMIT = JSON.stringify({ type: "input_audio_buffer.commit" });
const COMMITTED = "input_audio_buffer.committed";
const EMPTY = {
  type: "error",
  error: { code: "input_audio_buffer_commit_empty", message: "empty" },
};

function hosted(
  reply: Awaited<ReturnType<Connect>> = { outcome: "answered", sdp: "answer" },
) {
  const channel = Object.assign(new EventTarget(), {
    readyState: "open",
    send: vi.fn(),
    close: vi.fn(),
  });
  const stopTrack = vi.fn();
  const track = { stop: stopTrack };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  const replaceTrack = vi.fn(async () => {});
  const close = vi.fn();
  const setRemoteDescription = vi.fn(async () => {});
  const peers: {
    connectionState?: string;
    onconnectionstatechange?: () => void;
  }[] = [];
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      connectionState?: string;
      onconnectionstatechange?: () => void;
      constructor() {
        peers.push(this);
      }
      addTransceiver = () => ({ sender: { replaceTrack } });
      createDataChannel = () => channel;
      createOffer = async () => ({ type: "offer", sdp: "the offer" });
      setLocalDescription = async () => {};
      setRemoteDescription = setRemoteDescription;
      close = close;
    },
  );
  vi.stubGlobal(
    "navigator",
    Object.create(navigator, { mediaDevices: { value: { getUserMedia } } }),
  );
  const connect = vi.fn<Connect>(async () => reply);
  const c = callbacks();
  return {
    ...c,
    connect,
    channel,
    stream,
    track,
    stopTrack,
    close,
    getUserMedia,
    replaceTrack,
    setRemoteDescription,
    commits: () =>
      channel.send.mock.calls.filter(([data]) => data === COMMIT).length,
    /** The connection fails, as when ICE can't get through. */
    disconnect() {
      const peer = peers.at(-1);
      if (!peer) throw new Error("no peer");
      peer.connectionState = "failed";
      peer.onconnectionstatechange?.();
    },
    receive(event: unknown) {
      channel.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(event) }),
      );
    },
    async start() {
      const listening = listenHosted(c.options, connect);
      await vi.advanceTimersByTimeAsync(0);
      channel.dispatchEvent(new Event("open"));
      return listening;
    },
  };
}

it("keeps each item's words and lets its completed text replace them", () => {
  const items = transcriptItems();
  items.apply({ type: DELTA, item_id: "a", delta: "Open" });
  items.apply({ type: DELTA, item_id: "a", delta: " desing" });
  expect(items.settled()).toBe(false);
  items.apply({ type: COMPLETED, item_id: "a", transcript: "Open design" });
  items.apply({ type: DELTA, item_id: "b", delta: "now" });
  expect(items.text()).toBe("Open design now");
  // A late delta for a finished item changes nothing.
  expect(items.apply({ type: DELTA, item_id: "a", delta: "x" })).toBe(false);
  items.apply({ type: COMPLETED, item_id: "b", transcript: "now." });
  expect(items.text()).toBe("Open design now.");
  expect(items.settled()).toBe(true);
});

it("answers through the provider, commits at each pause, and reports the settled words", async () => {
  const r = hosted();
  const listening = await r.start();
  expect(r.connect).toHaveBeenCalledWith("the offer", expect.any(AbortSignal));
  expect(r.replaceTrack).toHaveBeenCalledWith(r.track);
  expect(r.setRemoteDescription).toHaveBeenCalledWith({
    type: "answer",
    sdp: "answer",
  });
  expect(r.onState.mock.calls).toEqual([["starting"], ["listening"]]);

  r.receive({ type: DELTA, item_id: "a", delta: "Open" });
  r.receive({ type: DELTA, item_id: "a", delta: " desing" });
  expect(r.onText.mock.calls).toEqual([["Open"], ["Open desing"]]);
  vi.advanceTimersByTime(799);
  expect(r.onPause).not.toHaveBeenCalled();
  expect(r.commits()).toBe(0);
  vi.advanceTimersByTime(1);
  // The pause commits the utterance, so its words settle and it is metered.
  expect(r.onPause.mock.calls).toEqual([["Open desing"]]);
  expect(r.commits()).toBe(1);
  r.receive({ type: COMMITTED, item_id: "a" });
  r.receive({ type: COMPLETED, item_id: "a", transcript: "Open design" });
  // Settled words are the same pause again, at once.
  expect(r.onPause.mock.calls).toEqual([["Open desing"], ["Open design"]]);
  // Nothing new since the commit: the next pause does not commit again.
  vi.advanceTimersByTime(800);
  expect(r.commits()).toBe(1);

  // Stop commits anyway, and the provider's answer ends it.
  listening.stop();
  expect(r.commits()).toBe(2);
  expect(r.stopTrack).toHaveBeenCalled();
  expect(r.onEnd).not.toHaveBeenCalled();
  r.receive(EMPTY);
  expect(r.onEnd.mock.calls).toEqual([["Open design"]]);
  expect(r.close).toHaveBeenCalledOnce();
  expect(r.onState).toHaveBeenLastCalledWith("idle");
  r.receive({ type: DELTA, item_id: "b", delta: " late" });
  expect(r.onText).toHaveBeenCalledTimes(3);
});

it("commits on stop, stops the microphone, and waits for the last words", async () => {
  const r = hosted();
  const listening = await r.start();
  r.receive({ type: DELTA, item_id: "a", delta: "jump to" });
  listening.stop();
  expect(r.commits()).toBe(1);
  expect(r.stopTrack).toHaveBeenCalled();
  r.receive({ type: COMMITTED, item_id: "a" });
  expect(r.onEnd).not.toHaveBeenCalled();
  r.receive({ type: COMPLETED, item_id: "a", transcript: "Jump to general." });
  expect(r.onEnd.mock.calls).toEqual([["Jump to general."]]);
  expect(r.close).toHaveBeenCalledOnce();

  // Stopped before the first word arrived: the words still come.
  const quick = hosted();
  const short = await quick.start();
  short.stop();
  expect(quick.commits()).toBe(1);
  quick.receive({ type: COMMITTED, item_id: "b" });
  quick.receive({ type: DELTA, item_id: "b", delta: "yes" });
  expect(quick.onEnd).not.toHaveBeenCalled();
  quick.receive({ type: COMPLETED, item_id: "b", transcript: "Yes." });
  expect(quick.onEnd.mock.calls).toEqual([["Yes."]]);
});

it("reports what it heard when the final words don't come", async () => {
  const r = hosted();
  const listening = await r.start();
  r.receive({ type: DELTA, item_id: "a", delta: "jump to" });
  listening.stop();
  vi.advanceTimersByTime(999);
  expect(r.onEnd).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(r.onEnd.mock.calls).toEqual([["jump to"]]);
});

it("ends after a long pause, and after silence without reporting", async () => {
  const r = hosted();
  await r.start();
  r.receive({ type: DELTA, item_id: "a", delta: "hello" });
  vi.advanceTimersByTime(800);
  r.receive({ type: COMMITTED, item_id: "a" });
  r.receive({ type: COMPLETED, item_id: "a", transcript: "Hello." });
  vi.advanceTimersByTime(2_200);
  expect(r.onEnd.mock.calls).toEqual([["Hello."]]);

  const quiet = hosted();
  await quiet.start();
  vi.advanceTimersByTime(8_000);
  expect(quiet.onEnd).not.toHaveBeenCalled();
  expect(quiet.onState).toHaveBeenLastCalledWith("idle");
  expect(quiet.commits()).toBe(0);
});

it("reports the provider's refusal and releases the microphone", async () => {
  const r = hosted({ outcome: "failed", reason: "rate_limited" });
  await r.start();
  expect(r.onError).toHaveBeenCalledWith(
    "rate_limited",
    expect.stringContaining("Try again later"),
  );
  expect(r.stopTrack).toHaveBeenCalledOnce();
  expect(r.close).toHaveBeenCalledOnce();
  expect(r.onState).toHaveBeenLastCalledWith("idle");
});

it("ignores an empty commit but fails on Realtime errors and a failed connection", async () => {
  const r = hosted();
  await r.start();
  r.receive(EMPTY);
  expect(r.onError).not.toHaveBeenCalled();
  r.receive({ type: "error", error: { message: "boom" } });
  expect(r.onError).toHaveBeenCalledWith("service_error", "boom");
  expect(r.close).toHaveBeenCalledOnce();

  const words = hosted();
  await words.start();
  words.receive({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "a",
    error: { message: "transcription failed" },
  });
  expect(words.onError).toHaveBeenCalledWith(
    "service_error",
    "transcription failed",
  );

  const network = hosted();
  await network.start();
  network.disconnect();
  expect(network.onError).toHaveBeenCalledWith(
    "service_error",
    expect.any(String),
  );
  expect(network.onState).toHaveBeenLastCalledWith("idle");
});

it("reports the call's cap when the provider grants one", async () => {
  const capped = hosted({
    outcome: "answered",
    sdp: "answer",
    maxSeconds: 900,
  });
  await capped.start();
  expect(capped.onCallLimit).toHaveBeenCalledExactlyOnceWith(900);

  const uncapped = hosted();
  await uncapped.start();
  expect(uncapped.onCallLimit).not.toHaveBeenCalled();
});

it("reports what it heard when the provider hangs up", async () => {
  const r = hosted();
  await r.start();
  r.receive({ type: DELTA, item_id: "a", delta: "cut off" });
  r.channel.dispatchEvent(new Event("close"));
  expect(r.onEnd.mock.calls).toEqual([["cut off"]]);
});

it("releases a microphone granted after cancellation", async () => {
  const r = hosted();
  let grant!: () => void;
  r.getUserMedia.mockImplementationOnce(
    () => new Promise((done) => (grant = () => done(r.stream))),
  );
  const listening = listenHosted(r.options, r.connect);
  await vi.advanceTimersByTimeAsync(0);
  listening.cancel();
  grant();
  await vi.advanceTimersByTimeAsync(0);
  expect(r.stopTrack).toHaveBeenCalledOnce();
  expect(r.replaceTrack).not.toHaveBeenCalled();
  expect(r.onEnd).not.toHaveBeenCalled();
});

it("maps a denied microphone to denied", async () => {
  const r = hosted();
  r.getUserMedia.mockRejectedValueOnce(
    new DOMException("nope", "NotAllowedError"),
  );
  await r.start();
  expect(r.onError).toHaveBeenCalledWith("denied", expect.any(String));
});
