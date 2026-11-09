import { useEffect, useState, useSyncExternalStore } from "react";
import {
  cursorPosition,
  currentMonitor,
  primaryMonitor,
  monitorFromPoint,
  getCurrentWindow,
} from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { launchVisible, subscribeLaunch } from "../../app/launch";

const KEY = "buzz-mac-welcome-intro.v1";
export function useWelcomeIntro(welcome: boolean) {
  const launching = useSyncExternalStore(subscribeLaunch, launchVisible);
  const [phase, setPhase] = useState<"waiting" | "running" | "done">(() => {
    try {
      return welcome &&
        document.documentElement.dataset.welcomeIntro === "pending" &&
        isTauri() &&
        /Mac/i.test(navigator.platform) &&
        !localStorage.getItem(KEY) &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "waiting"
        : "done";
    } catch {
      return "done";
    }
  });
  const active = phase !== "done";
  useEffect(() => {
    if (!welcome) return;
    if (!active) {
      if (document.documentElement.dataset.welcomeIntro === "pending") {
        delete document.documentElement.dataset.welcomeIntro;
        void invoke("plugin:window|show", { label: "main" }).catch(() => {});
      }
      return;
    }
    if (launching) return;
    let cancelled = false;
    const finish = () => {
      cancelled = true;
      delete document.documentElement.dataset.welcomeIntro;
      setPhase("done");
      void getCurrentWindow()
        .show()
        .catch(() => {});
    };
    let timer: number | undefined;
    const prepare = async () => {
      const window = getCurrentWindow();
      const fullscreen = await window.isFullscreen();
      if (cancelled) return;
      await invoke("onboarding_preserve_window");
      if (!fullscreen) {
        const cursor = await cursorPosition();
        const monitor =
          (await monitorFromPoint(cursor.x, cursor.y)) ??
          (await currentMonitor()) ??
          (await primaryMonitor());
        if (cancelled) return;
        await window.unmaximize();
        if (!monitor) throw new Error("Display unavailable");
        // macOS maximize animates even when show follows its resolved promise.
        // Apply the display bounds directly while the window is still hidden.
        await window.setPosition(monitor.workArea.position);
        await window.setSize(monitor.workArea.size);
      }
      await window.show();
      await window.unminimize();
      await window.setFocus();
      if (cancelled) return;
      // Do not consume the one-time intro while another app still owns focus.
      const focusDeadline = performance.now() + 2000;
      while (
        !cancelled &&
        !(await window.isFocused()) &&
        performance.now() < focusDeadline
      ) {
        await new Promise((resolve) =>
          globalThis.window.setTimeout(resolve, 50),
        );
      }
      if (cancelled) return;
      if (!(await window.isFocused())) {
        finish();
        return;
      }
      localStorage.setItem(KEY, "seen");
      document.documentElement.dataset.welcomeIntro = "running";
      setPhase("running");
      timer = globalThis.window.setTimeout(finish, 8400);
    };
    void prepare().catch((error) => {
      console.warn("Welcome intro preparation failed", error);
      finish();
    });
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");

    window.addEventListener("keydown", finish, { once: true });
    reduced.addEventListener("change", finish, { once: true });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("keydown", finish);
      reduced.removeEventListener("change", finish);
      delete document.documentElement.dataset.welcomeIntro;
    };
  }, [welcome, launching, active]);
  return phase;
}
