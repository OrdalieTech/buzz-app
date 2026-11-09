import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeMcpInstance } from "./desktop-config.mjs";

// Launch this worktree's native MCP test instance; arguments pass to `just desktop`.
// `--print` prints the instance's identifier and base port without launching.
const root = fileURLToPath(new URL("../", import.meta.url));
const { identifier, port } = nativeMcpInstance(root);
console.log(
  `Native MCP test instance ${identifier}, bridge base port ${port}.`,
);
if (process.argv[2] === "--print") process.exit(0);
const result = spawnSync(
  "bin/just",
  [
    "desktop",
    "--features",
    "native-mcp",
    "--config",
    "src-tauri/tauri.native-mcp.conf.json",
    "--config",
    JSON.stringify({ identifier }),
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    stdio: "inherit",
    // An empty pin disables the legacy broker, which native_mcp.rs requires.
    // Saved organization sign-ins are keyed by profile, so the instance does not
    // restore another debug build's session.
    env: {
      BUZZODZ_PROFILE: `native-mcp-${identifier.slice(-12)}`,
      ...process.env,
      BUZZ_NATIVE_MCP_PORT: String(port),
      BUZZ_DEV_VIEWER: "",
    },
  },
);
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
