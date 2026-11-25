import { spawn as spawnChild } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  renameSync,
  truncateSync,
  utimesSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import manifest from "./manifest.json";
import { withScript } from "./setup";
import type { HostProcessOptions } from "../../features/host/service";
import type { Wire } from "./rpc";
import { sessionTag } from "./prompt";
import {
  codexTurns,
  findConversation,
  readTranscript,
  shellCommand,
  TURN_LIMIT,
} from "./transcript";

const root = "c".repeat(64);
const conversation = { channelId: "channel", root };
const input = `<context>\n{"channel_id":"channel"}\n</context>\n<buzz-event>\n{"id":"e","pubkey":"sam"}\nRequest: "fix the \\u003ctests\\u003e"\n</buzz-event>`;
const turn = (patch: Record<string, unknown> = {}) => ({
  id: "turn-1",
  status: "completed",
  error: null,
  startedAt: 100,
  completedAt: 160,
  items: [
    {
      type: "userMessage",
      id: "u1",
      content: [{ type: "text", text: input }],
    },
    { type: "reasoning", id: "r1", summary: ["Looking at tests"] },
    {
      type: "commandExecution",
      id: "c1",
      command: "/bin/zsh -lc 'pnpm test'",
      aggregatedOutput: "1 failed",
      status: "failed",
      durationMs: 2000,
    },
    {
      type: "userMessage",
      id: "u2",
      content: [
        {
          type: "text",
          text: '<new-message-arrived-while-you-were-working>\n{}\nRequest: "also lint"\n</new-message-arrived-while-you-were-working>',
        },
      ],
    },
    {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [{ path: "a.ts", kind: "update", diff: "-a\n+b" }],
    },
    {
      type: "dynamicToolCall",
      id: "d1",
      namespace: "buzz",
      tool: "send",
      arguments: { text: "Done" },
      status: "completed",
      contentItems: [{ type: "inputText", text: `sent ${"d".repeat(64)}` }],
      success: true,
    },
    { type: "agentMessage", id: "a1", text: "Fixed." },
    { type: "contextCompaction", id: "x1" },
    // A final answer after the reply went through send.
    { type: "agentMessage", id: "a2", text: "" },
  ],
  ...patch,
});

it("shows a Codex turn's request, steering, tools and reply in the shared transcript model", () => {
  const [mapped] = codexTurns([turn()], conversation, (pubkey) =>
    pubkey === "sam" ? "Sam" : undefined,
  );
  expect(mapped).toMatchObject({
    turnId: "turn-1",
    channelId: "channel",
    threadRootId: root,
    startedAt: 100_000,
    endedAt: 160_000,
  });
  expect(mapped?.items).toEqual([
    expect.objectContaining({
      type: "prompt",
      text: "fix the <tests>",
      author: "Sam",
      authorPubkey: "sam",
      steer: false,
      sections: [
        expect.objectContaining({ tag: "context" }),
        expect.objectContaining({ tag: "buzz-event" }),
      ],
    }),
    expect.objectContaining({ type: "thought", text: "Looking at tests" }),
    expect.objectContaining({
      type: "tool",
      title: "pnpm test",
      kind: "execute",
      status: "failed",
      output: "1 failed",
      completedAt: 102_000,
    }),
    expect.objectContaining({ type: "prompt", text: "also lint", steer: true }),
    expect.objectContaining({
      type: "tool",
      kind: "edit",
      paths: ["a.ts"],
      output: "-a\n+b",
    }),
    expect.objectContaining({
      type: "message",
      text: "Done",
      posted: true,
      messageId: "d".repeat(64),
    }),
    expect.objectContaining({ type: "message", text: "Fixed." }),
    expect.objectContaining({ type: "status", text: "Context compaction" }),
  ]);
  const [channelTurn] = codexTurns(
    [turn({ status: "interrupted", completedAt: null, items: [] })],
    { channelId: "channel" },
  );
  expect(channelTurn).toMatchObject({
    threadRootId: null,
    stopReason: "interrupted",
  });
  expect(channelTurn).not.toHaveProperty("endedAt");
});

const agent = { key: "a".repeat(64), name: "Sol" };
const lookup = { agent, channelId: "channel", name: "dev", root };

