// CI's exact native fixture, without changing the user's Claude installation.
// It also checks the plugin pins the bytes the release publishes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PROTECTED_CLAUDE_VERSION as version } from "../src/bundled/claude-code/security.ts";

const platform = `darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
const plugin = JSON.parse(
  await readFile(
    new URL("../src/bundled/claude-code/manifest.json", import.meta.url),
    "utf8",
  ),
);
if (process.platform !== "darwin")
  throw new Error("This fixture requires macOS");
const base = `https://downloads.claude.ai/claude-code-releases/${version}`;
function download(path, destination) {
  const result = spawnSync(
    "curl",
    [
      "-fsSL",
      "--connect-timeout",
      "15",
      "--max-time",
      "300",
      "--speed-limit",
      "1024",
      "--speed-time",
      "60",
      ...(destination ? ["-o", destination] : []),
      `${base}/${path}`,
    ],
    { encoding: "utf8", timeout: 310000, maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(
      `Claude fixture download failed: ${result.stderr || result.error || result.status}`,
    );
  return result.stdout;
}
const manifest = JSON.parse(download("manifest.json"));
const checksum = manifest.platforms?.[platform]?.checksum;
if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum))
  throw new Error("The pinned release has no valid platform checksum");
for (const arch of ["arm64", "x64"]) {
  const pinned = plugin.host.processes.find(
    (process) => process.id === `claude-protected-${arch}`,
  )?.artifact?.sha256;
  if (
    typeof pinned !== "string" ||
    pinned !== manifest.platforms?.[`darwin-${arch}`]?.checksum
  )
    throw new Error(
      `The plugin's ${arch} Claude pin does not match the release`,
    );
}
const root = join(process.cwd(), "target/protected-claude-test");
await mkdir(root, { recursive: true });
const binary = join(root, "claude");
console.log(`Downloading pinned Claude ${version} (${platform})`);
download(`${platform}/claude`, binary);
const hash = createHash("sha256");
for await (const chunk of createReadStream(binary)) hash.update(chunk);
if (hash.digest("hex") !== checksum)
  throw new Error("The Claude fixture checksum does not match");
await chmod(binary, 0o755);
const result = spawnSync(binary, ["--version"], {
  encoding: "utf8",
  timeout: 15000,
});
if (result.status !== 0 || !result.stdout.startsWith(`${version} `))
  throw new Error(
    "The pinned Claude fixture did not start with the expected version",
  );
console.log(`Claude ${version} verified at ${binary}`);
