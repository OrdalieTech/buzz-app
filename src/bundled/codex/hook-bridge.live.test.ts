// @vitest-environment node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
  McpHandler,
  HostMcpServer,
  HostMcpOptions,
} from "../../features/host/service";
import { nativeHookOutput } from "../hook-output";
import { AppServer } from "./rpc";
import { dispatchAgentHooks } from "../../features/agents/hooks";
import { nativeHookState } from "./hooks";
import {
  CODEX_HOOK_EVENTS,
  callbackHookArgs,
  openHookBridge,
} from "./hook-bridge";

const binary = process.env.CODEX_FACADE_BINARY;
it.skipIf(!binary).each([false, true])(
  "blocks a real Codex native command with subagent=%s",
  async (subagent) => {
    const home = await mkdtemp(join(tmpdir(), "buzz-hook-facade-"));
    const marker = join(home, "executed");
    const servers: ReturnType<typeof createServer>[] = [];
    const listen = async (
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => void | Promise<void>,
    ) => {
      const server = createServer(handler);
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      return `http://127.0.0.1:${address.port}`;
    };
    let initializations = 0;
    const serve = async (
      handler: McpHandler,
      options?: HostMcpOptions,
    ): Promise<HostMcpServer> => {
      const token = crypto.randomUUID();
      // Match host_mcp.rs: one initialized session, notifications answered by the bridge.
      const session = crypto.randomUUID();
      let claimed = false;
      let stopped = false;
      const url = await listen(async (req, res) => {
        if (stopped || req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        let body = "";
        for await (const data of req) body += data;
        const wire = JSON.parse(body);
        if (req.headers["mcp-session-id"] !== session) {
          if (
            wire.method !== "initialize" ||
            (claimed && !options?.sharedSession)
          ) {
            if (wire.method === "initialize") stopped = true;
            res.writeHead(404);
            res.end();
            return;
          }
          initializations++;
          claimed = true;
        }
        try {
          const result = await handler(wire);
          if (result === undefined) {
            res.writeHead(202, { "mcp-session-id": session });
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": session,
          });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: wire.id,
              error: { code: -32603, message: String(error) },
            }),
          );
        }
      });
      return {
        url: `${url}/mcp`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        close: async () => {},
        closed: new Promise(() => {}),
      };
    };
    const modelInputs: unknown[] = [];
    let requests = 0;
    let parentRequests = 0;
    let childRequests = 0;
    let spawned = false;
    let finishChild!: () => void;
    const childFinished = new Promise<void>((resolve) => {
      finishChild = resolve;
    });
    const model = await listen(async (req, res) => {
      let payload = "";
      for await (const data of req) payload += data;
      modelInputs.push(JSON.parse(payload));
      const input = JSON.parse(payload).input as {
        type?: string;
        call_id?: string;
        output?: string;
        role?: string;
        content?: { text?: string }[];
      }[];
      const child = [...input]
        .reverse()
        .find((item) => item.role === "user")
        ?.content?.some((item) => item.text === "Run the fixture command");
      const step = child ? ++childRequests : ++parentRequests;
      if (child && step === 2) finishChild();
      if (subagent && !child && step === 2) {
        spawned = input.some(
          (item) =>
            item.call_id === "call_spawn" && item.output?.includes("agent_id"),
        );
        if (spawned) await childFinished;
      }
      requests++;
      const item =
        subagent && !child && step === 1
          ? {
              id: "fc_spawn",
              type: "function_call",
              call_id: "call_spawn",
              name: "spawn_agent",
              namespace: "multi_agent_v1",
              arguments: JSON.stringify({ message: "Run the fixture command" }),
            }
          : step === (subagent && !child ? 2 : 1)
            ? {
                id: child ? "fc_child" : "fc_parent",
                type: "function_call",
                call_id: child ? "call_child" : "call_parent",
                name: "exec_command",
                arguments: JSON.stringify({
                  cmd: `touch ${marker}`,
                  max_output_tokens: 100,
                }),
              }
            : {
                id: "msg_done",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "Done", annotations: [] },
                ],
              };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [type, data] of [
        [
          "response.created",
          {
            response: {
              id: `r${requests}`,
              object: "response",
              status: "in_progress",
              output: [],
            },
          },
        ],
        ["response.output_item.added", { output_index: 0, item }],
        ["response.output_item.done", { output_index: 0, item }],
        [
          "response.completed",
          {
            response: {
              id: `r${requests}`,
              object: "response",
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ],
      ])
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
        );
      res.end();
    });
    const observed: string[] = [];
    const denied: string[] = [];
    const policy = async (_session: string, event: string, input: unknown) => {
      observed.push(event);

      if (
        event === "PreToolUse" &&
        (input as { tool_name?: string }).tool_name === "Bash"
      )
        denied.push((input as { tool_use_id: string }).tool_use_id);
      return event === "PreToolUse" &&
        (input as { tool_name?: string }).tool_name === "Bash"
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Fixture blocks the command",
            },
          }
        : {};
    };
    const bridge = await openHookBridge(
      serve,
      async (session, event, input) =>
        ((await dispatchAgentHooks(
          [
            {
              id: "observer",
              pluginId: "observer",
              harness: "codex",
              event,
              run: () => {
                if (event === "PreToolUse")
                  throw new Error("Fixture observer fails");
              },
            },
            {
              id: "policy",
              pluginId: "policy",
              harness: "codex",
              event,
              run: () => policy(session, event, input),
            },
          ],
          input,
          { agent: "fixture", session },
          (output) =>
            !!output &&
            typeof output === "object" &&
            Object.keys(output).length > 0,
          25000,
          nativeHookOutput,
        )) as Record<string, unknown>) ?? {},
    );
    const rpc = new AppServer();
    let stderr = "";
    try {
      await rpc.open(async (_id, options) => {
        const child = spawn(
          binary ?? "",
          [
            "app-server",
            ...callbackHookArgs,
            "-c",
            'model_provider="fixture"',
            "-c",
            `model_providers.fixture={name="Fixture",base_url="${model}",wire_api="responses",requires_openai_auth=false}`,
          ],
          {
            env: { ...process.env, CODEX_HOME: home },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        child.stdout.on("data", (data) => options?.onStdout?.(data.toString()));
        child.stderr.on("data", (data) => {
          stderr += data.toString();
          options?.onStderr?.(data.toString());
        });
        return {
          write: async (text) => {
            child.stdin.write(text);
          },
          end: async () => {
            child.stdin.end();
          },
          kill: async () => {
            child.kill();
          },
          exited: new Promise((resolve) => child.on("exit", resolve)),
        };
      }, home);
      const state = await nativeHookState(rpc, home);
      expect(Object.keys(state)).toHaveLength(CODEX_HOOK_EVENTS.length);
      const started = await rpc.request<{ thread: { id: string } }>(
        "thread/start",
        {
          cwd: home,
          model: "gpt-5.4",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: true,
          config: {
            mcp_servers: bridge.config,
            "hooks.state": state,
            "features.hooks": true,
            "features.plugins": false,
            "features.apps": false,
            "features.multi_agent": true,
            web_search: "disabled",
          },
        },
      );
      bridge.bind(started.thread.id);
      let done!: () => void;
      const completed = new Promise<void>((resolve) => {
        done = resolve;
      });
      rpc.onMessage((wire) => {
        if (
          wire.method === "turn/completed" &&
          (wire.params as { threadId?: string }).threadId === started.thread.id
        )
          done();
      });
      await rpc.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "Run fixture", text_elements: [] }],
      });
      await completed;
      expect(observed, stderr).toContain("PreToolUse");
      expect(JSON.stringify(modelInputs)).toContain(
        "[Buzz plugin: policy] Fixture blocks the command",
      );
      expect(observed, stderr).toContain("Stop");
      expect(denied, stderr).toContain("call_parent");
      if (subagent) {
        expect(spawned, stderr).toBe(true);
        expect(initializations, stderr).toBeGreaterThanOrEqual(2);
        expect(denied, stderr).toContain("call_child");
      }
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await bridge.close();
      await rpc.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
