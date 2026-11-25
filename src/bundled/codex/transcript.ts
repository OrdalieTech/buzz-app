// A conversation's Codex thread, read back through app-server and shown in the
// host's turn-transcript model. Codex owns the history; nothing here is saved.
import { isMessageTool } from "../../buzz-mcp/session-tools";
import {
  postedAs,
  promptSections,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import type { AgentKey } from "../../features/agents/membership";
import { sessionTag, sessionTitle } from "./prompt";
import { AppServer, Oversized, type Spawn } from "./rpc";
import { READ_LIMIT } from "../../buzz-mcp/app-client";
import {
  recordedLines,
  recordedTurnStart,
  restoreRecordedTools,
} from "./recorded-tools";

/** The latest turns shown; earlier ones stay in Codex's own history. */
export const TURN_LIMIT = 20;
/** Items per `thread/items/list` request, which fit app-server's frame unless
 * they average over 80 KiB. */
const ITEM_PAGE = 50;

type Json = Record<string, unknown>;
type Turn = {
  id: string;
  items: Json[];
  status: string;
  error: { message?: string } | null;
  startedAt: number | null;
  completedAt: number | null;
};
export type CodexTranscript = Transcript & { more: boolean; working: boolean };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const display = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
const STATUS: Record<string, string> = {
  inProgress: "in_progress",
  failed: "failed",
  declined: "failed",
};

/** Codex runs each command through the login shell, as `/bin/zsh -lc '…'`;
 * the command the model wrote is the quoted part. */
export function shellCommand(command: string) {
  const quoted = command.match(/^\S*sh -lc (?:'([\s\S]*)'|"([\s\S]*)")$/);
  if (!quoted) return command;
  return quoted[1] !== undefined
    ? quoted[1].replaceAll(`'"'"'`, "'").replaceAll(`'\\''`, "'")
    : (quoted[2] ?? "").replace(/\\([\\"$`])/g, "$1");
}

/** Who sent a Buzz turn input: its event, the first line of a section. */
function sender(sections: readonly { body: string }[]) {
  for (const { body } of sections) {
    try {
      const pubkey = (JSON.parse(body.split("\n")[0] ?? "") as Json).pubkey;
      if (typeof pubkey === "string") return pubkey;
    } catch {}
  }
  return undefined;
}

/** The owner's request inside a Buzz turn input; other framing stays in sections. */
function request(text: string) {
  const quoted = [...text.matchAll(/^Request: (".*")$/gm)].pop()?.[1];
  try {
    return quoted ? String(JSON.parse(quoted)) : text;
  } catch {
    return text;
  }
}

function item(
  value: Json,
  at: number,
  steer: boolean,
  name: Names,
): TranscriptItem | undefined {
  const id = str(value.id);
  const tool = (patch: Partial<ToolItem>): ToolItem => ({
    id,
    at,
    type: "tool",
    toolCallId: id,
    title: "",
    kind: "other",
    status: STATUS[str(value.status)] ?? "completed",
    input: "",
    output: "",
    diffs: [],
    paths: [],
    truncated: false,
    ...(typeof value.durationMs === "number"
      ? { completedAt: at + value.durationMs }
      : {}),
    ...patch,
  });
  switch (value.type) {
    case "userMessage": {
      const raw = (Array.isArray(value.content) ? value.content : [])
        .map((part: Json) => str(part.text))
        .join("\n");
      const sections = promptSections(raw);
      const from = sender(sections);
      const author = from && name(from);
      return {
        id,
        at,
        type: "prompt",
        text: request(raw),
        ...(author ? { author } : {}),
        ...(from ? { authorPubkey: from } : {}),
        sections,
        steer,
      };
    }
    case "agentMessage":
      // A turn's final answer is often empty: the reply went through send.
      return str(value.text).trim()
        ? { id, at, type: "message", text: str(value.text) }
        : undefined;
    case "reasoning": {
      const texts = (part: unknown) =>
        Array.isArray(part) ? part.map(str).filter(Boolean) : [];
      const summary = texts(value.summary);
      // Raw content can repeat the summary; show that text once.
      const content = texts(value.content).filter((t) => !summary.includes(t));
      const text = [...summary, ...content].join("\n\n");
      return text ? { id, at, type: "thought", text } : undefined;
    }
    case "plan":
      return { id, at, type: "status", text: str(value.text) };
    case "contextCompaction":
      return { id, at, type: "status", text: "Context compaction" };
    case "commandExecution":
      return tool({
        title: shellCommand(str(value.command)),
        kind: "execute",
        output: str(value.aggregatedOutput),
      });
    case "fileChange": {
      const changes = (
        Array.isArray(value.changes) ? value.changes : []
      ) as Json[];
      return tool({
        title: "Edit files",
        kind: "edit",
        paths: changes.map((change) => str(change.path)),
        output: changes.map((change) => str(change.diff)).join("\n"),
      });
    }
    case "mcpToolCall":
      return tool({
        title: `${str(value.server)}.${str(value.tool)}`,
        input: display(value.arguments),
        output: display(value.error ?? value.result),
      });
    case "dynamicToolCall": {
      const args = (value.arguments ?? {}) as Json;
      const output = (
        Array.isArray(value.contentItems) ? value.contentItems : []
      )
        .map((part: Json) => str(part.text))
        .join("\n");
      if (
        value.namespace === "buzz" &&
        isMessageTool(value.tool) &&
        value.success === true &&
        str(args.text).trim()
      )
        return {
          id,
          at,
          type: "message",
          text: str(args.text),
          ...postedAs(output),
        };
      return tool({
        title: [value.namespace, value.tool].filter(Boolean).join("."),
        input: display(value.arguments),
        output,
        ...(value.success === false ? { status: "failed" } : {}),
      });
    }
    case "webSearch":
      return tool({
        title: "Web search",
        kind: "fetch",
        input: str(value.query),
      });
    default:
      return undefined;
  }
}

/** A display name for a pubkey, if known. */
type Names = (pubkey: string) => string | undefined;

/** Codex turns, oldest first, as transcript turns for one conversation. */
export function codexTurns(
  turns: readonly Turn[],
  conversation: { channelId: string; root?: string },
  name: Names = () => undefined,
): TranscriptTurn[] {
  return turns.map((turn) => {
    const startedAt = (turn.startedAt ?? 0) * 1000;
    let prompts = 0;
    const items = turn.items.flatMap((value) => {
      const next = item(
        value,
        startedAt,
        value.type === "userMessage" && prompts++ > 0,
        name,
      );
      return next ? [next] : [];
    });
    return {
      turnId: turn.id,
      channelId: conversation.channelId,
      threadRootId: conversation.root ?? null,
      triggeringEventIds: [],
      newSession: false,
      config: [],
      startedAt,
      ...(turn.completedAt ? { endedAt: turn.completedAt * 1000 } : {}),
      ...(turn.error?.message ? { error: turn.error.message } : {}),
      ...(turn.status === "interrupted" ? { stopReason: "interrupted" } : {}),
      partial: false,
      items,
    };
  });
}

/** A missing rollout (deleted, or never written) is not a read failure. */
const missing = (error: unknown) =>
  /not loaded|no rollout|not found/i.test(
    error instanceof Error ? error.message : String(error),
  );

/** A conversation to read: its saved thread, if this build has one, and what
 * finds the threads other builds started for it. */
export type Lookup = Readonly<{
  agent: Readonly<{ key: AgentKey; name: string }>;
  channelId: string;
  /** The channel's name, as the agent named threads with it. */
  name?: string;
  root?: string;
  community?: true;
  threadId?: string;
}>;
/** `legacy` threads were named without the tag, so their name alone does not
 * tell same-named channels apart. */
type Found = { id: string; updatedAt: number; legacy: boolean };

/** Whether `turns` were for the conversation, as their prompts' context says. */
function startedFor(turns: readonly Turn[], lookup: Lookup) {
  return turns.some((turn) =>
    turn.items.some((value) => {
      if (value.type !== "userMessage") return false;
      const raw = (Array.isArray(value.content) ? value.content : [])
        .map((part: Json) => str(part.text))
        .join("\n");
      const body = promptSections(raw).find(
        (section) => section.tag === "context",
      )?.body;
      try {
        const context = JSON.parse(body ?? "") as Json;
        return lookup.community
          ? context.session_scope === "community"
          : context.session_scope !== "community" &&
              context.channel_id === lookup.channelId &&
              (context.session_thread ?? undefined) === lookup.root;
      } catch {
        return false;
      }
    }),
  );
}

/** The conversation's threads, newest first: named with its tag, or with the
 * readable name alone that earlier versions used. */
async function findThreads(rpc: AppServer, lookup: Lookup): Promise<Found[]> {
  const conversation = {
    channelId: lookup.channelId,
    ...(lookup.community ? { community: true as const } : {}),
    name: lookup.name ?? lookup.channelId,
    ...(lookup.root ? { root: lookup.root } : {}),
  };
  const tag = sessionTag(lookup.agent.key, conversation);
  const title = sessionTitle(lookup.agent.name, conversation);
  const found = new Map<string, Found>();
  for (const [term, legacy, named] of [
    [tag, false, (name: string) => name.endsWith(` · ${tag}`)],
    [title, true, (name: string) => name === title],
  ] as const) {
    // Without `modelProviders`, Codex lists only its default provider's
    // threads, which can leave out every thread the agent ran. Without
    // `useStateDbOnly`, it reads every rollout file before matching names.
    const page = await rpc.request<{
      data: { id: string; name: string | null; updatedAt: number }[];
    }>("thread/list", {
      searchTerm: term,
      modelProviders: [],
      limit: 50,
      useStateDbOnly: true,
    });
    for (const { id, name, updatedAt } of page.data)
      if (name && named(name) && !found.has(id))
        found.set(id, { id, updatedAt, legacy });
  }
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** When the conversation's newest thread was last used, or undefined when
 * Codex has no thread for it on this device. */
export async function findConversation(
  spawn: Spawn,
  lookup: Lookup,
  signal: AbortSignal,
) {
  return withServer(spawn, signal, async (rpc) => {
    for (const thread of await findThreads(rpc, lookup))
      if (
        !thread.legacy ||
        startedFor(await turns(rpc, thread.id, 1, signal), lookup)
      )
        return { threadId: thread.id, at: thread.updatedAt * 1000 };
    return undefined;
  });
}

type Page = { data: Turn[]; nextCursor: string | null };

/** A thread's latest `limit` turns, newest first, and whether it has earlier
 * ones, or undefined when Codex no longer has it. Turns are listed without
 * their items, which are read a page at a time: app-server's output frame
 * bounds a page of items, while one long turn can exceed it. */
async function page(
  rpc: AppServer,
  threadId: string,
  limit: number,
  signal: AbortSignal,
) {
  const data: Turn[] = [];
  let cursor: string | null = null;
  try {
    do {
      const next: Page = await rpc.request<Page>("thread/turns/list", {
        threadId,
        limit: limit - data.length,
        sortDirection: "desc",
        itemsView: "notLoaded",
        ...(cursor ? { cursor } : {}),
      });
      data.push(...next.data);
      cursor = next.data.length ? next.nextCursor : null;
    } while (cursor && data.length < limit);
    // Each turn's items start at the page size the previous one ended on.
    let size = ITEM_PAGE;
    for (const turn of data)
      [turn.items, size] = await items(rpc, threadId, turn.id, size, signal);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  return { data, more: !!cursor };
}

/** A turn's items, oldest first, a page of `limit` per request, and the page
 * size it ended on. A page over app-server's frame closes the connection, so
 * it is read again from its cursor on a fresh one, at half the size, as is the
 * rest of the turn. */
async function items(
  rpc: AppServer,
  threadId: string,
  turnId: string,
  limit: number,
  signal: AbortSignal,
): Promise<[Json[], number]> {
  const all: Json[] = [];
  let cursor: string | null = null;
  for (;;) {
    let next: { data: { item: Json }[]; nextCursor: string | null };
    try {
      next = await rpc.request("thread/items/list", {
        threadId,
        turnId,
        limit,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (!(error instanceof Oversized) || limit === 1) throw error;
      limit = Math.ceil(limit / 2);
      // An abort while closing opens no fresh connection.
      await rpc.close();
      signal.throwIfAborted();
      await rpc.reopen();
      // An abort while reopening closed the connection it replaced.
      signal.throwIfAborted();
      continue;
    }
    all.push(...next.data.map((entry) => entry.item));
    cursor = next.data.length ? next.nextCursor : null;
    if (!cursor) return [all, limit];
  }
}
const turns = async (
  rpc: AppServer,
  threadId: string,
  limit: number,
  signal: AbortSignal,
) => (await page(rpc, threadId, limit, signal))?.data ?? [];

/** Runs `use` with a short-lived app-server, closed when it ends or `signal`
 * aborts. */
export async function withServer<T>(
  spawn: Spawn,
  signal: AbortSignal,
  use: (rpc: AppServer) => Promise<T>,
) {
  const rpc = new AppServer();
  const abort = () => void rpc.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.open(spawn);
    signal.throwIfAborted();
    const result = await use(rpc);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}

/** Only complete records are cached. A live final line is read again on append. */
type RecordedWindow = { from: number; bytes: number; lines: Json[] };
type Rollout = {
  oldest: string;
  file: Awaited<ReturnType<typeof rolloutStat>>;
  content: "over-limit" | RecordedWindow;
};
const rollouts = new Map<string, Rollout>();
const TAIL_BYTES = 32 << 20;
const CACHE_RECORDS = 8192;
const encoder = new TextEncoder();

async function fileExit(
  child: Awaited<ReturnType<Spawn>>,
  signal: AbortSignal,
) {
  const stop = () => void child.kill();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(stop, 60_000);
  try {
    const code = await child.exited;
    signal.throwIfAborted();
    return code;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

async function rolloutStat(
  spawn: Spawn,
  cwd: string,
  path: string,
  signal: AbortSignal,
) {
  let output = "";
  const child = await spawn("rollout-stat", {
    cwd,
    args: [path],
    onStdout: (s) => {
      output += s;
    },
  });
  const code = await fileExit(child, signal);
  const match = /^(\d+) (\d+:\d+) (.+)$/.exec(output.trim());
  const size = Number(match?.[1]);
  if (code !== 0 || !match || !Number.isSafeInteger(size))
    throw new Error(`Could not read ${path}`);
  return { size, id: match[2], modified: match[3] };
}

/** The host delivers complete UTF-8 characters. Keep split records until
 * the next newline, including a partial last record that may grow on append. */
async function readWindow(
  spawn: Spawn,
  cwd: string,
  path: string,
  signal: AbortSignal,
  from: number,
  size: number,
  align: boolean,
  throughLine = false,
) {
  const lines: Json[] = [];
  const fragments: string[] = [];
  let bytes = from;
  let stderr = "";
  const child = await spawn("read-window", {
    cwd,
    args: [
      path,
      String(from + 1),
      String(size - from),
      ...(align ? ["align"] : []),
      ...(throughLine ? ["through-line"] : []),
    ],
    onStdout: (chunk) => {
      const end = chunk.lastIndexOf("\n");
      if (end < 0) {
        fragments.push(chunk);
        return;
      }
      fragments.push(chunk.slice(0, end + 1));
      const complete = fragments.join("");
      if (!throughLine) bytes += encoder.encode(complete).length;
      for (const record of recordedLines(complete)) lines.push(record);
      fragments.length = 0;
      fragments.push(chunk.slice(end + 1));
    },
    onStderr: (data) => {
      stderr += data;
    },
  });
  const code = await fileExit(child, signal);
  if (code !== 0) throw new Error(stderr.trim() || `Could not read ${path}`);
  const skipped = align && /^\d+$/.test(stderr.trim()) ? Number(stderr) : 0;
  const tail = fragments.join("");
  return {
    lines,
    bytes:
      !throughLine && (!align || skipped > 0) && from + skipped < size
        ? bytes + skipped
        : undefined,
    trailing: recordedLines(tail),
  };
}

/** A start in an earlier turn proves the window reaches past the shown
 * history. A completion from an earlier turn can outlive it. */
function firstTurn(lines: Json[], shown: Set<string>) {
  for (const record of lines) {
    const id = str((record.payload as Json)?.turn_id);
    if (shown.has(id)) return "shown";
    if (recordedTurnStart(record)) return "earlier";
  }
}

/** A context or even a repeated start of the oldest shown turn can occur in
 * mid-turn. Walk back to the preceding turn or EOF before accepting that cut.
 * Include the record straddling each cut in the preceding page. */
async function hasShownPrefix(
  spawn: Spawn,
  directory: string,
  path: string,
  signal: AbortSignal,
  end: number,
  shown: Set<string>,
) {
  while (end > 0) {
    const from = Math.max(0, end - (4 << 20));
    const read = await readWindow(
      spawn,
      directory,
      path,
      signal,
      Math.max(0, from - 1),
      end,
      from > 0,
      true,
    );
    const owner = firstTurn(read.lines.concat(read.trailing).reverse(), shown);
    if (owner) return owner === "shown";
    end = from;
  }
  return false;
}

function windowRange(from: number, end: number, append = false) {
  const align = !append && from > 0;
  return { from, start: align ? from - 1 : from, end, align };
}

export function planRollout(
  known: Rollout | undefined,
  oldest: string,
  file: Rollout["file"],
) {
  const { size } = file;
  let held: RecordedWindow | undefined;
  if (
    known?.oldest === oldest &&
    known.file.id === file.id &&
    (size > known.file.size ||
      (size === known.file.size && file.modified === known.file.modified))
  ) {
    if (known.content === "over-limit")
      return { kind: "held", content: known.content } as const;
    if (size - known.content.from <= READ_LIMIT) held = known.content;
  }
  if (held && size === held.bytes)
    return { kind: "held", content: held } as const;
  if (size === 0) return { kind: "empty" } as const;
  const from = held?.bytes ?? (size <= READ_LIMIT ? 0 : size - TAIL_BYTES);
  const range = windowRange(from, size, Boolean(held));
  return { kind: "read", range, held } as const;
}

type Prefix = {
  limit?: boolean;
  cut?: boolean;
  first?: "earlier" | "shown" | null;
};

/** Probe the maximum cut before the initial cut. Keep the first record classification across probes. */
export function afterWindow(
  range: ReturnType<typeof windowRange>,
  held: RecordedWindow | undefined,
  read: Awaited<ReturnType<typeof readWindow>>,
  shown: Set<string>,
  prefix: Prefix = {},
) {
  const { from, end: size } = range;
  const limitStart = size - READ_LIMIT;
  if (!held && from > 0 && from !== limitStart) {
    const first =
      prefix.first !== undefined
        ? prefix.first
        : (firstTurn(read.lines, shown) ??
          firstTurn(read.trailing, shown) ??
          null);
    if (first !== "earlier") {
      const probe = (at: "limit" | "cut", end: number) =>
        ({ kind: "probe", at, end, first }) as const;
      if (prefix.limit === undefined) return probe("limit", limitStart);
      if (prefix.limit) return { kind: "limit", cache: "over-limit" } as const;
      if (first && prefix.cut === undefined) return probe("cut", from);
      if (!first || prefix.cut)
        return { kind: "widen", range: windowRange(limitStart, size) } as const;
    }
  }
  const lines = held ? held.lines.concat(read.lines) : read.lines;
  const cache =
    read.bytes !== undefined && lines.length <= CACHE_RECORDS
      ? { from: held?.from ?? from, bytes: read.bytes, lines }
      : undefined;
  return { kind: "accept", lines: lines.concat(read.trailing), cache } as const;
}

async function rollout(
  spawn: Spawn,
  directory: string,
  path: string,
  signal: AbortSignal,
  turns: readonly TranscriptTurn[],
) {
  const oldest = turns[0]?.turnId;
  if (!oldest) return [];
  const source = [spawn, directory, path, signal] as const;
  const file = await rolloutStat(...source);
  const known = rollouts.get(path);
  const tooLarge = () =>
    new Error(`The turns shown take more than 50 MB of ${path}`);
  const plan = planRollout(known, oldest, file);
  if (plan.kind === "held") {
    rollouts.set(path, { oldest, file, content: plan.content });
    if (plan.content === "over-limit") throw tooLarge();
    return plan.content.lines;
  }
  rollouts.delete(path);
  if (plan.kind === "empty") return [];

  const remember = (content: Rollout["content"]) => {
    rollouts.set(path, { oldest, file, content });
    for (const old of rollouts.keys())
      if (rollouts.size > 2) rollouts.delete(old);
  };
  let range = plan.range;
  const readAt = ({ start, end, align }: typeof range) =>
    readWindow(...source, start, end, align);
  let read = await readAt(range);
  const shown = new Set(range.align ? turns.map((turn) => turn.turnId) : []);
  const prefix: Prefix = {};
  for (;;) {
    const step = afterWindow(range, plan.held, read, shown, prefix);
    switch (step.kind) {
      case "probe":
        prefix.first = step.first;
        prefix[step.at] = await hasShownPrefix(...source, step.end, shown);
        break;
      case "widen":
        range = step.range;
        read = await readAt(range);
        break;
      case "limit":
        remember(step.cache);
        throw tooLarge();
      case "accept":
        if (step.cache) remember(step.cache);
        return step.lines;
    }
  }
}

/** The latest turns of all the conversation's threads, oldest first, from a
 * short-lived app-server, or undefined when Codex has no history for it on
 * this device. */
export async function readTranscript(
  spawn: Spawn,
  lookup: Lookup,
  signal: AbortSignal,
  name?: Names,
  agentWorking = false,
): Promise<CodexTranscript | undefined> {
  return withServer(spawn, signal, async (rpc) => {
    // The saved thread is the conversation's; a found one by its name.
    const threads = new Map<string, boolean>(
      lookup.threadId ? [[lookup.threadId, false]] : [],
    );
    for (const thread of await findThreads(rpc, lookup))
      if (!threads.has(thread.id)) threads.set(thread.id, thread.legacy);
    const all: TranscriptTurn[] = [];
    let found = false;
    let more = false;
    let working = false;
    // A short-lived reader can report an unfinished turn as interrupted.
    let active = agentWorking;
    const paths: string[] = [];
    for (const [threadId, legacy] of threads) {
      const read = await page(rpc, threadId, TURN_LIMIT, signal);
      if (!read || (legacy && !startedFor(read.data, lookup))) continue;
      found = true;
      more ||= read.more;
      if (threadId === lookup.threadId)
        working = read.data[0]?.status === "inProgress";
      active ||= read.data[0]?.status === "inProgress";
      const mapped = codexTurns([...read.data].reverse(), lookup, name);
      for (const turn of mapped) turn.sessionId = threadId;
      // With no earlier turns, the first read starts the thread.
      if (mapped[0] && !read.more) mapped[0].newSession = true;
      try {
        const { thread } = await rpc.request<{
          thread?: { path: string | null };
        }>("thread/read", { threadId, includeTurns: false });
        if (!thread?.path)
          throw new Error("The local session file is unavailable.");
        paths.push(thread.path);
        // Codex supplies the rollout in Buzz's own home. Use its directory:
        // the desktop host rejects a relative process cwd, including ".".
        const directory = thread.path.slice(0, thread.path.lastIndexOf("/"));
        restoreRecordedTools(
          mapped,
          await rollout(spawn, directory, thread.path, signal, mapped),
        );
      } catch (error) {
        signal.throwIfAborted();
        const latest = mapped.at(-1);
        latest?.items.unshift({
          id: `${threadId}:recorded-tools-unavailable`,
          at: latest.startedAt,
          type: "status",
          text: `CodeMode scripts could not be loaded. Showing app-server history only. ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      all.push(...mapped);
    }
    // Once the turn ends, the next read starts at the tail.
    if (!active) for (const path of paths) rollouts.delete(path);
    if (!found) return undefined;
    all.sort((a, b) => a.startedAt - b.startedAt);
    return {
      turns: all.slice(-TURN_LIMIT),
      more: more || all.length > TURN_LIMIT,
      working,
    };
  });
}
