import type { AgentExecution } from "../../features/agents/execution";
import type {
  Host,
  HostProcess,
  McpHandler,
} from "../../features/host/service";
import { callbackHookArgs } from "./hook-bridge";
import type { Spawn } from "./rpc";
import relay from "./execution-relay.mjs?raw";

/** Hook callbacks share the guest process connection with the app-server. */
export class CodexExecution {
  private process?: HostProcess;
  private address?: Promise<string>;
  private callbacks = new Map<string, McpHandler>();
  constructor(readonly execution: AgentExecution) {}

  spawn: Spawn = async (id, options) => {
    if (id !== "app-server")
      throw new Error(`Unsupported guest Codex step ${id}`);
    this.execution.signal.throwIfAborted();
    let ready!: (url: string) => void;
    let failed!: (error: Error) => void;
    this.address = new Promise((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    void this.address.catch(() => undefined);
    this.callbacks.clear();
    let connection: HostProcess | undefined;
    let buffer = "";
    const process = await this.execution.spawn("node", {
      cwd: this.execution.workspace,
      args: [
        "--input-type=module",
        "-e",
        `const BUZZ_CODEX_ARGS=${JSON.stringify(callbackHookArgs)};\n${relay}`,
      ],
      ...(options?.onStderr ? { onStderr: options.onStderr } : {}),
      onStdout: (data) => {
        buffer += data;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let wire: Record<string, unknown>;
          try {
            wire = JSON.parse(line);
          } catch {
            options?.onStdout?.(`${line}\n`);
            continue;
          }
          if (wire.buzzCodexHook === "ready") ready(String(wire.url));
          else if (wire.buzzCodexHook === "request")
            void this.callback(
              wire as { id: number; token: string; body: unknown },
              connection,
            );
          else options?.onStdout?.(`${line}\n`);
        }
      },
    });
    connection = process;
    this.process = process;
    void process.exited.then(() => {
      failed(new Error("The guest Codex process stopped"));
      if (this.process === process) this.callbacks.clear();
    });
    return process;
  };

  private async callback(
    wire: { id: number; token: string; body: unknown },
    connection: HostProcess | undefined,
  ) {
    let status = 200;
    let body: unknown;
    try {
      this.execution.signal.throwIfAborted();
      const handler = this.callbacks.get(wire.token);
      if (!handler) throw new Error("The Codex hook callback is closed");
      body = await handler(wire.body);
      if (body === undefined) status = 202;
      this.execution.signal.throwIfAborted();
      if (this.callbacks.get(wire.token) !== handler)
        throw new Error("The Codex hook callback is closed");
    } catch (error) {
      status = 403;
      body = { error: error instanceof Error ? error.message : String(error) };
    }
    await connection
      ?.write(
        `${JSON.stringify({ buzzCodexHook: "response", id: wire.id, status, body })}\n`,
      )
      .catch(() => undefined);
  }

  serve: NonNullable<Host["serveMcp"]> = async (handler) => {
    const url = await this.address;
    this.execution.signal.throwIfAborted();
    if (!url) throw new Error("The guest Codex process is not open");
    const token = crypto.randomUUID();
    this.callbacks.set(token, handler);
    let closed!: () => void;
    return {
      url: `${url}/${token}`,
      headers: [],
      closed: new Promise<void>((resolve) => {
        closed = resolve;
      }),
      close: async () => {
        this.callbacks.delete(token);
        closed();
      },
    };
  };
}
