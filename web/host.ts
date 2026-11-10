import { mockIPC } from "@tauri-apps/api/mocks";
import { ACCENT_KEY, parseAccent } from "../src/shared/theme/accent.ts";
import {
  DENSITY_KEY,
  parseMessageDensity,
} from "../src/shared/theme/service.ts";
import { commands } from "./commands.ts";

// A distributor's appearance defaults (VITE_BUZZ_DEFAULT_ACCENT, e.g.
// "cobalt", and VITE_BUZZ_DEFAULT_DENSITY, "compact"), saved for whoever has
// not chosen yet on this device; Appearance settings still change them.
for (const [key, value, parse] of [
  [ACCENT_KEY, import.meta.env.VITE_BUZZ_DEFAULT_ACCENT, parseAccent],
  [DENSITY_KEY, import.meta.env.VITE_BUZZ_DEFAULT_DENSITY, parseMessageDensity],
] as const)
  try {
    if (value && parse(value) === value && localStorage.getItem(key) === null)
      localStorage.setItem(key, value);
  } catch {}

// Message editors ask the keyboard to correct, capitalize and suggest, which
// upstream turns off for desktop rich text (EditableInput's attributes). The
// editor ignores attribute changes on its root, so these stay.
const keyboard = {
  autocorrect: "on",
  autocapitalize: "sentences",
  writingsuggestions: "true",
};
new MutationObserver((records) => {
  for (const { target } of records)
    if ((target as Element).matches('[contenteditable][role="textbox"]'))
      for (const [name, value] of Object.entries(keyboard))
        if ((target as Element).getAttribute(name) !== value)
          (target as Element).setAttribute(name, value);
}).observe(document, {
  subtree: true,
  attributes: true,
  attributeFilter: ["contenteditable", ...Object.keys(keyboard)],
});

// Answers @tauri-apps/api's IPC in the page, as tests/fixtures/mocked-native-ipc.tsx
// does, without setting isTauri(). mockIPC also provides the callback
// registry that Channel needs.
mockIPC(() => undefined);
Object.assign(Reflect.get(window, "__TAURI_INTERNALS__"), {
  // mockIPC's invoke drops the options; uploads send their headers there.
  async invoke(
    command: string,
    args?: Record<string, unknown>,
    options?: { headers?: HeadersInit },
  ) {
    const run = commands[command];
    if (!run) throw `${command} isn't available in the browser.`;
    return run(args ?? {}, command, new Headers(options?.headers));
  },
  // Relay media goes through the service worker (web/sw.ts), which signs each
  // read, at the dev broker's same-origin path that upstream treats as relay
  // media (isProxySource in src/features/messages/attachment-source.ts).
  convertFileSrc: (url: string) =>
    `/api/relay/${encodeURIComponent(new URL(url).host)}/media?url=${encodeURIComponent(url)}`,
});
