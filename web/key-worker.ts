import { setupCommands } from "./key-setup.ts";
import { keyCommands } from "./keys.ts";

// The only context that holds the secret key; the page sees results only.
self.onmessage = async ({ data: { id, command, args } }) => {
  try {
    const run = keyCommands[command] ?? setupCommands[command];
    if (!run) throw `${command} is not a key operation`;
    self.postMessage({ id, result: await run(args) });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
