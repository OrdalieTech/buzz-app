// @vitest-environment node
import { createServer } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeHookOutput } from "../hook-output";
import { ClaudeProcess } from "./claude";
import { expect, it } from "vitest";

it.skipIf(!process.env.CLAUDE_FACADE_BINARY).each(["deny", "throw"])(
  "handles a real Claude SDK hook decision and recovers (%s)",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "buzz-claude-hooks-")),
      marker = join(home, "executed");

    const modelInputs: unknown[] = [];
    let modelCalls = 0;
    let toolHooks = 0;
    const controlResponses: { subtype: string; error?: string }[] = [];
    const observed: string[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.url?.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"input_tokens":10}');
        return;
      }
      const data = JSON.parse(body);
      modelInputs.push(data);
      const auxiliary = !data.tools?.length;
      if (!auxiliary) modelCalls++;
      let block:
        | { type: "text"; text: string }
        | {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, string>;
          };
      if (auxiliary) block = { type: "text", text: "Fixture" };
      else if (modelCalls === 1 || modelCalls === 3)
        block = {
          type: "tool_use",
          id: `call_${modelCalls}`,
          name: "Bash",
          input: {
            command: `touch ${modelCalls === 1 ? marker : `${marker}-recovery`}`,
            description: "Fixture shell command",
          },
        };
      else block = { type: "text", text: "done" };
      const events: [string, Record<string, unknown>][] = [
        [
          "message_start",
          {
            message: {
              id: `msg_${modelCalls}`,
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-sonnet-4-6",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
        ],
        [
          "content_block_start",
          {
            index: 0,
            content_block:
              block.type === "tool_use"
                ? { ...block, input: {} }
                : { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            index: 0,
            delta:
              block.type === "tool_use"
                ? {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(block.input),
                  }
                : { type: "text_delta", text: block.text },
          },
        ],
        ["content_block_stop", { index: 0 }],
        [
          "message_delta",
          {
            delta: {
              stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 10 },
          },
        ],
        ["message_stop", {}],
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [type, value] of events)
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
        );
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let child: ChildProcessWithoutNullStreams | undefined;
    let claude: ClaudeProcess | undefined;
    try {
      claude = await ClaudeProcess.start(
        async (_id, options) => {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_API_KEY: "fixture",
            CLAUDE_CONFIG_DIR: home,
            DISABLE_NONESSENTIAL_TRAFFIC: "1",
          };
          for (const key of [
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
          ])
            delete env[key];
          for (const [k, v] of Object.entries(options?.env ?? {})) {
            if (v === null) delete env[k];
            else env[k] = v;
          }
          env.ANTHROPIC_API_KEY = "fixture";
          env.ANTHROPIC_BASE_URL = baseUrl;
          child = spawn(
            process.env.CLAUDE_FACADE_BINARY ?? "",
            [...(options?.args ?? [])],
            {
              cwd: home,
              env,
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          child.stdout.on("data", (d) => {
            options?.onStdout?.(d.toString());
          });
          child.stderr.on("data", (d) => {
            options?.onStderr?.(d.toString());
          });
          const running = child;
          return {
            write: async (text) => {
              const wire = JSON.parse(text);
              if (wire.type === "control_response")
                controlResponses.push(wire.response);
              running.stdin.write(text);
            },
            end: async () => {
              running.stdin.end();
            },
            kill: async () => {
              running.kill();
            },
            exited: new Promise<number | null>((resolve) =>
              running.on("exit", resolve),
            ),
          };
        },
        {
          cwd: home,
          systemPrompt: "This is a deterministic tool hook fixture.",
          model: "sonnet",
          tools: async (_session, message) => {
            const wire = message as { id?: number; method?: string };
            return {
              jsonrpc: "2.0",
              id: wire.id ?? 0,
              result:
                wire.method === "initialize"
                  ? {
                      protocolVersion: "2025-06-18",
                      capabilities: { tools: {} },
                      serverInfo: { name: "buzz", version: "1" },
                    }
                  : wire.method === "tools/list"
                    ? { tools: [] }
                    : {},
            };
          },
          hook: async (_session, name) => {
            observed.push(name);
            if (name === "PreToolUse" && ++toolHooks === 1 && mode === "throw")
              throw new Error("Fixture callback failed");
            return nativeHookOutput(
              name === "PreToolUse"
                ? {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "Fixture blocks the command",
                    },
                  }
                : {},
              "fixture-policy",
            ) as Record<string, unknown>;
          },
        },
      );
      const timer = setTimeout(() => child?.kill(), 30000);
      let outcome: Awaited<ReturnType<ClaudeProcess["send"]>>;
      try {
        outcome = await claude.send("Run the fixture.");
      } finally {
        clearTimeout(timer);
      }
      if (mode === "deny")
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      else {
        await expect(access(marker)).resolves.toBeUndefined();
        expect(controlResponses).toContainEqual(
          expect.objectContaining({
            subtype: "error",
            error: expect.stringContaining("Fixture callback failed"),
          }),
        );
        const recovery = await claude.send("Run the next fixture command.");
        expect(recovery).toMatchObject({ ok: true });
        await expect(access(`${marker}-recovery`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(toolHooks).toBe(2);
      }
      expect(outcome).toMatchObject({ ok: true });
      expect(observed).toContain("PreToolUse");
      expect(JSON.stringify(modelInputs)).toContain(
        "[Buzz plugin: fixture-policy] Fixture blocks the command",
      );
    } finally {
      await claude?.kill();
      child?.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
