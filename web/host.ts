import { mockIPC } from "@tauri-apps/api/mocks";
import { commands } from "./commands.ts";

// Answers @tauri-apps/api's IPC in the page, as tests/fixtures/mocked-native-ipc.tsx
// does, without setting isTauri(). mockIPC also provides the callback
// registry that Channel needs.
mockIPC((command, args) => {
  const run = commands[command];
  if (!run) throw `${command} isn't available in the browser.`;
  return run((args ?? {}) as Record<string, unknown>, command);
});
// Relay media keeps its URL until the media service worker signs it.
Object.assign(Reflect.get(window, "__TAURI_INTERNALS__"), {
  convertFileSrc: (url: string) => url,
});
