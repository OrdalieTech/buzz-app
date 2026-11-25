// Speech to text for app code and plugins. A caller listens with
// `ctx.speech.listen`; the provider this device chose in Settings
// transcribes. Providers are plugins: each registers with
// `ctx.speech.registerProvider` and answers a WebRTC offer, and Builderlab
// is the bundled one. The host owns the choice, the microphone, the call,
// the transcript and its pauses, so every provider reports the same events
// and fails for the same reasons.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import {
  SPEECH_FAILURES,
  isCallSeconds,
  listenHosted,
  type ListenOptions,
  type Listening,
} from "./listen";

export type {
  ListenOptions,
  Listening,
  ListenState,
  SpeechFailure,
} from "./listen";
import type { SpeechFailure } from "./listen";

/**
 * - `checking`: not known yet. A listen waits for it.
 * - `ready`: it can transcribe.
 * - `unconfirmed`: it may be able to, but could not check.
 * - `needs-setup`: it cannot until the user sets it up in Settings.
 */
export type SpeechProviderStatus =
  | "checking"
  | "ready"
  | "unconfirmed"
  | "needs-setup";

export type SpeechConnectRequest = Readonly<{
  /** The WebRTC SDP offer for one audio track and an `oai-events` data
   * channel, as OpenAI Realtime transcription takes it. */
  offer: string;
  /** The Buzz community (its relay URL) the speech is for. A provider that
   * bills the community, such as Builderlab, refuses a call without one. */
  community?: string;
  timeoutMs: number;
  /** The call's cap the caller asks for, in whole seconds. Without one the
   * provider uses its default, as voice commands do; a longer call is
   * always one the caller asked for. */
  maxSeconds?: number;
}>;

/** What a provider's `connect` resolves with. `maxSeconds` is the cap the
 * provider granted, when it says: it hangs up that long after answering. */
export type SpeechConnectReply =
  | Readonly<{ outcome: "answered"; sdp: string; maxSeconds?: number }>
  | Readonly<{ outcome: "failed"; reason: SpeechFailure }>;

/** A speech provider, as a plugin registers it. It answers the host's
 * offer with a transcription session's SDP answer; audio then streams peer to
 * peer and transcripts arrive on the data channel as Realtime events. */
export type SpeechProvider = Readonly<{
  /** Unique within the plugin. */
  id: string;
  /** The name Settings shows, such as "Builderlab". */
  label: string;
  /** One line about what it uses, such as "Use your Builderlab account." */
  description: string;
  status(): SpeechProviderStatus;
  subscribe(listener: () => void): () => void;
  /** The host stops waiting at the deadline and aborts `signal`. */
  connect(
    request: SpeechConnectRequest,
    options: { signal: AbortSignal },
  ): Promise<SpeechConnectReply>;
  /** Its settings, shown under Settings > Speech to text while selected. */
  Settings?: ComponentType<{ active(): boolean }>;
  /** Lower comes first in Settings. Default 0. */
  order?: number;
}>;

export type RegisteredSpeechProvider = Contribution<SpeechProvider>;

/** What plugins get as `ctx.speech`. */
export interface Speech {
  /** Starts listening with the provider this device uses. Failures arrive
   * on `onError`; it never throws. */
  listen(options: ListenOptions): Listening;
  /** The key of the provider that listens, or undefined when none can. */
  backend(): string | undefined;
  /** That provider's status, or `unavailable` when there is none. */
  status(): SpeechProviderStatus | "unavailable";
  subscribe(listener: () => void): () => void;
  /** Offers a provider while the calling plugin runs, or until the
   * returned function removes it. The user chooses it in Settings. */
  registerProvider(provider: SpeechProvider): () => void;
  /** Clears a saved choice for a retired provider owned by this plugin. */
  retireProvider(id: string): void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    speech: Speech;
  }
}

export const SPEECH_PROVIDER_KEY = "buzz-speech-provider.v1";
/** The provider that listens while the user has not chosen one. */
export const DEFAULT_SPEECH_PROVIDER = "block.builderlab/builderlab";
const CONNECT_TIMEOUT_MS = 20_000;

const orderOf = (provider: SpeechProvider) =>
  Number.isFinite(provider.order) ? (provider.order as number) : 0;
