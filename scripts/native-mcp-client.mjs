import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { nativeMcpInstance } from "./desktop-config.mjs";

// The MCP client .mcp.json registers, connected through a loopback relay. The
// client connects to whichever app answers and reconnects without checking, so
// the relay forwards commands only over a connection to an app that reported
// this worktree's identifier, a debug build and a main window.
const PROBE_HEADER = "x-buzz-native-mcp-relay";
const PROBE = JSON.stringify({
  id: "buzz-target",
  command: "invoke_tauri",
  args: { command: "plugin:mcp-bridge|get_backend_state", args: {} },
});

function openTestInstance(candidate, identifier) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${candidate}`, {
      headers: { [PROBE_HEADER]: "1" },
    });
    const timer = setTimeout(() => finish(false), 2000);
    function finish(matches) {
      clearTimeout(timer);
      // The relay attaches its own listeners to a match.
      socket.removeAllListeners().on("error", () => {});
      if (!matches) socket.terminate();
      resolve(matches ? socket : undefined);
    }
    socket.on("error", () => finish(false));
    socket.on("open", () => socket.send(PROBE));
    socket.on("message", (data) => {
      try {
        const { id, success, data: state } = JSON.parse(data);
        if (id !== "buzz-target") return;
        finish(
          success === true &&
            state?.app?.identifier === identifier &&
            state.environment?.debug === true &&
            state.windows.some((window) => window?.label === "main"),
        );
      } catch {
        finish(false);
      }
    });
  });
}

// The bridge takes the first free port of the 100 from its base, so the lowest
// match wins. Probing in parallel keeps a scan within one probe timeout, well
// inside the client's 5 s request timeout, after which it would scan on its own.
async function connectTestInstance(identifier, port) {
  const probes = Array.from({ length: 100 }, (_, offset) =>
    openTestInstance(port + offset, identifier),
  );
  for (const [index, probe] of probes.entries()) {
    const socket = await probe;
    if (!socket) continue;
    for (const extra of probes.slice(index + 1))
      extra.then((other) => other?.terminate());
    return socket;
  }
}

export function startRelay(identifier, port) {
  const refusal = `No debug test instance ${identifier} with a main window on ports ${port}-${port + 99}. Launch it with bin/node scripts/desktop-mcp.mjs.`;
  // Refuse browser pages, as the bridge does, and other relays' probes, which
  // would otherwise start scans of their own.
  const relay = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ req }) =>
      !req.headers.origin &&
      !req.headers["sec-websocket-origin"] &&
      !req.headers[PROBE_HEADER],
  });
  relay.on("connection", (client) => {
    let upstream;
    let unanswered;
    const refuse = (id) =>
      client.send(JSON.stringify({ id, success: false, error: refusal }));
    let queue = Promise.resolve();
    // Commands run in order. Each finds and checks the app if none is open;
    // until one is found, each command fails and the next looks again. When the
    // app goes, its unanswered commands fail and the client stays connected: a
    // closed connection or failed start makes the client fall back to an
    // unchecked port scan of its own.
    client.on("message", (data) => {
      const text = data.toString();
      queue = queue
        .then(async () => {
          if (upstream?.readyState !== WebSocket.OPEN) {
            upstream = await connectTestInstance(identifier, port);
            const sent = new Set();
            unanswered = sent;
            upstream
              ?.on("message", (reply) => {
                try {
                  sent.delete(JSON.parse(reply).id);
                } catch {}
                client.send(reply.toString());
              })
              .on("close", () => sent.forEach(refuse));
          }
          // The client may have gone while the app was being found.
          if (client.readyState !== WebSocket.OPEN) return;
          const { id } = JSON.parse(text);
          // The app may have closed while lower ports were still being probed.
          if (upstream?.readyState !== WebSocket.OPEN) return refuse(id);
          unanswered.add(id);
          upstream.send(text);
        })
        .catch(() => {});
    });
    client.on("close", () => queue.then(() => upstream?.close()));
    client.on("error", () => {});
  });
  return relay;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { identifier, port } = nativeMcpInstance(root);
  const relay = startRelay(identifier, port);
  relay.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  relay.on("listening", () => {
    // The client reads these when it connects, not when it loads. Its package
    // exports only its API, so load the server entry by path; loading starts it.
    process.env.MCP_BRIDGE_HOST = "127.0.0.1";
    process.env.MCP_BRIDGE_PORT = String(relay.address().port);
    // MCP clients stop a stdio server by closing its input first; the relay
    // would otherwise keep this process alive.
    process.stdin.on("end", () => process.exit(0));
    import(
      new URL(
        "../node_modules/@hypothesi/tauri-mcp-server/dist/index.js",
        import.meta.url,
      ).href
    );
  });
}
