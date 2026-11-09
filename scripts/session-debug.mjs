#!/usr/bin/env node
// One-line, read-only, loopback session inspector. No model or relay connection.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseLines, sessionModel } from "./session-model.mjs";

export function threadId(value) {
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const url = new URL(value);
    if (url.protocol !== "buzz:" || url.hostname !== "message")
      throw new Error();
    const id = url.searchParams.get("thread") || url.searchParams.get("id");
    if (/^[a-f0-9]{64}$/i.test(id)) return id.toLowerCase();
  } catch {}
  throw new Error(
    "Use a Buzz thread ID, buzz://message link, or --file /absolute/session.jsonl",
  );
}
async function* files(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  for (const e of entries) {
    if (e.isDirectory()) yield* files(join(root, e.name));
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield join(root, e.name);
  }
}
export function ownsThread(records, id) {
  return records.some((r) => {
    const message =
      r.type === "response_item" && r.payload?.role === "user"
        ? r.payload
        : r.type === "user"
          ? r.message
          : null;
    if (!message) return false;
    const body =
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((b) => b.type === "text" || b.type === "input_text")
            .map((b) => b.text)
            .join("\n");
    // Inspect the delivery envelope, not quoted history or tool output.
    for (const m of body.matchAll(/<context>\s*([^<]+)\s*<\/context>/g)) {
      try {
        if (JSON.parse(m[1]).session_thread === id) return true;
      } catch {}
    }
    return (
      new RegExp(`^Thread root: ${id}\\s*$`, "m").test(body) ||
      new RegExp(`^Event ID: ${id}\\s*$`, "m").test(body) ||
      new RegExp(`^\\{"id":"${id}"`, "m").test(body)
    );
  });
}
// The agent a session belongs to, from the identity line its harness puts in
// the system or developer prompt: the latest one, in case it was renamed.
export function agentOf(records) {
  let agent;
  for (const r of records) {
    const texts =
      r.type === "response_item" && r.payload?.role === "developer"
        ? (r.payload.content ?? []).map((b) => b.text)
        : r.attachment?.type === "prompt_snapshot"
          ? [r.attachment.systemPrompt].flat()
          : [];
    for (const text of texts) {
      const m =
        typeof text === "string" &&
        /^(?:<[\w.-]+>)?You are (.+?) \(pubkey ([a-f0-9]{64})\)/m.exec(text);
      if (m) agent = { name: m[1], pubkey: m[2] };
    }
  }
  return agent ?? null;
}
export async function createInspector({
  target,
  file,
  provider,
  roots,
  traceRoot,
  rates = {},
}) {
  const home = homedir();
  // Buzz's Codex home (see src/bundled/codex/codex.sh), then the user's,
  // which holds threads from older Buzz builds.
  const buzzCodex =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/codex-home")
      : join(
          process.env.XDG_DATA_HOME || join(home, ".local/share"),
          "buzz/codex-home",
        );
  const userCodex = process.env.CODEX_HOME || join(home, ".codex");
  roots ??= [
    ...[buzzCodex, userCodex].flatMap((codex) => [
      join(codex, "sessions"),
      join(codex, "archived_sessions"),
    ]),
    join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects"),
  ];
  traceRoot ??= join(home, ".buzz", "session-debug");
  const known = new Map();
  let candidates = file ? [{ path: resolve(file) }] : [];
  let scanned = 0;
  const token = randomBytes(24).toString("hex");
  const base = `/${token}`;
  const assets = dirname(fileURLToPath(import.meta.url));
  let busy;
  async function inspect(selected, through, turn) {
    if (!file && Date.now() - scanned > 3000) {
      const found = [];
      for (const root of roots)
        for await (const path of files(root)) {
          const info = await stat(path).catch(() => null);
          if (!info) continue;
          const stamp = `${info.size}:${info.mtimeMs}`;
          let match = known.get(path);
          if (match?.stamp !== stamp) {
            const source = await readFile(path, "utf8");
            const records = source.includes(target)
              ? parseLines(source, true)
              : [];
            const matches = ownsThread(records, target);
            match = {
              stamp,
              matches,
              path,
              agent: matches ? agentOf(records) : null,
              harness: records.some((r) => r.type === "session_meta")
                ? "Codex"
                : "Claude",
              started: records.find((r) => r.timestamp)?.timestamp ?? null,
              updated: info.mtimeMs,
            };
            known.set(path, match);
          }
          if (match.matches) found.push(match);
        }
      // Oldest first, so the default, the latest, is the one last at work.
      candidates = found
        .sort((a, b) => a.updated - b.updated)
        .map(({ path, agent, harness, started }) => ({
          path,
          agent,
          harness,
          started,
        }));
      scanned = Date.now();
    }
    if (!candidates.length)
      return {
        waiting: true,
        message: "Waiting for a local session for this thread…",
        candidates: [],
      };
    const chosen = (
      candidates.find((c) => c.path === selected) ?? candidates.at(-1)
    ).path;
    const records = parseLines(await readFile(chosen, "utf8"), true);
    const id =
      records.find((r) => r.type === "session_meta")?.payload?.id ??
      records.find((r) => r.sessionId)?.sessionId;
    let trace = [];
    if (/^[\w-]+$/.test(id ?? "")) {
      try {
        trace = parseLines(
          await readFile(join(traceRoot, `${id}.jsonl`), "utf8"),
          true,
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    const model = sessionModel(records, {
      file: chosen,
      provider,
      trace,
      rates,
    });
    const response = model.turns
      .flatMap((t) => t.requests)
      .find((r) => r.id === through);
    const until =
      response?.timestamp ?? model.turns.find((t) => t.id === turn)?.end;
    if (until) {
      const snapshot = sessionModel(
        records.filter((r) => !r.timestamp || r.timestamp <= until),
        {
          file: chosen,
          provider,
          trace: trace.filter((r) => r.timestamp <= until),
          rates,
        },
      );
      model.entries = snapshot.entries;
      model.snapshotAt = until;
    }
    return { ...model, agent: agentOf(records), candidates };
  }
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, origin);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (
      req.method !== "GET" ||
      req.headers.host !== `127.0.0.1:${server.address().port}` ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if (url.pathname === `${base}/state`) {
        // Serialize scans, but never share a different selection's response.
        const job = (busy ?? Promise.resolve())
          .catch(() => {})
          .then(() =>
            inspect(
              url.searchParams.get("session"),
              url.searchParams.get("through"),
              url.searchParams.get("turn"),
            ),
          );
        busy = job;
        const state = await job;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(state));
      } else {
        const name = new Map([
          [`${base}/`, "session-debug.html"],
          [`${base}/session-debug-client.js`, "session-debug-client.js"],
          [`${base}/session-debug.css`, "session-debug.css"],
        ]).get(url.pathname);
        if (!name) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          name.endsWith(".js")
            ? "text/javascript"
            : name.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        res.end(await readFile(join(assets, name)));
      }
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}${base}/` };
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) {
    console.log(
      'Usage: bin/node scripts/session-debug.mjs <thread-id|buzz://message?...> [--no-open] [--rates rates.json]\n       bin/node scripts/session-debug.mjs --file session.jsonl [--no-open]\nRates: {"exact-model-id":{"input":2,"output":10,"cached":0.2,"written":2.5}} in USD per million tokens.',
    );
    return;
  }
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return;
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(`${flag} requires a value`);
    return args.splice(i, 2)[1];
  };
  const file = take("--file"),
    rateFile = take("--rates");
  const noOpen = args.includes("--no-open");
  if (noOpen) args.splice(args.indexOf("--no-open"), 1);
  if (args.length !== (file ? 0 : 1))
    throw new Error("Unexpected arguments; use --help");
  const rates = rateFile
    ? JSON.parse(await readFile(resolve(rateFile), "utf8"))
    : {};
  const { server, url } = await createInspector({
    file,
    target: file ? undefined : threadId(args[0]),
    rates,
  });
  console.log(
    `Session viewer: ${url}\nLive local view. Ctrl+C stops the server.`,
  );
  if (!noOpen) {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer.exe"
          : "xdg-open";
    const child = spawn(command, [url], { stdio: "ignore" });
    child.on("error", () => console.log("Open the URL above in a browser."));
  }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