const byOrder = (a: RegisteredSpeechProvider, b: RegisteredSpeechProvider) =>
  orderOf(a) - orderOf(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** A provider's status; one that throws is unconfirmed. */
export const speechStatusOf = (
  provider: SpeechProvider,
): SpeechProviderStatus => {
  try {
    return provider.status();
  } catch {
    return "unconfirmed";
  }
};

/** Audio goes to the provider the user chose, or the default until they
 * choose. Speech can be private, so no other provider gets it without that
 * choice: while the chosen provider can't listen, speech is unavailable
 * rather than sent somewhere else. */
export class SpeechService extends Service implements Speech {
  private readonly registry;
  private chosen: string | undefined;
  private sorted: readonly RegisteredSpeechProvider[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(
    ctx: Context,
    private readonly storage: Storage | undefined = typeof window ===
    "undefined"
      ? undefined
      : window.localStorage,
  ) {
    super(ctx, "speech");
    this.registry = createContributions<SpeechProvider>(ctx);
    try {
      this.chosen = storage?.getItem(SPEECH_PROVIDER_KEY) ?? undefined;
    } catch {
      // Unreadable storage means no choice.
    }
    let stops: (() => void)[] = [];
    const watch = () => {
      for (const stop of stops) stop();
      this.sorted = Object.freeze([...this.registry.snapshot()].sort(byOrder));
      stops = this.sorted.map((provider) => {
        try {
          return provider.subscribe(() => this.notify());
        } catch {
          return () => {};
        }
      });
      this.notify();
    };
    ctx.effect(() => {
      const stop = this.registry.subscribe(watch);
      watch();
      return () => {
        stop();
        for (const each of stops) each();
        stops = [];
      };
    });
  }
  registerProvider(provider: SpeechProvider): () => void {
    return this.registry.register(this.ctx, provider);
  }
  retireProvider(id: string): void {
    const owner = this.ctx.pluginOwner;
    if (!owner)
      throw new Error("Only an installed plugin can retire a provider");
    if (!id || id.includes("/")) throw new Error("Invalid speech provider ID");
    if (this.chosen !== `${owner.id}/${id}`) return;
    this.storage?.removeItem(SPEECH_PROVIDER_KEY);
    this.chosen = undefined;
    this.notify();
  }
  /** Host-only: every provider, in Settings order. */
  providers = (): readonly RegisteredSpeechProvider[] => this.sorted;
  /** Host-only: a provider's status. */
  statusOf = (key: string): SpeechProviderStatus | undefined => {
    const entry = this.sorted.find((provider) => provider.key === key);
    return entry && speechStatusOf(entry);
  };
  /** The chosen provider, or the default until the user chooses: never
   * another, even while that one can't listen. */
  private route():
    | Readonly<{ key: string; status: SpeechProviderStatus }>
    | undefined {
    const key = this.chosen ?? DEFAULT_SPEECH_PROVIDER;
    const status = this.statusOf(key);
    return status === undefined ? undefined : { key, status };
  }
  backend = (): string | undefined => this.route()?.key;
  status = (): SpeechProviderStatus | "unavailable" =>
    this.route()?.status ?? "unavailable";
  /** Host-only: Settings chooses the provider. Not part of `Speech`. */
  setBackend(key: string): void {
    if (!this.sorted.some((provider) => provider.key === key)) return;
    const before = this.backend();
    this.chosen = key;
    try {
      this.storage?.setItem(SPEECH_PROVIDER_KEY, key);
    } catch {
      // Still in effect for this session.
    }
    if (before !== key) this.notify();
  }
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  listen(options: ListenOptions): Listening {
    const key = this.backend();
    const provider = this.sorted.find((entry) => entry.key === key);
    if (!provider) {
      queueMicrotask(() => {
        options.onError?.(
          "unavailable",
          "Speech to text isn’t set up. Choose a provider in Settings.",
        );
        options.onState?.("idle");
      });
      return { stop() {}, cancel() {} };
    }
    return listenHosted(options, async (offer, signal) => {
      const abort = new AbortController();
      const stop = () => abort.abort();
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, CONNECT_TIMEOUT_MS);
      try {
        const reply = await Promise.race([
          provider.connect(
            Object.freeze({
              offer,
              ...(options.community === undefined
                ? {}
                : { community: options.community }),
              ...(isCallSeconds(options.maxSeconds)
                ? { maxSeconds: options.maxSeconds }
                : {}),
              timeoutMs: CONNECT_TIMEOUT_MS,
            }),
            { signal: abort.signal },
          ),
          new Promise<SpeechConnectReply>((resolve) =>
            abort.signal.addEventListener(
              "abort",
              () => resolve({ outcome: "failed", reason: "timeout" }),
              { once: true },
            ),
          ),
        ]);
        if (
          reply?.outcome === "answered" &&
          typeof reply.sdp === "string" &&
          reply.sdp
        )
          return isCallSeconds(reply.maxSeconds)
            ? {
                outcome: "answered",
                sdp: reply.sdp,
                maxSeconds: reply.maxSeconds,
              }
            : { outcome: "answered", sdp: reply.sdp };
        if (reply?.outcome === "failed")
          return {
            outcome: "failed",
            reason: SPEECH_FAILURES.includes(reply.reason)
              ? reply.reason
              : "invalid_response",
          };
        return { outcome: "failed", reason: "invalid_response" };
      } catch {
        return { outcome: "failed", reason: "service_error" };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    });
  }
}
