// The browser host's command table: the native commands the chat app needs,
// answered here or by the key Worker. Every other command is refused, and
// unsupported.ts lists the ones the native host registers today.

// biome-ignore lint/suspicious/noExplicitAny: native IPC arguments are untyped JSON.
type Args = Record<string, any>;
export type Handler = (args: Args, command: string) => unknown;

let worker: Worker | undefined;
let next = 0;
const pending = new Map<
  number,
  [(value: unknown) => void, (reason: unknown) => void]
>();
function start() {
  const started = new Worker(new URL("./key-worker.ts", import.meta.url), {
    type: "module",
  });
  started.onmessage = ({ data: { id, result, error } }) => {
    const call = pending.get(id);
    pending.delete(id);
    if (error === undefined) call?.[0](result);
    else call?.[1](error);
  };
  started.onerror = () => {
    for (const [, reject] of pending.values())
      reject("Your identity is unavailable. Reload Buzz and try again.");
    pending.clear();
  };
  return started;
}

/** Runs the command of the same name in the key Worker (keys.ts). */
export const key: Handler = (args, command) =>
  new Promise((resolve, reject) => {
    worker ??= start();
    const id = next++;
    pending.set(id, [resolve, reject]);
    worker.postMessage({ id, command, args });
  });
/** Saving a key also asks the browser not to evict this origin's storage. */
const saved: Handler = async (args, command) => {
  const viewer = await key(args, command);
  void navigator.storage?.persist?.();
  return viewer;
};

export const commands: Record<string, Handler> = {
  identity_restore: key,
  identity_create: saved,
  identity_import: saved,
  identity_import_legacy: saved,
  identity_export: key,
  identity_legacy_available: key,
  legacy_communities: (_, command) =>
    key({ saved: localStorage.getItem("buzz-communities") }, command),
  async sign_out(args, command) {
    await key(args, command);
    if (args.wipe) {
      localStorage.clear();
      sessionStorage.clear();
      for (const { name } of (await indexedDB.databases?.()) ?? [])
        if (name) indexedDB.deleteDatabase(name);
    }
    // Native relaunches the app after sign-out.
    location.reload();
  },
  sign_out_wipe_refusal: () => null,
  // Block's key backup service is not configured for this host.
  nsec_backup_available: () => false,
  relay_sign: key,
  relay_http: key,
  relay_http_cancel: key,
  relay_verify_signatures: key,
  relay_channel_sign: key,
  relay_channel_publish: key,
  relay_direct_message: key,
  relay_decode_read_state: key,
  relay_sign_read_state: key,
  relay_publish_read_state: key,
  relay_decode_sidebar: key,
  relay_sign_sidebar: key,
  // The relay's https://<host>/invite/<code> links open the app (Caddy serves
  // it for every page); hand the code to the join flow as buzz://join would.
  deep_link_take() {
    const code = /^\/invite\/([^/]+)\/?$/.exec(location.pathname)?.[1];
    if (!code) return [];
    history.replaceState(history.state, "", `/${location.hash}`);
    return [
      `buzz://join?${new URLSearchParams({ relay: location.origin, code })}`,
    ];
  },
  deep_link_watch: () => undefined,
  // "public" makes relay/native-socket.ts open a browser WebSocket.
  relay_socket_connect: () => "public",
  relay_socket_close: () => undefined,
};
