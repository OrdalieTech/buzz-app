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
  // Relay media keeps its URL until the media service worker signs it.
  convertFileSrc: (url: string) => url,
});
