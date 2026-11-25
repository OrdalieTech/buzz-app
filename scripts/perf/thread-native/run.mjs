// Native macOS thread-scroll comparison (docs/performance.md#native-thread-scrolling).
// Starts the mock workload host and the desktop app, then alternates frontend
// builds (ABBA) over identical trackpad flings, recording in-app frames and a
// constant-rate video of the thread pane for every run.
//
//   bin/node scripts/perf/thread-native/run.mjs --arms base=origin/main,head=worktree --runs 4
//
// Needs a logged-in macOS session, Screen Recording and Accessibility
// permission for the terminal, a quiet machine and the main display at 60 Hz.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { frameMetrics, summarize, videoMetrics } from "./analyze.mjs";
import { fitWindow, REFERENCE_WINDOW, threadCapture } from "./geometry.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const { values } = parseArgs({
  options: {
    arms: { type: "string", default: "base=HEAD~1,head=worktree" },
    runs: { type: "string", default: "4" },
    out: { type: "string" },
    port: { type: "string", default: "1460" },
  },
});
const arms = values.arms.split(",").map((pair) => pair.split("="));
const runsPerArm = Number(values.runs);
const host = `http://127.0.0.1:${values.port}`;
const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const out = values.out ?? join(root, `test-results/perf-native/${stamp}`);
mkdirSync(join(out, "videos"), { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function stopCapture(child, closed) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
    const grace = await withTimeout(closed, 2_000);
    if (grace) return grace;
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  return (await withTimeout(closed, 2_000)) ?? { timedOut: true };
}

// ffmpeg lists devices on stderr and exits non-zero.
const device = spawnSync(
  "ffmpeg",
  ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
  { encoding: "utf8" },
).stderr?.match(/\[(\d+)\] Capture screen 0/)?.[1];
if (device === undefined)
  throw new Error("ffmpeg cannot capture the main display (Screen Recording?)");
const drive = join(out, "drive");
execFileSync("swiftc", ["-O", join(here, "drive.swift"), "-o", drive]);
const input = (...args) => execFileSync(drive, args.map(String));
const screen = JSON.parse(
  execFileSync(drive, ["screen"], { encoding: "utf8" }),
);
const targetWindow = fitWindow(screen);
console.log(
  `display ${screen.frame.width}x${screen.frame.height}@${screen.scale}x` +
    (screen.refreshHz ? ` (${screen.refreshHz} Hz)` : "") +
    `, window ${targetWindow.width}x${targetWindow.height}+${targetWindow.x}+${targetWindow.y}` +
    (targetWindow.fitted
      ? ` (fitted from ${REFERENCE_WINDOW.width}x${REFERENCE_WINDOW.height})`
      : ""),
);
if (screen.refreshHz && screen.refreshHz !== 60) {
  console.warn(
    `warning: main display reports ${screen.refreshHz} Hz; frame targets assume 60 Hz`,
  );
}

let sequence = 0;
async function command(type, extra = {}, timeoutMs = 60_000) {
  const id = `${Date.now()}-${sequence++}`;
  const queued = await fetch(`${host}/__perf/command`, {
    method: "POST",
    body: JSON.stringify({ id, type, ...extra }),
  });
  if (!queued.ok) throw new Error(`${type}: host answered ${queued.status}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await (await fetch(`${host}/__perf/result?id=${id}`)).json();
    if (result) {
      if (!result.ok) throw new Error(`${type}: ${result.error}`);
      return result.value;
    }
    await sleep(200);
  }
  throw new Error(`${type}: no answer within ${timeoutMs}ms`);
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(message);
}

const children = [];
function start(cmd, args, env, log) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(child);
  child.stdout.on("data", (chunk) => log?.(chunk.toString()));
  child.stderr.on("data", (chunk) => log?.(chunk.toString()));
  return child;
}
function cleanUp() {
  fetch(`${host}/__perf/stop`, { method: "POST" }).catch(() => {});
  for (const child of children)
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {}
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    cleanUp();
    process.exit(130);
  });

try {
  let ready;
  let failed;
  const hostReady = new Promise((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const hostProcess = start(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "scripts/perf/thread-native/playwright.config.mjs",
    ],
    {
      THREAD_NATIVE_PORT: values.port,
      THREAD_NATIVE_ARMS: values.arms,
      THREAD_NATIVE_BUILDS: join(out, "builds"),
    },
    (text) => {
      process.stdout.write(`[host] ${text}`);
      if (text.includes("host ready")) ready();
    },
  );
  hostProcess.on("exit", (code) =>
    failed(new Error(`workload host exited (${code}) before it was ready`)),
  );
  await hostReady;
  // A separate identifier keeps the mock account away from installed and
  // development app storage; an empty viewer pin selects the browser broker.
  start(
    "bin/just",
    [
      "desktop",
      "--no-watch",
      "--config",
      JSON.stringify({
        identifier: "dev.local.buzz.foundation.thread-perf",
        build: { devUrl: host, beforeDevCommand: "" },
      }),
    ],
    { BUZZ_DEV_VIEWER: "" },
  );
  const first = await waitFor(
    () => command("status", {}, 5_000),
    600_000,
    "the desktop app never loaded the workload",
  );
  console.log(`app ready (dpr ${first.dpr})`);
  const order = [];
  for (let r = 0; r < runsPerArm; r++)
    for (const [name] of r % 2 ? [...arms].reverse() : arms)
      order.push([name, r + 1]);
  const runs = [];
  let origin = first.origin;
  for (let index = 0, attempts = 0; index < order.length; index++) {
    const [arm, rep] = order[index];
    const label = `${arm}-${rep}`;
    if (!(await fetch(`${host}/__perf/arm?name=${arm}`, { method: "POST" })).ok)
      throw new Error(`${label}: unknown arm`);
    await command("reload", {}, 10_000);
    const loaded = await waitFor(
      async () => {
        const status = await command("status", {}, 3_000);
        return status.origin !== origin && status.arm === arm && status;
      },
      60_000,
      `${label}: reload did not finish`,
    );
    origin = loaded.origin;
    // Show and place the window from inside the app: it starts hidden, and
    // Accessibility does not list it. A click on empty title bar then
    // activates it: WebKit throttles timers and frames in an occluded window.
    // At >= 1280px wide, x + 280 sits in the empty gap between left controls and Search.
    const shown = await command("show", targetWindow);
    input("click", shown.window[0] + 280, shown.window[1] + 22);
    await command("open", {}, 90_000);
    const preloaded = await command("preload", {}, 180_000);
    if (
      preloaded.thread.topLevel !== preloaded.expectedTopLevel ||
      preloaded.keyboardNavigation
    )
      throw new Error(
        `${label}: workload incomplete ${JSON.stringify(preloaded)}`,
      );
    const status = await command("bottom");
    const { crop, focus, center } = threadCapture(
      status.window,
      status.thread.rect,
      screen,
      status.dpr,
    );
    // Focus with a press in the thread's empty right gutter, then rest the
    // pointer mid-pane, where trackpad scrolling happens.
    input("click", focus[0], focus[1]);
    input("move", center[0], center[1]);
    await sleep(800);
    const video = join(out, "videos", `${label}.mp4`);
    const capture = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "avfoundation",
        "-pixel_format",
        "nv12",
        "-capture_cursor",
        "0",
        "-framerate",
        "60",
        "-i",
        `${device}:none`,
        "-t",
        "11",
        "-vf",
        `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
        "-r",
        "60",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        video,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let captureErr = "";
    capture.stderr.on("data", (chunk) => {
      captureErr += chunk.toString();
    });
    const captured = new Promise((resolve) => {
      capture.once("error", (error) => resolve({ error }));
      capture.once("close", (code, signal) => resolve({ code, signal }));
    });
    let recording;
    try {
      await sleep(1000);
      await command("record", { label });
      // Up hard, reverse mid-coast, up again (positive velocity scrolls toward older).
      execFileSync(drive, ["fling", center[0], center[1], 7000, -7000, 7000], {
        env: { ...process.env, FLING_COAST_MS: "500" },
      });
      await sleep(300);
      await command("jump");
      await sleep(1500);
      recording = await command("stop");
    } catch (error) {
      await stopCapture(capture, captured);
      throw error;
    }
    const captureResult = await withTimeout(captured, 15_000);
    if (!captureResult) {
      await stopCapture(capture, captured);
      throw new Error(
        `${label}: ffmpeg timed out waiting to finish${captureErr.trim() ? `: ${captureErr.trim()}` : ""}`,
      );
    }
    if (captureResult.error) throw captureResult.error;
    if (captureResult.code !== 0)
      throw new Error(
        `${label}: ffmpeg exited (${captureResult.code ?? captureResult.signal}): ${captureErr.trim()}`,
      );
    // Gestures that never reached the thread (another window took them) are
    // not a measurement: retry the run, at most twice. A busy main thread
    // coalesces wheel events, so check the distance scrolled, not their count.
    const travel = recording.frames.reduce(
      (sum, frame, i) =>
        i ? sum + Math.abs(frame[1] - recording.frames[i - 1][1]) : sum,
      0,
    );
    if (travel < 10_000) {
      if (++attempts > 2) throw new Error(`${label}: gestures never arrived`);
      console.log(`${label}: scrolled ${Math.round(travel)}px, retrying`);
      index--;
      continue;
    }
    attempts = 0;
    const metrics = {
      ...frameMetrics(recording),
      ...videoMetrics(video),
    };
    runs.push({
      arm,
      rep,
      label,
      metrics,
      wheels: recording.wheels.length,
      window: status.window,
      threadRect: status.thread.rect,
      crop,
    });
    writeFileSync(join(out, `${label}.json`), JSON.stringify(recording));
    console.log(label, JSON.stringify(metrics));
  }
  const lastThread = runs.at(-1)?.threadRect;
  const geometryLines = [
    `Display: ${screen.frame.width}x${screen.frame.height}@${screen.scale}x` +
      (screen.refreshHz ? ` (${screen.refreshHz} Hz)` : "") +
      `, window: ${targetWindow.width}x${targetWindow.height}+${targetWindow.x}+${targetWindow.y}` +
      (lastThread
        ? `, thread pane: ${Math.round(lastThread[2])}x${Math.round(lastThread[3])}.`
        : "."),
    ...(targetWindow.fitted
      ? [
          `Note: window was fitted to the display (smaller than the ${REFERENCE_WINDOW.width}x${REFERENCE_WINDOW.height} reference); compare arms within this run only, not against the targets or table in docs/performance.md.`,
        ]
      : []),
  ];
  const summary = `${summarize(runs, { targets: !targetWindow.fitted })}\n${geometryLines.join("\n")}`;
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(
      { arms, display: screen, window: targetWindow, runs },
      null,
      1,
    ),
  );
  writeFileSync(join(out, "summary.md"), `${summary}\n`);
  console.log(`\n${summary}\n\nResults: ${out}`);
} finally {
  cleanUp();
}