it.each([
  ["summary only", { summary: ["Plan"] }, "Plan"],
  ["content only", { content: ["Raw"] }, "Raw"],
  ["both", { summary: ["Plan"], content: ["Raw"] }, "Plan\n\nRaw"],
  ["both, repeated", { summary: ["Same"], content: ["Same"] }, "Same"],
  [
    "summary with its own repeat",
    { summary: ["check", "retry", "check"], content: ["retry", "Raw"] },
    "check\n\nretry\n\ncheck\n\nRaw",
  ],
])("shows Codex reasoning from its %s", (_, reasoning, text) => {
  const [mapped] = codexTurns(
    [turn({ items: [{ type: "reasoning", id: "r1", ...reasoning }] })],
    conversation,
  );
  expect(mapped?.items).toEqual([
    expect.objectContaining({ type: "thought", text }),
  ]);
});
it("shows the command the model wrote, not the login shell running it", () => {
  expect(shellCommand("/bin/zsh -lc 'git diff --stat'")).toBe(
    "git diff --stat",
  );
  expect(shellCommand(`/bin/bash -lc 'echo '"'"'hi'"'"''`)).toBe("echo 'hi'");
  expect(shellCommand(`/bin/zsh -lc "sed -n '1,9p' a | grep \\"\\$x\\""`)).toBe(
    `sed -n '1,9p' a | grep "$x"`,
  );
  expect(shellCommand("pnpm test")).toBe("pnpm test");
});

it("shows a reply posted in a subthread as the agent's message", () => {
  const [mapped] = codexTurns(
    [
      turn({
        items: [
          {
            type: "dynamicToolCall",
            id: "d1",
            namespace: "buzz",
            tool: "reply_in_subthread",
            arguments: { parent: root, text: "Nested" },
            status: "completed",
            contentItems: [{ type: "inputText", text: "sent" }],
            success: true,
          },
        ],
      }),
    ],
    conversation,
  );
  expect(mapped?.items).toEqual([
    expect.objectContaining({ type: "message", text: "Nested", posted: true }),
  ]);
});

it("keeps a send that failed or has not finished as a tool call", () => {
  const send = (id: string, patch: Record<string, unknown>) => ({
    type: "dynamicToolCall",
    id,
    namespace: "buzz",
    tool: "send",
    arguments: { text: "Done" },
    ...patch,
  });
  const [mapped] = codexTurns(
    [
      turn({
        items: [
          send("d1", {
            status: "completed",
            contentItems: [{ type: "inputText", text: "channel not found" }],
            success: false,
          }),
          send("d2", {
            status: "inProgress",
            contentItems: null,
            success: null,
          }),
        ],
      }),
    ],
    conversation,
  );
  expect(mapped?.items).toEqual([
    expect.objectContaining({
      type: "tool",
      title: "buzz.send",
      status: "failed",
      output: "channel not found",
    }),
    expect.objectContaining({
      type: "tool",
      title: "buzz.send",
      status: "in_progress",
    }),
  ]);
});

/** An app-server answering `thread/turns/list` as the test says, with the
 * turns' items through `thread/items/list` when listed without them, and
 * `thread/list` from `threads` as Codex searches names: only the default
 * provider's threads, here none, unless asked for every provider's. */
