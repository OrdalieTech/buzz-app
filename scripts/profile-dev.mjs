import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { relayOrigin } from "../src/features/communities/destination.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

const children = new Set();
const processGroups = new Set();
let forced = false;

function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    detached: true,
    ...options,
  });
  children.add(child);
  if (child.pid) processGroups.add(child.pid);
  child.once("exit", () => children.delete(child));
  return child;
}

function mirror(child) {
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
}

export function waitForInspector(child) {
  return new Promise((resolve, reject) => {
    let pending = "";
    const onData = (chunk) => {
      pending += chunk;
      const match = pending.match(/Debugger listening on (ws:\/\/\S+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
      if (pending.length > 16_384) pending = pending.slice(-8_192);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Vite exited before its Node inspector became ready."));
    };
    const cleanup = () => {
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function commandSucceeds(command, commandArgs) {
  return await new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

export function inspectorClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  let terminalError;
  const fail = (error) => {
    if (terminalError) return;
    terminalError = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => {
        const error = new Error(
          `Could not connect to Node inspector at ${url}.`,
        );
        fail(error);
        reject(error);
      },
      { once: true },
    );
  });
  socket.addEventListener("close", () => {
    const error = new Error("Node inspector connection closed.");
    fail(error);
    rejectReady(error);
  });
  return {
    async send(method, params) {
      await ready;
      if (terminalError) throw terminalError;
      return await new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      const error = new Error("Node inspector connection closed.");
      fail(error);
      rejectReady(error);
      socket.close();
    },
  };
}

function signalGroup(pid, name) {
  if (!pid) return;
  try {
    process.kill(-pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    processGroups.delete(pid);
  }
}

async function output(command, commandArgs) {
  return await new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let value = "";
    child.stdout.on("data", (chunk) => (value += chunk));
    child.once("close", () => resolve(value.trim()));
  });
}

async function recordManifest(directory, target, profileArgs, extra = {}) {
  await writeFile(
    `${directory}/manifest.json`,
    `${JSON.stringify(
      {
        target,
        startedAt: new Date().toISOString(),
        git: {
          commit: await output("git", ["rev-parse", "HEAD"]),
          dirty: Boolean(await output("git", ["status", "--porcelain"])),
        },
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        arguments: profileArgs,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

// The relay the dev server will use: Vite's environment for its mode (.env
// files, with the process environment winning) reduced to the validated public
// origin. A rejected value may carry a credential, so it is never recorded.
export async function configuredRelay(mode, directory = root) {
  const { loadEnv } = await import("vite");
  const value = loadEnv(mode, directory, "BUZZ_").BUZZ_RELAY_URL;
  if (!value?.trim()) return null;
  try {
    return relayOrigin(value);
  } catch {
    return null;
  }
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      processGroups.delete(pid);
      return false;
    }
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroups(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (![...processGroups].some(processGroupAlive)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopChildren() {
  for (const pid of processGroups) signalGroup(pid, "SIGINT");
  await waitForProcessGroups(30_000);
  for (const pid of processGroups)
    if (processGroupAlive(pid)) signalGroup(pid, "SIGTERM");
}

function stopController() {
  const abort = new AbortController();
  let resolve;
  const requested = new Promise((value) => (resolve = value));
  for (const name of ["SIGINT", "SIGTERM"]) {
    process.on(name, () => {
      if (abort.signal.aborted) {
        forced = true;
        for (const pid of processGroups) signalGroup(pid, "SIGKILL");
        return;
      }
      console.log(
        `\n${name === "SIGINT" ? "Ctrl-C" : name} received; finalizing profile...`,
      );
      abort.abort();
      resolve({ reason: "signal", code: 0 });
    });
  }
  return { abort, requested };
}

export function normalizeWebViteArgs(values) {
  const normalized = [];
  let port = 1430;
  let sawPort = false;
  let sawHost = false;
  let mode;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--")
      throw new Error("Web profiling does not accept Vite arguments after --.");
    if (/^(?:--mode|-m)(?:=|$)/.test(value)) {
      if (mode !== undefined)
        throw new Error("Web profiling accepts only one --mode option.");
      const equals = value.indexOf("=");
      mode = equals < 0 ? values[++index] : value.slice(equals + 1);
      if (!mode) throw new Error("--mode requires a mode name.");
      continue;
    }
    // Vite also takes a mode from a short-flag group or --m. The manifest's
    // relay follows the mode, so a mode Vite alone sees would misattribute it.
    if (/^-[^-=]*m|^--m(?:=|$)/.test(value))
      throw new Error("Web profiling requires the mode as --mode <mode>.");
    if (value === "--port") {
      if (sawPort)
        throw new Error("Web profiling accepts only one --port option.");
      sawPort = true;
      port = Number(values[++index]);
      continue;
    }
    if (value.startsWith("--port=")) {
      if (sawPort)
        throw new Error("Web profiling accepts only one --port option.");
      sawPort = true;
      port = Number(value.slice(7));
      continue;
    }
    if (value === "--host" || value.startsWith("--host=")) {
      if (sawHost)
        throw new Error("Web profiling accepts only one --host option.");
      sawHost = true;
      const host = value === "--host" ? values[++index] : value.slice(7);
      if (host !== "127.0.0.1")
        throw new Error("Web profiling requires --host 127.0.0.1.");
      continue;
    }
    if (
      value === "--strictPort" ||
      value === "--no-strictPort" ||
      value.startsWith("--strictPort=")
    ) {
      if (value !== "--strictPort")
        throw new Error("Web profiling requires --strictPort.");
      continue;
    }
    normalized.push(value);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port must be an integer between 1 and 65535.");
  return {
    port,
    mode: mode ?? "development",
    args: [
      ...normalized,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      ...(mode === undefined ? [] : ["--mode", mode]),
    ],
  };
}

export function viteListenerUrl(address) {
  if (
    !address ||
    typeof address !== "object" ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65535
  )
    throw new Error("Vite reported an invalid profiling listener address.");
  if (address.address !== "127.0.0.1")
    throw new Error("Vite did not bind the required profiling host.");
  return `http://127.0.0.1:${address.port}`;
}

export function viteReadyToken(child, token, signal) {
  return new Promise((resolve, reject) => {
    let output = "";
    const marker = `BUZZ_PROFILE_VITE_READY:${token}:`;
    const finish = (error, url) => {
      cleanup();
      if (error) reject(error);
      else resolve(url);
    };
    const onData = (chunk) => {
      output += chunk;
      const start = output.indexOf(marker);
      const end = start < 0 ? -1 : output.indexOf("\n", start);
      if (end >= 0) {
        try {
          const address = JSON.parse(
            output.slice(start + marker.length, end).trim(),
          );
          finish(undefined, viteListenerUrl(address));
        } catch (error) {
          finish(error);
        }
      } else if (/Port \d+ is (?:already )?in use/.test(output))
        finish(new Error("Vite could not bind the profiling port."));
      if (output.length > 16_384) output = output.slice(-8_192);
    };
    const onExit = () =>
      finish(new Error("Vite exited before owning the profiling port."));
    const onAbort = () =>
      finish(new DOMException("Profiling startup cancelled.", "AbortError"));
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForViteReady(url, child, signal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null)
      throw new Error(`Vite exited before ${url} became ready.`);
    try {
      const response = await fetch(url, { signal });
      if (response.ok) return;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

export function safeUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol))
    return `${url.protocol}<redacted>`;
  return `${url.origin}${url.pathname}`;
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {}))
    if (key.toLowerCase() === target) return value;
  return undefined;
}

export function networkRecorder(session, directory) {
  const requests = new Map();
  const webSockets = new Map();
  const startedAt = new Date().toISOString();
  let calibration;

  session.on(
    "Network.requestWillBeSent",
    ({ requestId, request, timestamp, type }) => {
      requests.set(requestId, {
        requestId,
        method: request.method,
        type,
        url: safeUrl(request.url),
        start: timestamp,
      });
    },
  );
  session.on(
    "Network.responseReceived",
    ({ requestId, response, timestamp, type }) => {
      const entry = requests.get(requestId);
      if (!entry) return;
      entry.type = type;
      entry.status = response.status;
      entry.protocol = response.protocol;
      entry.remoteAddress = response.remoteIPAddress
        ? `${response.remoteIPAddress}:${response.remotePort}`
        : undefined;
      entry.response = timestamp;
      entry.timing = response.timing;
      entry.serverTiming = headerValue(response.headers, "server-timing");
    },
  );
  session.on(
    "Network.loadingFinished",
    ({ requestId, timestamp, encodedDataLength }) => {
      const entry = requests.get(requestId);
      if (!entry) return;
      entry.end = timestamp;
      entry.encodedDataLength = encodedDataLength;
    },
  );
  session.on(
    "Network.loadingFailed",
    ({ requestId, timestamp, errorText, canceled }) => {
      const entry = requests.get(requestId);
      if (!entry) return;
      entry.end = timestamp;
      entry.failure = { errorText, canceled };
    },
  );
  session.on("Network.webSocketCreated", ({ requestId, url }) => {
    webSockets.set(requestId, { requestId, url: safeUrl(url), frames: [] });
  });
  session.on(
    "Network.webSocketWillSendHandshakeRequest",
    ({ requestId, timestamp }) => {
      const entry = webSockets.get(requestId);
      if (entry) entry.start = timestamp;
    },
  );
  session.on(
    "Network.webSocketHandshakeResponseReceived",
    ({ requestId, timestamp, response }) => {
      const entry = webSockets.get(requestId);
      if (!entry) return;
      entry.handshake = timestamp;
      entry.status = response.status;
    },
  );
  for (const [event, direction] of [
    ["Network.webSocketFrameSent", "sent"],
    ["Network.webSocketFrameReceived", "received"],
  ]) {
    session.on(event, ({ requestId, timestamp, response }) => {
      const entry = webSockets.get(requestId);
      if (!entry) return;
      entry.frames.push({
        direction,
        timestamp,
        opcode: response.opcode,
        bytes: response.payloadData.length,
      });
    });
  }
  session.on("Network.webSocketClosed", ({ requestId, timestamp }) => {
    const entry = webSockets.get(requestId);
    if (entry) entry.end = timestamp;
  });

  return {
    async start(page, duringStartup) {
      await duringStartup(() =>
        session.send("Network.enable", { maxPostDataSize: 0 }),
      );
      await duringStartup(() => session.send("Performance.enable"));
      const { metrics } = await duringStartup(() =>
        session.send("Performance.getMetrics"),
      );
      calibration = {
        cdpMonotonicSeconds: metrics.find(({ name }) => name === "Timestamp")
          ?.value,
        renderer: await duringStartup(() =>
          page.evaluate(() => ({
            epochMilliseconds: performance.timeOrigin + performance.now(),
            monotonicMilliseconds: performance.now(),
          })),
        ),
      };
    },
    async write(clocks) {
      await writeFile(
        `${directory}/network.json`,
        `${JSON.stringify(
          {
            format: "buzz-network-profile-v1",
            startedAt,
            calibration: { ...calibration, cpuProfiles: clocks },
            privacy:
              "URLs exclude query/fragment; headers exclude everything except Server-Timing; bodies and frame payloads are omitted.",
            requests: [...requests.values()],
            webSockets: [...webSockets.values()],
          },
          null,
          2,
        )}\n`,
      );
    },
  };
}

const SCENARIO_TIMEOUT_MS = 5 * 60_000;

export function takeScenario(values) {
  const args = [];
  let scenario;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value !== "--scenario" && !value.startsWith("--scenario=")) {
      args.push(value);
      continue;
    }
    if (scenario !== undefined)
      throw new Error("Profiling accepts only one --scenario option.");
    scenario = value === "--scenario" ? values[++index] : value.slice(11);
    if (!scenario) throw new Error("--scenario requires a scenario file.");
  }
  return { scenario, args };
}

// A scenario file default-exports `async (page, { signal }) => {}` and drives
// the Playwright page. It runs as the developer's real account.
export async function loadScenario(file) {
  const location = path.resolve(file);
  const { default: run } = await import(pathToFileURL(location).href);
  if (typeof run !== "function")
    throw new Error(`Scenario ${location} must default-export a function.`);
  return { file: location, run };
}

export async function runScenario(
  scenario,
  page,
  directory,
  signal,
  timeoutMs = SCENARIO_TIMEOUT_MS,
) {
  // The scenario's signal aborts on Ctrl-C, at the timeout, and once this run
  // settles, so abort-aware work it leaves behind cannot keep the process alive.
  const ended = new AbortController();
  const stop = AbortSignal.any([signal, ended.signal]);
  try {
    const metrics = await Promise.race([
      (async () => {
        await scenario.run(page, { signal: stop });
        // The app's own client-metrics export (Settings → Developer).
        return await page.evaluate(
          (label) => globalThis.__buzzClientMetrics.export(label),
          path.basename(scenario.file),
        );
      })(),
      // Ctrl-C also ends this wait, so an interrupted scenario that finishes
      // late saves no metrics.
      pause(timeoutMs, undefined, { signal: stop }).then(() => {
        throw new Error(
          `Scenario did not finish within ${timeoutMs / 1000} seconds.`,
        );
      }),
    ]);
    await writeFile(
      `${directory}/client-metrics.json`,
      `${JSON.stringify(metrics, null, 2)}\n`,
    );
    return { reason: "scenario", code: 0 };
  } catch (error) {
    return { reason: "scenario", code: 1, error };
  } finally {
    ended.abort();
  }
}

export async function profileWeb({
  directory,
  profileArgs,
  args,
  network,
  trace = false,
  scenario,
  scenarioTimeoutMs,
}) {
  const vite = normalizeWebViteArgs(args);
  await recordManifest(directory, "web", profileArgs, {
    coverage: [
      trace ? "chromium-trace" : "chromium-renderer",
      "vite-broker",
      ...(network ? ["chromium-network"] : []),
      ...(scenario ? ["client-metrics"] : []),
    ],
    network,
    scenario: scenario?.file ?? null,
    relay: await configuredRelay(vite.mode),
  });

  const control = stopController();
  // Aborts the scenario's signal however the capture ends, including Vite exit.
  const captureEnd = new AbortController();
  // Browser operations do not accept AbortSignal. Stop waiting immediately and
  // let finally close the owning browser; late results must not resume startup.
  const duringStartup = async (operation) => {
    control.abort.signal.throwIfAborted();
    const result = await Promise.race([operation(), control.requested]);
    control.abort.signal.throwIfAborted();
    return result;
  };
  const readyToken = randomUUID();
  const nodeOptions = [process.env.NODE_OPTIONS, "--inspect=127.0.0.1:0"]
    .filter(Boolean)
    .join(" ");
  const viteProcess = run(
    process.execPath,
    // Rebuilds the dependency cache like `pnpm dev`; see README.
    ["node_modules/vite/bin/vite.js", "--force", ...vite.args],
    {
      env: {
        ...process.env,
        BUZZ_PROFILE_VITE_READY_TOKEN: readyToken,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  const inspectorUrl = waitForInspector(viteProcess);
  void inspectorUrl.catch(() => {});
  const viteExit = new Promise((resolve) =>
    viteProcess.once("exit", (code, signal) =>
      resolve({ reason: "vite", code: code ?? (signal ? 1 : 0) }),
    ),
  );
  mirror(viteProcess);

  let browser;
  let session;
  let networkCapture;
  let nodeProfiler;
  let rendererStarted = false;
  let tracing = false;
  let brokerStarted = false;
  let captureStarted = false;
  let outcome;
  const failures = [];
  let url;
  try {
    url = await viteReadyToken(viteProcess, readyToken, control.abort.signal);
    await waitForViteReady(url, viteProcess, control.abort.signal);
    control.abort.signal.throwIfAborted();
    nodeProfiler = inspectorClient(await inspectorUrl);
    await nodeProfiler.send("Profiler.enable");
    await nodeProfiler.send("Profiler.setSamplingInterval", { interval: 1000 });
    await nodeProfiler.send("Profiler.start");
    brokerStarted = true;
    control.abort.signal.throwIfAborted();

    const { chromium } = await duringStartup(() => import("@playwright/test"));
    const browserLaunch = chromium.launch({
      channel: "chrome",
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    const lateBrowserCleanup = browserLaunch.then(async (launched) => {
      if (control.abort.signal.aborted && launched !== browser)
        await launched.close();
      return launched;
    });
    browser = await Promise.race([
      lateBrowserCleanup,
      control.requested.then(() => undefined),
    ]);
    if (!browser)
      throw new DOMException("Profiling startup cancelled.", "AbortError");
    control.abort.signal.throwIfAborted();
    // Playwright otherwise pins the page to a fixed 1280x720 viewport that
    // ignores window resizing.
    const page = await duringStartup(() => browser.newPage({ viewport: null }));
    session = await duringStartup(() => page.context().newCDPSession(page));
    if (network) {
      networkCapture = networkRecorder(session, directory);
      await networkCapture.start(page, duringStartup);
    }
    if (trace) {
      // The DevTools trace carries denser renderer CPU samples; a second
      // sampler would only add overhead to the recorded timings.
      await duringStartup(() => browser.startTracing(page));
      tracing = true;
    } else {
      await duringStartup(() => session.send("Profiler.enable"));
      await duringStartup(() =>
        session.send("Profiler.setSamplingInterval", { interval: 1000 }),
      );
      await duringStartup(() => session.send("Profiler.start"));
      rendererStarted = true;
    }
    await duringStartup(() => page.goto(url));
    control.abort.signal.throwIfAborted();
    captureStarted = true;
    console.log(
      `\nProfiling ${url}. ${
        scenario
          ? `Running scenario ${scenario.file}; the capture stops when it ends.`
          : "Press Ctrl-C to stop and save the profile."
      }`,
    );
    outcome = await Promise.race([
      control.requested,
      viteExit,
      ...(scenario
        ? [
            runScenario(
              scenario,
              page,
              directory,
              AbortSignal.any([control.abort.signal, captureEnd.signal]),
              scenarioTimeoutMs,
            ),
          ]
        : []),
    ]);
    if (outcome.error)
      failures.push(
        new Error(`Scenario failed; artifacts remain at ${directory}.`, {
          cause: outcome.error,
        }),
      );
  } catch (error) {
    if (!control.abort.signal.aborted) failures.push(error);
    outcome ??= { reason: "startup", code: 1 };
  } finally {
    captureEnd.abort();
    let rendererProfile;
    let brokerProfile;
    if (rendererStarted) {
      try {
        ({ profile: rendererProfile } = await session.send("Profiler.stop"));
        await writeFile(
          `${directory}/chromium-renderer.cpuprofile`,
          `${JSON.stringify(rendererProfile)}\n`,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (tracing) {
      try {
        await writeFile(
          `${directory}/chromium-trace.json`,
          await browser.stopTracing(),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (brokerStarted) {
      try {
        ({ profile: brokerProfile } = await nodeProfiler.send("Profiler.stop"));
        await writeFile(
          `${directory}/vite-broker.cpuprofile`,
          `${JSON.stringify(brokerProfile)}\n`,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (networkCapture) {
      try {
        await networkCapture.write({
          renderer: rendererProfile && {
            startTimeMicroseconds: rendererProfile.startTime,
            endTimeMicroseconds: rendererProfile.endTime,
          },
          broker: brokerProfile && {
            startTimeMicroseconds: brokerProfile.startTime,
            endTimeMicroseconds: brokerProfile.endTime,
            note: "Node inspector monotonic epoch is isolate-specific; align by capture start/end rather than assuming the renderer epoch.",
          },
        });
      } catch (error) {
        failures.push(error);
      }
    }
    nodeProfiler?.close();
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
    await stopChildren();
  }

  if (!captureStarted) {
    throw new Error(
      `Profiling stopped during startup; partial artifacts remain at ${directory}.`,
      { cause: failures[0] },
    );
  }
  if (failures.length) throw failures[0];
  console.log(`\nProfile saved to ${directory}`);
  process.exitCode = forced ? 130 : (outcome?.code ?? 0);
}

function hasRunnerArgument(values) {
  return values.some(
    (value) =>
      value === "--runner" || value === "-r" || value.startsWith("--runner="),
  );
}

async function waitForTrace(trace) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      await commandSucceeds("xcrun", [
        "xctrace",
        "export",
        "--input",
        trace,
        "--toc",
      ])
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Instruments left an incomplete trace at ${trace}; rerun and press Ctrl-C only once.`,
  );
}

function desktopProfileArgs(values) {
  const separator = values.indexOf("--");
  const options = separator < 0 ? values : values.slice(0, separator);
  const application = separator < 0 ? [] : values.slice(separator);
  return [
    ...options.filter((value) => value !== "--no-watch"),
    "--no-watch",
    ...application,
  ];
}

async function profileDesktop({ directory, profileArgs, args }) {
  if (hasRunnerArgument(args))
    throw new Error("Desktop profiling owns Tauri's --runner option.");
  const trace = `${directory}/desktop-time-profile.trace`;
  await recordManifest(directory, "desktop", profileArgs, {
    coverage: ["launched-desktop-native-application"],
    caveat:
      "Instruments launches and samples the Buzz native parent process only, not all macOS processes. WebKit subprocesses and the Vite broker are outside this trace; JavaScriptCore stacks may not resolve to application JavaScript.",
  });
  const control = stopController();
  const runner = fileURLToPath(
    new URL("./profile-desktop-runner.mjs", import.meta.url),
  );
  const desktop = run(
    process.execPath,
    [
      "scripts/desktop-dev.mjs",
      "--runner",
      runner,
      ...desktopProfileArgs(args),
    ],
    { env: { ...process.env, BUZZ_PROFILE_TRACE: trace } },
  );
  const desktopExit = new Promise((resolve) =>
    desktop.once("exit", (code, signal) =>
      resolve({ reason: "desktop", code: code ?? (signal ? 1 : 0) }),
    ),
  );
  console.log(
    "\nProfiling the launched Buzz desktop application. Press Ctrl-C to stop and save the profile.",
  );
  const outcome = await Promise.race([control.requested, desktopExit]);
  await stopChildren();
  await waitForTrace(trace);
  console.log(`\nProfile saved to ${trace}`);
  process.exitCode = forced ? 130 : outcome.code;
}

// A wrapped failure names the artifacts; its cause carries the stack to debug.
export function failureReport(error) {
  if (!(error instanceof Error)) return error;
  const { cause } = error;
  if (cause === undefined) return error.message;
  return `${error.message}\n${cause instanceof Error ? cause.stack : cause}`;
}

async function main() {
  const target = process.argv[2];
  const profileArgs = process.argv.slice(3);
  const network = target === "web" && profileArgs.includes("--network");
  const trace = target === "web" && profileArgs.includes("--trace");
  const { scenario: scenarioFile, args } = takeScenario(
    profileArgs.filter(
      (argument) => argument !== "--network" && argument !== "--trace",
    ),
  );
  if (target !== "web" && target !== "desktop") {
    console.error(
      "Usage: node scripts/profile-dev.mjs <web|desktop> [arguments]",
    );
    process.exitCode = 1;
    return;
  }
  if (scenarioFile !== undefined && target !== "web")
    throw new Error("--scenario is supported for web profiling only.");
  if (process.platform !== "darwin") {
    console.error("Development profiling currently supports macOS only.");
    process.exitCode = 1;
    return;
  }
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  const scenario = scenarioFile && (await loadScenario(scenarioFile));
  const directory = `${root}.profiles/${stamp}-${target}`;
  await mkdir(directory, { recursive: true });
  if (target === "web")
    await profileWeb({
      directory,
      profileArgs,
      args,
      network,
      trace,
      scenario,
    });
  else await profileDesktop({ directory, profileArgs, args });
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  try {
    await main();
  } catch (error) {
    console.error(failureReport(error));
    await stopChildren();
    process.exitCode = 1;
  }
}
