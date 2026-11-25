// React access to the speech service: one listen at a time, with its state.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ListenState, Speech, SpeechFailure } from "./service";

/** What a listen needs of the speech service. */
export type SpeechListener = Pick<Speech, "listen">;

export type DictationState = ListenState;

/** One listen at a time through `speech`. Callbacks may change between
 * renders; the latest are used. */
export function useDictation(
  speech: SpeechListener | undefined,
  callbacks: {
    onText: (text: string) => void;
    onPause?: (text: string) => void;
    onEnd: (text: string) => void;
    onError?: (failure: SpeechFailure, message: string) => void;
  },
) {
  const [state, setState] = useState<DictationState>("idle");
  const run = useRef<{ stop(): void; cancel(): void } | undefined>(undefined);
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const stop = useCallback(() => run.current?.stop(), []);
  const cancel = useCallback(() => run.current?.cancel(), []);
  useEffect(() => cancel, [cancel]);
  const start = useCallback(
    (options: { community?: string } = {}) => {
      if (run.current || !speech) return;
      // Set before listening starts: a listen can end before it returns.
      const token = { stop() {}, cancel() {} };
      run.current = token;
      const current = speech.listen({
        ...options,
        onText: (text) => latest.current.onText(text),
        onPause: (text) => latest.current.onPause?.(text),
        onEnd: (text) => latest.current.onEnd(text),
        onError: (failure, message) =>
          latest.current.onError?.(failure, message),
        onState: (next) => {
          if (next === "idle" && run.current === token) run.current = undefined;
          setState(next);
        },
      });
      token.stop = current.stop;
      token.cancel = current.cancel;
    },
    [speech],
  );
  return { state, start, stop, cancel };
}
