import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map();
let next = 0;
const server = createServer(async (request, response) => {
  if (request.method === "DELETE") {
    response.writeHead(200).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  let body = "";
  try {
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 1024 * 1024) throw new Error("Hook input is too large");
    }
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      response.writeHead(504).end();
    }, 30000);
    pending.set(id, { response, timer });
    response.on("close", () => {
      clearTimeout(timer);
      pending.delete(id);
    });
    send({
      buzzCodexHook: "request",
      id,
      token: request.url?.slice(1),
      body: JSON.parse(body),
    });
  } catch {
    response.writeHead(400).end();
  }
});
server.listen(0, "127.0.0.1", () => {
  send({
    buzzCodexHook: "ready",
    url: `http://127.0.0.1:${server.address().port}`,
  });
});
const child = spawn("codex", ["app-server", ...BUZZ_CODEX_ARGS], {
  stdio: ["pipe", "pipe", "pipe"],
});
createInterface({ input: child.stdout }).on("line", (line) => {
  process.stdout.write(`${line}\n`);
});
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(error.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const wire = JSON.parse(line);
  if (wire.buzzCodexHook === "response") {
    const held = pending.get(wire.id);
    if (!held) return;
    pending.delete(wire.id);
    clearTimeout(held.timer);
    held.response.writeHead(wire.status, {
      "Content-Type": "application/json",
    });
    held.response.end(JSON.stringify(wire.body));
  } else child.stdin.write(`${line}\n`);
});
lines.on("close", () => {
  child.stdin.end();
  server.close();
});
process.on("SIGTERM", () => {
  child.kill();
  server.close();
});