function server(
  list: (params: Record<string, unknown>) => Wire,
  threads: { id: string; name: string; updatedAt: number }[] = [],
  rollout?: string | (() => string),
  path = "/sessions/rollout.jsonl",
) {
  const sent: Wire[] = [];
  const items = new Map<string, unknown[]>();
  const dir = mkdtempSync(join(tmpdir(), "codex-transcript-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  let written: string | undefined;
  const fileProcess = withScript(async (id, options) => {
    const declared = manifest.host.processes.find((p) => p.id === id);
    if (!declared) throw new Error(`undeclared process ${id}`);
    const child = spawnChild(
      declared.program,
      [...(declared.args ?? []), ...(options?.args ?? [])],
      { cwd: dir },
    );
    // Match the host's 64 KiB reads and take_text: an invalid sequence
    // flushes the whole buffer lossily, including its incomplete suffix.
    let pending: Buffer = Buffer.alloc(0);
    child.stdout.on("readable", () => {
      for (;;) {
        const chunk: Buffer | null = child.stdout.read(64 << 10);
        if (chunk === null) break;
        const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        });
        let text: string;
        try {
          text = decoder.decode(data, { stream: true });
          pending = data.subarray(Buffer.byteLength(text));
        } catch {
          text = data.toString("utf8");
          pending = Buffer.alloc(0);
        }
        if (text) options?.onStdout?.(text);
      }
    });
    child.stderr
      .setEncoding("utf8")
      .on("data", options?.onStderr ?? (() => {}));
    return {
      exited: new Promise<number | null>((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
      }),
      kill: async () => {
        child.kill();
      },
      write: async (text) => {
        child.stdin.write(text);
      },
      end: async () => {
        child.stdin.end();
      },
    };
  });
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    if (_id !== "app-server") {
      if (!options?.cwd?.startsWith("/") || options.args?.[0] !== path)
        throw new Error("Expected the rollout in its absolute directory");
      const file = typeof rollout === "function" ? rollout() : rollout;
      const local = join(dir, "rollout.jsonl");
      if (file !== undefined && file !== written) {
        writeFileSync(local, file);
        written = file;
      }
      return fileProcess(_id, {
        ...options,
        args: [local, ...options.args.slice(1)],
      });
    }
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    return {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        sent.push(wire);
        if (wire.id == null) return;
        const params = wire.params as Record<string, unknown>;
        const reply =
          wire.method === "thread/turns/list"
            ? unloaded(list(params), params, items)
            : wire.method === "thread/items/list"
              ? itemPage(items, params)
              : wire.method === "thread/read"
                ? { result: { thread: { path } } }
                : wire.method === "thread/list"
                  ? {
                      result: {
                        data: threads.filter(
                          (thread) =>
                            Array.isArray(params.modelProviders) &&
                            !params.modelProviders.length &&
                            thread.name.includes(String(params.searchTerm)),
                        ),
                      },
                    }
                  : { result: {} };
        options?.onStdout?.(`${JSON.stringify({ id: wire.id, ...reply })}\n`);
      },
      end: async () => exit(0),
      kill: async () => exit(1),
      exited,
    };
  });
  return { spawn, sent, file: join(dir, "rollout.jsonl") };
}

/** A `thread/turns/list` answer without its turns' items, as Codex gives for
 * `itemsView: "notLoaded"`, keeping them for `thread/items/list`. */
function unloaded(
  reply: Wire,
  { itemsView }: Record<string, unknown>,
  items: Map<string, unknown[]>,
): Wire {
  const result = reply.result as
    | { data?: Record<string, unknown>[] }
    | undefined;
  if (itemsView !== "notLoaded" || !result?.data) return reply;
  const data = result.data.map(({ items: all, ...turn }) => {
    items.set(String(turn.id), all as unknown[]);
    return { ...turn, items: [] };
  });
  return { result: { ...result, data } };
}

/** `thread/items/list` over a turn's items, oldest first, a page at a time. */
function itemPage(
  items: Map<string, unknown[]>,
  { turnId, limit, cursor }: Record<string, unknown>,
): Wire {
  const all = items.get(String(turnId)) ?? [];
  const start = Number(cursor ?? 0);
  const end = start + Number(limit);
  return {
    result: {
      data: all.slice(start, end).map((item) => ({ item, turnId })),
      nextCursor: end < all.length ? String(end) : null,
    },
  };
}

/** `thread/turns/list` over a thread's turns, newest first, a page at a time. */
const paged =
  (newest: unknown[]) =>
  ({ limit, cursor }: Record<string, unknown>): Wire => {
    const start = Number(cursor ?? 0);
    const end = start + Number(limit);
    return {
      result: {
        data: newest.slice(start, end),
        nextCursor: end < newest.length ? String(end) : null,
      },
    };
  };

