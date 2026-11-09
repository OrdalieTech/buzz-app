import { useCallback, useEffect, useRef, useState } from "react";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { WorkStop } from "./work-stop";

const HOSTED_STOP_MS = 30_000;

/** Hosted stops remain pending until evidence ends or the retry window expires. */
export function useWorkStops(controls: readonly WorkStop[]) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const attempts = useRef(new Map<string, symbol>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const notify = useToastNotification();
  const forget = useCallback((key: string) => {
    attempts.current.delete(key);
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setPending((prior) => {
      if (!prior.has(key)) return prior;
      const next = new Set(prior);
      next.delete(key);
      return next;
    });
  }, []);
  const live = JSON.stringify(controls.map((control) => control.key).sort());
  useEffect(() => {
    const keys = new Set<string>(JSON.parse(live));
    for (const key of attempts.current.keys()) if (!keys.has(key)) forget(key);
  }, [live, forget]);
  useEffect(() => {
    const active = attempts.current;
    const timeouts = timers.current;
    return () => {
      active.clear();
      for (const timer of timeouts.values()) clearTimeout(timer);
      timeouts.clear();
    };
  }, []);
  const stop = async (control: WorkStop, name: string) => {
    const { key } = control;
    if (attempts.current.has(key)) return;
    const attempt = Symbol(key);
    attempts.current.set(key, attempt);
    setPending((prior) => new Set(prior).add(key));
    try {
      const running = await control.interrupt();
      const current = attempts.current.get(key);
      if (current && current !== attempt) return;
      // Local completion can retire the preview before its promise resolves.
      // Still confirm the successful stop; hosted work needs live evidence.
      if (!current && !control.lifecycle) return;
      if (control.lifecycle || running === false) {
        if (current) forget(key);
        notify(
          control.lifecycle
            ? `Stopped ${name}`
            : `${name} had nothing running to stop`,
          control.lifecycle ? "success" : "info",
        );
      } else {
        notify(`Stopping ${name}`, "success");
        timers.current.set(
          key,
          setTimeout(() => {
            if (attempts.current.get(key) !== attempt) return;
            forget(key);
            notify(`${name} hasn’t stopped yet. Try again.`, "error");
          }, HOSTED_STOP_MS),
        );
      }
    } catch (error) {
      const current = attempts.current.get(key);
      if (current && current !== attempt) return;
      if (current) forget(key);
      notify(
        `Couldn’t stop ${name}. ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };
  return { pending, stop };
}
