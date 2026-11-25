// One listen, from the microphone to a finished transcript. Providers
// transcribe over WebRTC: this side holds the microphone, the peer connection
// and its `oai-events` data channel, and the provider only answers the offer.
// A listen reports the transcript as it changes, a short pause while
// listening goes on, and the end, after a long pause or `stop`.

/**
 * - `unavailable`: no provider can listen, or this device can't.
 * - `denied`: microphone access is off, so the person has to allow it in
 *   System Settings.
 * - `missing_credentials`: the provider has no sign-in.
 * - `unauthorized`: the provider refused this account or community.
 * - `rate_limited`: the community has used its speech for now.
 */
export type SpeechFailure =
  | "unavailable"
  | "denied"
  | "missing_credentials"
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "service_error"
  | "invalid_response";
export const SPEECH_FAILURES: readonly SpeechFailure[] = [
  "unavailable",
  "denied",
  "missing_credentials",
  "unauthorized",
  "invalid_request",
  "rate_limited",
  "timeout",
  "service_error",
  "invalid_response",
];

/** A call cap a caller may ask for or a provider may grant: whole seconds,
 * more than none. */
export const isCallSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export type ListenState = "starting" | "listening" | "idle";

export type ListenOptions = Readonly<{
  /** The Buzz community (its relay URL) the speech is for. Providers that
   * bill the community, such as Builderlab, need it. */
  community?: string;
  /** How long the call may last, in whole seconds, for speech longer
   * than a command. Without it the provider's default applies (30 seconds
   * on Builderlab), so a forgotten microphone cannot run long. The provider
   * may grant less; see `onCallLimit`. */
  maxSeconds?: number;
  /** The cap the provider granted this call, in seconds, once it
   * answers. It hangs up then, and listening ends with what was heard. */
  onCallLimit?(maxSeconds: number): void;
  /** The transcript so far, each time it changes. */
  onText(text: string): void;
  /** The transcript so far, once speech pauses briefly; listening goes on.
   * It can come again for the same pause when the provider settles words. */
  onPause?(text: string): void;
  /** The finished transcript, once speech stops or the caller stops. Not
   * called when nothing was heard. */
  onEnd(text: string): void;
  /** Listening failed; nothing follows. */
  onError?(failure: SpeechFailure, message: string): void;
  onState?(state: ListenState): void;
}>;

export type Listening = Readonly<{
  /** Ends listening and reports what was heard. */
  stop(): void;
  /** Ends listening without reporting it. */
  cancel(): void;
}>;

/** Speech that stops producing text this long has paused: reported, and
 * committed, but listening goes on. */
const PAUSE_MS = 800;
/** Speech that stops producing text this long has ended. */
const END_MS = 3_000;
/** Nothing heard this long after starting ends the attempt. */
const SILENCE_MS = 8_000;
/** How long an ending waits for the final transcript before reporting what
 * was heard so far. */
const FINAL_MS = 1_000;

const MESSAGES: Readonly<Record<SpeechFailure, string>> = {
  unavailable: "Speech to text isn’t available.",
  denied: "Allow Buzz to use your microphone to use speech to text.",
  missing_credentials: "Sign in to use speech to text.",
  unauthorized: "Speech to text isn’t available for this account.",
  invalid_request: "Speech to text couldn’t start.",
  rate_limited: "Speech to text is used up for now. Try again later.",
  timeout: "Speech to text took too long to connect.",
  service_error: "Speech to text couldn’t connect.",
  invalid_response: "Speech to text got an unreadable answer.",
};
export const speechMessage = (failure: SpeechFailure) => MESSAGES[failure];

const DELTA = "conversation.item.input_audio_transcription.delta";
const COMPLETED = "conversation.item.input_audio_transcription.completed";
const FAILED = "conversation.item.input_audio_transcription.failed";
const COMMIT = JSON.stringify({ type: "input_audio_buffer.commit" });
/** The provider's answer to a commit that had audio: its item. */
const COMMITTED = "input_audio_buffer.committed";
/** The answer to a commit with nothing new to transcribe; harmless. */
const COMMIT_EMPTY = "input_audio_buffer_commit_empty";

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
};

/** The transcript as Realtime items, in the order they started. Deltas add to
 * their item; `completed` replaces it with the final text, which can differ.
 * A committed item counts before its first word. */
export function transcriptItems() {
  const items: { id: string; text: string; done: boolean }[] = [];
  const item = (id = "") => {
    const found = items.find((each) => each.id === id);
    if (found) return found;
    const next = { id, text: "", done: false };
    items.push(next);
    return next;
  };
  return {
    /** Applies one event; true when it changed an item. */
    apply(event: RealtimeEvent) {
      if (event.type === COMMITTED) {
        item(event.item_id);
        return false;
      }
      if (event.type === DELTA) {
        const target = item(event.item_id);
        if (target.done || !event.delta) return false;
        target.text += event.delta;
        return true;
      }
      if (event.type === COMPLETED) {
        const target = item(event.item_id);
        target.text = event.transcript ?? target.text;
        target.done = true;
        return true;
      }
      return false;
    },
    text: () =>
      items
        .map((each) => each.text.trim())
        .filter(Boolean)
        .join(" "),
    /** Every item is final. */
    settled: () => items.every((each) => each.done),
  };
}