it("loads the recorded script through the declared file reader, and reports unavailable details", async () => {
  const rollout = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "script",
        name: "exec",
        input: "text(42)",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "script",
        output: "42",
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  const { spawn } = server(paged([turn({ items: [] })]), [], rollout);
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith(
    "read-window",
    expect.objectContaining({
      args: [
        "/sessions/rollout.jsonl",
        "1",
        String(Buffer.byteLength(rollout)),
      ],
    }),
  );
  expect(read?.turns[0]?.items).toMatchObject([
    { title: "exec", input: "text(42)", output: "42" },
  ]);
  const unavailable = server(paged([turn()]));
  const fallback = await readTranscript(
    unavailable.spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(fallback?.turns[0]?.items[0]).toMatchObject({
    type: "status",
    text: expect.stringContaining("CodeMode scripts could not be loaded"),
  });
  expect(fallback?.turns[0]?.items).toContainEqual(
    expect.objectContaining({ title: "pnpm test" }),
  );
});

it("reads only what a rollout appended since its last read, showing the same recorded tools", async () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "script",
        name: "exec",
        input: "text(42)",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "script",
        output: "42",
      },
    },
  ].map((record) => JSON.stringify(record));
  // The first read ends partway through the output record.
  const cut = `${records.slice(0, 2).join("\n")}\n${records[2]?.slice(0, 20)}`;
  let file = cut;
  const path = "/sessions/appended.jsonl";
  // While its turn works, the rollout is remembered between reads.
  const working = () =>
    paged([turn({ items: [], status: "interrupted", completedAt: null })]);
  const { spawn } = server(working(), [], () => file, path);
  const lookupOne = { ...lookup, threadId: "thread-1" };
  const first = await readTranscript(
    spawn,
    lookupOne,
    new AbortController().signal,
    undefined,
    true,
  );
  expect(first?.turns[0]?.items).toMatchObject([
    { title: "exec", input: "text(42)" },
  ]);
  file = records.join("\n");
  const second = await readTranscript(
    spawn,
    lookupOne,
    new AbortController().signal,
    undefined,
    true,
  );
  // From the partial line on, not the whole file again.
  const whole = records.slice(0, 2).join("\n").length + 1;
  expect(spawn).toHaveBeenLastCalledWith(
    "read-window",
    expect.objectContaining({
      args: [path, String(whole + 1), String(Buffer.byteLength(file) - whole)],
    }),
  );
  const fresh = await readTranscript(
    server(working(), [], file, "/sessions/fresh.jsonl").spawn,
    lookupOne,
    new AbortController().signal,
    undefined,
    true,
  );
  expect(second?.turns).toEqual(fresh?.turns);
  // A file that shrank is read whole again, not from the old text.
  file = records.slice(0, 2).join("\n");
  const shrunk = await readTranscript(
    spawn,
    lookupOne,
    new AbortController().signal,
    undefined,
    true,
  );
  expect(
    spawn.mock.calls.filter(
      ([id, options]) =>
        id === "read-window" &&
        options?.args?.[0] === path &&
        options.args[1] === "1",
    ),
  ).toHaveLength(2);
  expect(shrunk?.turns).toEqual(
    (
      await readTranscript(
        server(working(), [], file, "/sessions/shrunk.jsonl").spawn,
        lookupOne,
        new AbortController().signal,
        undefined,
        true,
      )
    )?.turns,
  );
  expect(second?.turns[0]?.items).toMatchObject([
    { title: "exec", input: "text(42)", output: "42" },
  ]);
});

it("reads the latest turns oldest first, and closes its app-server", async () => {
  const { spawn, sent } = server(
    paged([
      turn({ id: "turn-2", status: "inProgress", completedAt: null }),
      turn(),
      ...Array.from({ length: TURN_LIMIT }, (_, index) =>
        turn({ id: `earlier-${index}`, startedAt: 99 - index }),
      ),
    ]),
  );
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith("app-server", expect.anything());
  expect(
    sent.filter((w) => w.method === "thread/turns/list").map((w) => w.params),
  ).toEqual([
    {
      threadId: "thread-1",
      limit: TURN_LIMIT,
      sortDirection: "desc",
      itemsView: "notLoaded",
    },
  ]);
  expect(read?.turns).toHaveLength(TURN_LIMIT);
  expect(read?.turns.slice(-2).map((t) => t.turnId)).toEqual([
    "turn-1",
    "turn-2",
  ]);
  expect(read).toMatchObject({ more: true, working: true });
});

