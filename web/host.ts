import { mockIPC } from "@tauri-apps/api/mocks";
import { commands } from "./commands.ts";

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
