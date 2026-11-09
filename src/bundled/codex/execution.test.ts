import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentExecution } from "../../features/agents/execution";
import { CodexExecution } from "./execution";
import { openHookBridge } from "./hook-bridge";

it("carries scoped native hooks over guest stdio and retires callback URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buzz-codex-execution-"));
  const lifetime = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let exit!: Promise<number | null>;
  const output: { id: number; status: number; body: unknown }[] = [];
  const guest: AgentExecution = {
    workspace: directory,
    signal: lifetime.signal,
    resolveDirectory: async (path) => path,
    readFile: async () => {
      throw new Error("No file read in this test");
    },
    dispose: async () => {
      child?.stdin?.end();
      await exit;
    },
    spawn: async (_program, options) => {
      child = spawn(process.execPath, [...(options?.args ?? [])], {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        stdio: "pipe",
      });
      child.stdout?.on("data", (data) => options?.onStdout?.(String(data)));
      child.stderr?.on("data", (data) => options?.onStderr?.(String(data)));
      exit = new Promise((resolve) => child?.once("exit", resolve));
      return {
        write: async (data) => {
          child?.stdin?.write(data);
        },
        end: async () => {
          child?.stdin?.end();
        },
        kill: async () => {
          child?.kill();
        },
        exited: exit,
      };
    },
  };
  await writeFile(
    join(directory, "codex"),
    `#!${process.execPath}
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', async (line) => {
  const wire = JSON.parse(line);
  const response = await fetch(wire.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wire.body),
  });
  process.stdout.write(JSON.stringify({ id: wire.id, status: response.status, body: await response.text() }) + '\\n');
});
`,
    { mode: 0o700 },
  );
  const transport = new CodexExecution(guest);
  try {
    const process = await transport.spawn("app-server", {
      onStdout: (line) => output.push(JSON.parse(line)),
    });
    const run = vi.fn(async () => ({ decision: "block", reason: "policy" }));
    const bridge = await openHookBridge(transport.serve, run);
    bridge.bind("one");
    const url = bridge.config.buzz_native_hooks.url;
    const request = async (id: number, session: string, endpoint = url) => {
      await process.write(
        `${JSON.stringify({
          id,
          url: endpoint,
          body: {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "Stop", arguments: { session_id: session } },
          },
        })}\n`,
      );
      await vi.waitFor(() =>
        expect(output.some((wire) => wire.id === id)).toBe(true),
      );
      return output.find((wire) => wire.id === id);
    };
    expect(await request(1, "one")).toMatchObject({ status: 200 });
    expect(run).toHaveBeenCalledExactlyOnceWith("one", "Stop", {
      session_id: "one",
    });
    expect(await request(2, "another")).toMatchObject({ status: 403 });
    expect(
      await request(3, "one", url.replace(/[^/]+$/, "unknown")),
    ).toMatchObject({ status: 403 });
    await bridge.close();
    expect(await request(4, "one")).toMatchObject({ status: 403 });
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    await guest.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