export type Connect = (
  offer: string,
  signal: AbortSignal,
) => Promise<
  | Readonly<{ outcome: "answered"; sdp: string; maxSeconds?: number }>
  | Readonly<{ outcome: "failed"; reason: SpeechFailure }>
>;

/** One listen through a provider: OpenAI Realtime transcription over
 * WebRTC, with the offer answered by `connect`. Turn detection is the
 * caller's: each pause and the end commit the audio sent since the last
 * commit, which finalizes its words and lets the provider meter what was
 * transcribed. The provider answers every commit, with its item or as empty,
 * so the end waits for those answers and the items' final words. */
export function listenHosted(
  options: ListenOptions,
  connect: Connect,
): Listening {
  const items = transcriptItems();
  const abort = new AbortController();
  let stream: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let ended = false;
  let ending = false;
  /** The transcript last reported. */
  let text = "";
  /** The pause or end the listen waits for, and the short pause. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pause: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  /** Words arrived since the last commit. */
  let uncommitted = false;
  /** Commits the provider has not answered yet. */
  let unanswered = 0;
  const state = (next: ListenState) => {
    if (!ended) options.onState?.(next);
  };
  /** Waits `ms`, then runs `then`, replacing any earlier wait. */
  const wait = (ms: number, then: () => void) => {
    clearTimeout(timer);
    timer = setTimeout(then, ms);
  };
  /** Commits the audio sent since the last commit: only once words arrived,
   * so silence isn't metered, unless `always`. */
  const commit = (always = false) => {
    if (channel?.readyState !== "open" || !(always || uncommitted)) return;
    uncommitted = false;
    unanswered += 1;
    channel.send(COMMIT);
  };
  const stopMicrophone = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
  };
  const close = (report: boolean) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    clearTimeout(pause);
    abort.abort();
    channel?.close();
    peer?.close();
    stopMicrophone();
    options.onState?.("idle");
    if (report && text.trim()) options.onEnd(text.trim());
  };
  /** Ending, and every word is in: report them. */
  const settle = () => {
    if (ending && unanswered <= 0 && items.settled()) close(true);
  };
  /** Ends listening once the last commit's words are in. Stop commits
   * even before the first word, so speech cut short still counts. */
  const end = (stopped: boolean) => {
    if (ended || ending) return;
    ending = true;
    stopMicrophone();
    commit(stopped);
    wait(FINAL_MS, () => close(true));
    settle();
  };
  const finish = () => end(false);
  const cancel = () => close(false);
  const fail = (failure: SpeechFailure, message = MESSAGES[failure]) => {
    if (ended) return;
    options.onError?.(failure, message);
    close(false);
  };
  /** New words. Words `settled` by the provider's final text on speech that
   * already paused are reported as the same pause, and never extend
   * listening. */
  const heard = (settled: boolean) => {
    const next = items.text();
    if (next === text) return;
    text = next;
    options.onText(text);
    if (ending || ended) return;
    if (settled && paused) return options.onPause?.(text);
    paused = false;
    clearTimeout(pause);
    pause = setTimeout(() => {
      paused = true;
      commit();
      options.onPause?.(text);
    }, PAUSE_MS);
    wait(END_MS, finish);
  };
  const receive = (event: RealtimeEvent) => {
    if (event.type === "error" && event.error?.code === COMMIT_EMPTY) {
      unanswered -= 1;
      return settle();
    }
    if (event.type === "error" || event.type === FAILED)
      return fail("service_error", event.error?.message);
    if (event.type === COMMITTED) unanswered -= 1;
    if (items.apply(event)) {
      if (event.type === DELTA) uncommitted = true;
      heard(event.type === COMPLETED);
    }
    settle();
  };
  state("starting");
  void (async () => {
    try {
      // The offer needs no microphone: asking for it and connecting run
      // side by side.
      const connection = new RTCPeerConnection();
      peer = connection;
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") fail("service_error");
      };
      const sender = peer.addTransceiver("audio").sender;
      channel = peer.createDataChannel("oai-events");
      // Transcripts arrive here, so listening starts once it opens.
      channel.addEventListener("open", () => {
        state("listening");
        if (!ending && !text) wait(SILENCE_MS, finish);
      });
      channel.addEventListener("message", (message) => {
        if (ended) return;
        let event: RealtimeEvent;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (event && typeof event === "object") receive(event);
      });
      // The provider hangs up at its call limit: report what was heard.
      channel.addEventListener("close", () => close(true));
      const offer = await peer.createOffer();
      if (ended) return;
      await peer.setLocalDescription(offer);
      if (ended) return;
      const microphone = navigator.mediaDevices
        .getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
        })
        .then((media) => {
          stream = media;
          // Stopped meanwhile: release the microphone at once.
          if (ended || ending)
            for (const track of media.getTracks()) track.stop();
          return media;
        });
      const [media, answer] = await Promise.all([
        microphone,
        connect(offer.sdp ?? "", abort.signal),
      ]);
      if (ended) return;
      if (answer.outcome === "failed") return fail(answer.reason);
      if (answer.maxSeconds !== undefined)
        options.onCallLimit?.(answer.maxSeconds);
      await sender.replaceTrack(media.getAudioTracks()[0] ?? null);
      if (ended) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) {
      const exception = error instanceof Error || error instanceof DOMException;
      if (exception && error.name === "NotAllowedError") fail("denied");
      else fail("service_error", exception ? error.message : undefined);
    }
  })();
  return { stop: () => end(true), cancel };
}