it("reads turns that each fit app-server's output frame but together do not", async () => {
  // Three turns of 1.5 MiB: one per frame fits the 4 MiB bound, all three not.
  const big = (id: string) =>
    turn({
      id,
      items: [
        {
          type: "commandExecution",
          id: "c",
          command: "cat log",
          aggregatedOutput: "x".repeat(1.5 * 1024 * 1024),
          status: "completed",
        },
      ],
    });
  const { spawn } = server(paged([big("c"), big("b"), big("a")]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(read?.turns.map((t) => t.turnId)).toEqual(["a", "b", "c"]);
  expect(read?.more).toBe(false);
});

it("reads a turn whose items together exceed app-server's output frame", async () => {
  // A long turn of 100 small commands: 4.4 MiB as one frame, over the 4 MiB
  // bound, while each page of its items fits.
  const commands = Array.from({ length: 100 }, (_, index) => ({
    type: "commandExecution",
    id: `c${index}`,
    command: "cat log",
    aggregatedOutput: "x".repeat(45 * 1024),
    status: "completed",
  }));
  const { spawn, sent } = server(paged([turn({ items: commands })]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(
    read?.turns[0]?.items.filter((item) => item.type === "tool"),
  ).toHaveLength(100);
  expect(
    sent.filter((w) => w.method === "thread/items/list").map((w) => w.params),
  ).toEqual([
    { threadId: "thread-1", turnId: "turn-1", limit: 50 },
    { threadId: "thread-1", turnId: "turn-1", limit: 50, cursor: "50" },
  ]);
});

it("reads a page over app-server's output frame again on a fresh connection, at half the size", async () => {
  // 40 items of 200 KiB: a page of 50 or 25 is over the 4 MiB bound, 13 fit.
  const commands = Array.from({ length: 40 }, (_, index) => ({
    type: "commandExecution",
    id: `c${index}`,
    command: "cat log",
    aggregatedOutput: "x".repeat(200 * 1024),
    status: "completed",
  }));
  const { spawn, sent } = server(paged([turn({ items: commands })]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(
    read?.turns[0]?.items.filter((item) => item.type === "tool"),
  ).toHaveLength(40);
  const page = (limit: number, cursor?: string) => ({
    threadId: "thread-1",
    turnId: "turn-1",
    limit,
    ...(cursor ? { cursor } : {}),
  });
  expect(
    sent.filter((w) => w.method === "thread/items/list").map((w) => w.params),
  ).toEqual([
    page(50),
    page(25),
    page(13),
    page(13, "13"),
    page(13, "26"),
    page(13, "39"),
  ]);
  expect(spawn.mock.calls.filter(([id]) => id === "app-server")).toHaveLength(
    3,
  );
});

it("starts each turn's items at the page size the previous turn ended on", async () => {
  // 40 items of 200 KiB per turn: 13 fit a frame, so only the first turn
  // halves its page down to them.
  const big = (id: string) =>
    turn({
      id,
      items: Array.from({ length: 40 }, (_, index) => ({
        type: "commandExecution",
        id: `c${index}`,
        command: "cat log",
        aggregatedOutput: "x".repeat(200 * 1024),
        status: "completed",
      })),
    });
  const { spawn, sent } = server(paged([big("b"), big("a")]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(
    read?.turns.map((t) => t.items.filter((i) => i.type === "tool").length),
  ).toEqual([40, 40]);
  expect(
    sent
      .filter((w) => w.method === "thread/items/list")
      .map((w) => (w.params as { limit: number }).limit),
  ).toEqual([50, 25, 13, 13, 13, 13, 13, 13, 13, 13]);
  expect(spawn.mock.calls.filter(([id]) => id === "app-server")).toHaveLength(
    3,
  );
});

it("stops a transcript aborted while reopening after an oversized page", async () => {
  const commands = Array.from({ length: 40 }, (_, index) => ({
    type: "commandExecution",
    id: `c${index}`,
    command: "cat log",
    aggregatedOutput: "x".repeat(200 * 1024),
    status: "completed",
  }));
  const { spawn, sent } = server(paged([turn({ items: commands })]));
  const controller = new AbortController();
  let opened = 0;
  const aborting: typeof spawn = vi.fn(async (id, options) => {
    const process = await spawn(id, options);
    if (id !== "app-server") return process;
    const n = ++opened;
    return {
      ...process,
      end: async () => {
        // The transcript is closed while the oversized connection is closing.
        if (n === 1) controller.abort();
        await process.end();
      },
    };
  });
  await expect(
    readTranscript(
      aborting,
      { ...lookup, threadId: "thread-1" },
      controller.signal,
    ),
  ).rejects.toThrow(/abort/i);
  expect(
    sent
      .filter((w) => w.method === "thread/items/list")
      .map((w) => (w.params as { limit: number }).limit),
  ).toEqual([50]);
  // No fresh app-server is opened for the aborted transcript.
  expect(opened).toBe(1);
});

it("fails a transcript with an item over app-server's output frame", async () => {
  const huge = {
    type: "commandExecution",
    id: "c1",
    command: "cat log",
    aggregatedOutput: "x".repeat(5 * 1024 * 1024),
    status: "completed",
  };
  const { spawn, sent } = server(paged([turn({ items: [huge] })]));
  await expect(
    readTranscript(
      spawn,
      { ...lookup, threadId: "thread-1" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Codex output frame is too large");
  expect(
    sent
      .filter((w) => w.method === "thread/items/list")
      .map((w) => (w.params as { limit: number }).limit),
  ).toEqual([50, 25, 13, 7, 4, 2, 1]);
});

const turnStart = (id: string) =>
  JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: id },
  });
const scriptCall = (id: string, input = "🎈") =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: id,
      input,
    },
  });

function fileTranscript(name: string, turns = [turn({ items: [] })]) {
  const { file, spawn } = server(
    paged(turns),
    [],
    undefined,
    `/sessions/${name}.jsonl`,
  );
  return {
    file,
    spawn,
    read: (working = false) =>
      readTranscript(
        spawn,
        { ...lookup, threadId: "thread-1" },
        new AbortController().signal,
        undefined,
        working,
      ),
  };
}

it("opens an empty rollout without asking the host to read zero bytes", async () => {
  const { file, read, spawn } = fileTranscript("empty");
  writeFileSync(file, "");
  expect((await read())?.turns[0]?.items).toEqual([]);
  expect(spawn.mock.calls.map(([id]) => id)).not.toContain("read-window");
});

it("restores an appended script when the first poll ends inside a UTF-8 character", async () => {
  const { file, read, spawn } = fileTranscript("split-utf8");
  const bytes = Buffer.from(`${turnStart("turn-1")}\n${scriptCall("split")}\n`);
  const cut = bytes.indexOf("🎈") + 2;
  writeFileSync(file, bytes.subarray(0, cut));
  expect((await read(true))?.turns[0]?.items).toEqual([]);
  appendFileSync(file, bytes.subarray(cut));
  expect((await read(true))?.turns[0]?.items).toMatchObject([
    { id: "split", input: "🎈" },
  ]);
  const complete = bytes.indexOf(10) + 1;
  expect(spawn).toHaveBeenLastCalledWith(
    "read-window",
    expect.objectContaining({
      args: [
        "/sessions/split-utf8.jsonl",
        String(complete + 1),
        String(bytes.length - complete),
      ],
    }),
  );
});

it("restores the same script text when the first tail byte splits a character", async () => {
  const { file, read } = fileTranscript("utf8-tail");
  const input = "🎈".repeat(32_768);
  const records = [turnStart("turn-1"), scriptCall("dense", input), ""].join(
    "\n",
  );
  writeFileSync(file, records);
  const whole = (await read())?.turns[0]?.items;
  expect(whole).toMatchObject([{ id: "dense", input }]);

  const block = Buffer.from(`${JSON.stringify("🎈".repeat(16_383))} \n`);
  writeFileSync(file, "");
  for (let i = 0; i < 320; i++) appendFileSync(file, block);
  appendFileSync(file, `${turnStart("earlier")}\n`);
  const previous = scriptCall("earlier-script", "🎈".repeat(1_024));
  const cut = Buffer.from(previous).indexOf("🎈") + 3;
  const seam = `${previous}\n${records}`;
  appendFileSync(file, seam);
  // File size puts the 32 MiB cut inside the balloon in the preceding line.
  const remaining = (32 << 20) + cut - Buffer.byteLength(seam);
  for (let i = 0; i < Math.floor(remaining / block.length); i++)
    appendFileSync(file, block);
  appendFileSync(file, Buffer.alloc(remaining % block.length, 32));
  expect((await read())?.turns[0]?.items).toEqual(whole);
});

it("refreshes a working rollout rewritten in place at the same size", async () => {
  const { file, read } = fileTranscript("rewrite");
  const start = turnStart("turn-1");
  writeFileSync(file, `${start}\n${scriptCall("old")}\n`);
  expect((await read(true))?.turns[0]?.items).toMatchObject([{ id: "old" }]);
  writeFileSync(file, `${start}\n${scriptCall("new")}\n`);
  utimesSync(file, 1, 1);
  expect((await read(true))?.turns[0]?.items).toMatchObject([{ id: "new" }]);
});

it("restores shown scripts when a newer turn has no start record", async () => {
  const { file, read, spawn } = fileTranscript("missing-start", [
    turn({ id: "latest", items: [], status: "inProgress" }),
    turn({ items: [] }),
  ]);
  writeFileSync(file, "");
  truncateSync(file, 64 << 20);
  appendFileSync(
    file,
    '\n{"type":"turn_context","payload":{"turn_id":"older"}}\n' +
      '{"type":"turn_context","payload":{"turn_id":"turn-1"}}\n' +
      scriptCall("shown") +
      "\n",
  );
  const view = await read();
  expect(view?.turns.map((t) => t.items.map((i) => i.id))).toEqual([
    ["shown"],
    [],
  ]);
  expect(spawn.mock.calls.filter(([id]) => id === "read-window")).toHaveLength(
    1,
  );
});

it("keeps the first script when the oldest turn starts twice", async () => {
  const { file, read } = fileTranscript("repeated-start", [
    ...Array.from({ length: TURN_LIMIT - 1 }, (_, i) =>
      turn({ id: `newer-${i}`, items: [] }),
    ),
    turn({ items: [] }),
    turn({ id: "earlier", items: [] }),
  ]);
  const start = `${turnStart("turn-1")}\n`;
  writeFileSync(file, "");
  for (let mib = 1; mib <= 60; mib++) {
    truncateSync(file, mib << 20);
    appendFileSync(file, "\n");
    if (mib === 8) appendFileSync(file, `${turnStart("earlier")}\n`);
    if (mib === 15) appendFileSync(file, `${start}${scriptCall("first")}\n`);
    if (mib === 35) appendFileSync(file, `${start}${scriptCall("second")}\n`);
  }
  const view = await read();
  expect(view?.more).toBe(true);
  expect(view?.turns[0]?.items.map((i) => i.id)).toEqual(["first", "second"]);
});

it("restores scripts at 50 MiB and explains when the shown turns exceed the limit by one byte", async () => {
  const { file, read } = fileTranscript("span");
  const prefix = 1 << 20;
  writeFileSync(file, "");
  truncateSync(file, prefix - 1);
  appendFileSync(
    file,
    "\n" +
      turnStart("turn-1") +
      '\n{"type":"turn_context","payload":{"turn_id":"turn-1"}}\n' +
      scriptCall("one") +
      "\n",
  );
  truncateSync(file, prefix + (50 << 20) - 1);
  appendFileSync(file, "\n");
  expect((await read(true))?.turns[0]?.items).toMatchObject([{ id: "one" }]);
  appendFileSync(file, "\n");
  expect((await read(true))?.turns[0]?.items).toMatchObject([
    {
      id: "thread-1:recorded-tools-unavailable",
      type: "status",
      text: "CodeMode scripts could not be loaded. Showing app-server history only. The turns shown take more than 50 MB of /sessions/span.jsonl",
    },
  ]);
});

it.each(["shrink", "replacement", "oldest turn"] as const)(
  "reuses an over-cap warning on append and drops it after a change of %s",
  async (change) => {
    const turns = [turn({ id: "latest", items: [] }), turn({ items: [] })];
    const { file, read, spawn } = fileTranscript(`oversize-${change}`, turns);
    const limit = 50 << 20;
    const tail = `\n${turnStart("latest")}\n${scriptCall("recent")}\n`;
    writeFileSync(file, `${turnStart("turn-1")}\n`);
    for (let i = 1; i <= 51; i++) {
      truncateSync(file, i << 20);
      appendFileSync(file, "\n");
    }
    appendFileSync(file, `${turnStart("turn-1")}${tail}`);
    const first = await read(true);
    const warning = first?.turns.at(-1)?.items;
    expect(warning).toMatchObject([
      {
        type: "status",
        text: expect.stringContaining(
          `The turns shown take more than 50 MB of /sessions/oversize-${change}.jsonl`,
        ),
      },
    ]);
    spawn.mockClear();
    appendFileSync(file, "\n");
    expect((await read(true))?.turns.at(-1)?.items).toEqual(warning);
    expect(spawn.mock.calls.map(([id]) => id)).not.toContain("read-window");

    if (change === "shrink") {
      truncateSync(file, limit - 1024);
      appendFileSync(file, tail);
    } else if (change === "replacement") {
      const replacement = `${file}.new`;
      writeFileSync(replacement, "");
      truncateSync(replacement, 52 << 20);
      appendFileSync(
        replacement,
        `\n${turnStart("earlier")}\n${turnStart("turn-1")}${tail}`,
      );
      renameSync(replacement, file);
    } else turns.pop();
    expect((await read(true))?.turns.at(-1)?.items).toMatchObject([
      { id: "recent" },
    ]);
  },
);

it("streams a working rollout again past the cache record limit", async () => {
  const { file, spawn, read } = fileTranscript("record-count");
  writeFileSync(
    file,
    turnStart("turn-1") +
      "\n" +
      '{"type":"turn_context","payload":{"turn_id":"turn-1"}}\n'.repeat(8193) +
      scriptCall("one") +
      "\n",
  );
  for (let poll = 0; poll < 2; poll++)
    expect((await read(true))?.turns[0]?.items).toMatchObject([{ id: "one" }]);
  expect(spawn.mock.calls.filter(([id]) => id === "read-window")).toHaveLength(
    2,
  );
});

it("remembers a rollout while a thread found by name is in progress", async () => {
  const tag = sessionTag(agent.key, lookup);
  const path = "/sessions/named.jsonl";
  const { spawn } = server(
    paged([turn({ items: [], status: "inProgress", completedAt: null })]),
    [{ id: "tagged", name: `Named · ${tag}`, updatedAt: 1 }],
    '{"type":"event_msg"}\n',
    path,
  );
  const signal = new AbortController().signal;
  expect(lookup).not.toHaveProperty("threadId");
  await readTranscript(spawn, lookup, signal);
  await readTranscript(spawn, lookup, signal);
  expect(spawn.mock.calls.filter(([id]) => id === "read-window")).toHaveLength(
    1,
  );
});

it("merges the threads other builds started, found by tag or by their earlier name", async () => {
  const tag = sessionTag(agent.key, lookup);
  const title = `Buzz #dev · thread ${root.slice(0, 8)} · Sol`;
  const threads = [
    { id: "tagged", name: `Renamed · ${tag}`, updatedAt: 3 },
    { id: "legacy", name: title, updatedAt: 2 },
    // Same name, from a same-named channel elsewhere.
    { id: "same-name", name: title, updatedAt: 9 },
    {
      id: "other-agent",
      name: `${title} · buzz:0000000000000000`,
      updatedAt: 4,
    },
  ];
  const started: Record<string, [number, string]> = {
    "thread-1": [300, "channel"],
    tagged: [200, "channel"],
    legacy: [100, "channel"],
    "same-name": [400, "elsewhere"],
  };
  const list = ({ threadId }: Record<string, unknown>): Wire => {
    const [startedAt, channel] = started[String(threadId)] ?? [0, ""];
    const text = `<context>\n${JSON.stringify({ channel_id: channel, session_thread: root })}\n</context>\nRequest: "hi"`;
    return {
      result: {
        data: [
          turn({
            id: String(threadId),
            startedAt,
            items: [
              {
                type: "userMessage",
                id: "u",
                content: [{ type: "text", text }],
              },
            ],
          }),
        ],
        nextCursor: null,
      },
    };
  };
  const { spawn, sent } = server(list, threads);
  const signal = new AbortController().signal;
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    signal,
  );
  expect(read?.turns.map((t) => t.turnId)).toEqual([
    "legacy",
    "tagged",
    "thread-1",
  ]);
  expect(
    sent.filter((w) => w.method === "thread/list").map((w) => w.params),
  ).toEqual([
    { searchTerm: tag, modelProviders: [], limit: 50, useStateDbOnly: true },
    { searchTerm: title, modelProviders: [], limit: 50, useStateDbOnly: true },
  ]);
  // With no saved thread, the newest one found for it is the conversation's.
  await expect(
    findConversation(server(list, threads).spawn, lookup, signal),
  ).resolves.toEqual({ threadId: "tagged", at: 3000 });
  await expect(
    findConversation(server(list, threads.slice(1)).spawn, lookup, signal),
  ).resolves.toEqual({ threadId: "legacy", at: 2000 });
  await expect(
    findConversation(
      server(list, []).spawn,
      { agent, channelId: "channel", name: "dev" },
      signal,
    ),
  ).resolves.toBeUndefined();
});

it("treats a thread Codex no longer has as missing, and other failures as errors", async () => {
  const signal = new AbortController().signal;
  const saved = { ...lookup, threadId: "thread-1" };
  const gone = server(() => ({
    error: { code: -32600, message: "thread not loaded: thread-1" },
  }));
  await expect(
    readTranscript(gone.spawn, saved, signal),
  ).resolves.toBeUndefined();
  const broken = server(() => ({
    error: { code: -32603, message: "database is locked" },
  }));
  await expect(readTranscript(broken.spawn, saved, signal)).rejects.toThrow(
    "database is locked",
  );
});
