// The launch boundary: a mention goes through the real agents service, its
// runner and the start resolver into each real runtime, over a real relay
// session. The config the runtime actually uses comes from confirmed synced
// copies, the delivery carries their revision IDs, and the transport under
// the session sees no request at start beyond a turn's conversation reads,
// online or offline, and the runner's catch-up of the agent's mentions.
import { Context } from "@deepseek-ai/cordis";
import { finalizeEvent, matchFilter, type Filter } from "nostr-tools";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { eventsDto } from "../relay/events";
import { afterEach, expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../host/service";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, profile, roster } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import { artifactD, readHead } from "./agent-config-artifacts";
import type { Mode } from "./agent-start";
import { createLocalAgentActivity } from "./local-activity";
import type { AgentReads } from "./reads";
import {
  type AgentCommunities,
  AgentsService,
  type AgentType,
  type ConfigBinding,
  type Delivery,
} from "./service";
import { writeInterrupted } from "./interrupted";
import { fakeNative } from "./service-testing";
import { memoryStorage } from "./test-fakes";
import type { AgentStore } from "./store";
import { claudeRun } from "../../bundled/claude-code/run";
import { ClaudeRuntime } from "../../bundled/claude-code/runtime";
import { fakeSpawn as fakeClaude } from "../../bundled/claude-code/claude-testing";
import { codexRun } from "../../bundled/codex/run";
import { CodexRuntime } from "../../bundled/codex/runtime";
import type { Wire } from "../../bundled/codex/rpc";
import { gooseRun } from "../../bundled/goose/run";
import { GooseRuntime } from "../../bundled/goose/runtime";
import { fakeSpawn as fakeGoose } from "../../bundled/goose/goose-testing";

/** A Goose runtime with its own agent storage, as the app gives it. */
const gooseRuntime = (
  ...[host, relay, core]: ConstructorParameters<typeof GooseRuntime>
) =>
  new GooseRuntime(
    host,
    relay,
    core,
    undefined,
    undefined,
    undefined,
    memoryStorage(),
  );

const owner = keypair();
const relayKey = keypair();
const agentKey = keypair();
const artifactKey = keypair();
const origin = "https://relay.example.test";
const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const configChannel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const base = {
  owner: owner.pubkey,
  community: origin,
  subject: agentKey.pubkey,
  channel: configChannel,
};
const settingsSubject: Subject = { ...base, type: "buzz.agent.settings" };
const instructionsSubject: Subject = {
  ...base,
  type: "buzz.agent.instructions",
};

const revision = (body: object | null, op = "create") =>
  finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: body === null ? "" : JSON.stringify({ version: 1, ...body }),
      tags: [
        ["op", op],
        ["h", configChannel],
      ],
    },
    artifactKey.secret,
  ) as RelayEvent;

/** Confirmed copies in this device's storage, as a sync read installs them. */
function seed(storage: AgentStore, heads: [Subject, RelayEvent][]) {
  const store = new AgentConfigStore(storage);
  for (const [subject, head] of heads)
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: head,
    });
}

/** One request the transport saw: a read's filters, or an encrypted memory
 * listing (a request of its own, never a config read). */
type Request = {
  filters: readonly ReadFilter[];
  memory?: { agent: string; slug: string | undefined };
  failed: boolean;
  /** Whether every mention sent so far had finished when it was made. */
  afterRuns: boolean;
};

/** The one read a Codex turn makes of its conversation (§4.3): the mention
 * and its thread's replies, messages and their edits, in its channel, up to
 * the mention. */
const conversationRead = (sent: RelayEvent): readonly ReadFilter[] => {
  const window = { kinds: [40002, 9], "#h": [channel], until: sent.created_at };
  return [
    { ...window, ids: [sent.id], limit: 1 },
    { ...window, "#e": [sent.id], limit: 50 },
  ];
};

/** The relay's page of `records` for `filter`: newest first, ties by id,
 * below its cursor. */
const relayPage = (records: readonly RelayEvent[], filter: ReadFilter) =>
  records
    .filter(
      (event) =>
        matchFilter(filter as Filter, event) &&
        (!filter.before_id ||
          event.created_at < (filter.until ?? Infinity) ||
          event.id > filter.before_id),
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .slice(0, filter.limit);

/** A transport that answers from `records`, recording every request it sees.
 * While `offline`, every request fails as an unreachable relay's does. */
function countedTransport(records: RelayEvent[]) {
  const requests: Request[] = [];
  const state = {
    offline: false,
    failMentionCatchUp: false,
    failIdReads: false,
    afterRuns: () => false,
  };
  let live!: LiveCallbacks;
  const transport = {
    viewer: owner.pubkey,
    relayAuthor: relayKey.pubkey,
    scope: origin,
    media: () => undefined,
    async query(filters: readonly ReadFilter[]) {
      const request = {
        filters,
        failed: state.offline,
        afterRuns: state.afterRuns(),
      };
      requests.push(request);
      if (state.offline) throw new Error("Relay unreachable");
      if (state.failMentionCatchUp && filters[0]?.["#p"] && !filters[0]["#h"])
        throw new Error("Owner mention read refused");
      if (state.failIdReads && filters.some((filter) => filter.ids))
        throw new Error("Owner read refused");
      // A mention catch-up pages by time, as the relay does.
      if (filters.length === 1 && filters[0]?.["#p"])
        return relayPage(records, filters[0]);
      return records.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
    async readAgentMemories(agent: string, _: AbortSignal, slug?: string) {
      requests.push({
        filters: [],
        memory: { agent, slug },
        failed: state.offline,
        afterRuns: state.afterRuns(),
      });
      if (state.offline) throw new Error("Relay unreachable");
      return { entries: [], partial: false };
    },
    subscribe(callbacks: LiveCallbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  };
  return { transport, requests, state, live: () => live };
}

const disposals: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Listing the agent in its community is not under test here.
vi.mock("./relay-removal", async (actual) => ({
  ...(await actual<typeof import("./relay-removal")>()),
  publishAgentRecord: vi.fn(async () => {}),
}));

async function setup<Config>(
  typeId: string,
  runs: (
    relay: (pubkey: string) => RelayData | undefined,
    reads: (pubkey: string) => AgentReads | undefined,
    core: AgentsService["core"],
  ) => Pick<
    AgentType<Config>,
    "run" | "runOnce" | "timeoutMs" | "syncedSettings"
  >,
  defaults: Config,
  heads: [Subject, RelayEvent][],
  binding: ConfigBinding,
  initialMessages: RelayEvent[] = [],
  prepare?: (storage: AgentStore) => unknown,
) {
  const storage = memoryStorage();
  seed(storage, heads);
  await prepare?.(storage);
  const counted = countedTransport([
    metadata(relayKey, channel, "general", undefined, [["t", "stream"]]),
    roster(relayKey, channel, [owner.pubkey, agentKey.pubkey]),
    profile(owner, { name: "Owner" }),
    profile(agentKey, { name: typeId, is_agent: true }),
    ...heads.map(([, head]) => head),
    ...initialMessages,
  ]);
  const session = createRelaySession(counted.transport);
  disposals.push(() => session.dispose());
  const relayData = {
    snapshot: () => ({
      status: "ready",
      generation: 1,
      session: session.session,
      scope: `${origin}:${owner.pubkey}`,
      origin,
      viewer: owner.pubkey,
    }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  const communities = {
    snapshot: () => ({
      viewer: owner.pubkey,
      selected: origin,
      memberships: [{ id: origin, name: "Test" }],
    }),
    subscribe: () => () => {},
    open: () => relayData,
  } as unknown as AgentCommunities;
  const native = fakeNative([
    {
      pubkey: agentKey.pubkey,
      name: typeId,
      owner: owner.pubkey,
      relay: "wss://relay.example.test",
      type: `buzz/${typeId}`,
      deleted: false,
    },
  ]);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const activity = createLocalAgentActivity();
  /** Each start's binding lookup: one per start attempt. */
  const attempts = vi.fn(() => binding);
  const service = new AgentsService(
    ctx,
    communities,
    native,
    storage,
    undefined,
    activity,
    undefined,
    attempts,
  );
  disposals.push(() => ctx.fiber.dispose());
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "buzz", revision: "one" }),
  });
  const deliveries: Delivery<Config>[] = [];
  const real = runs(
    (pubkey) => service.relay(pubkey),
    (pubkey) => service.conversationReads(pubkey),
    (pubkey, signal) => service.core(pubkey, signal),
  );
  plugin.agents.register<Config>({
    id: typeId,
    title: typeId,
    defaults: () => ({ config: defaults }),
    ...real,
    run: (delivery) => {
      deliveries.push(delivery);
      return real.run?.(delivery);
    },
  });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  // Settle every cache a start may consult before counting begins.
  session.session.channels.ensureList();
  counted.live().state({ status: "connected", routes: [] });
  await vi.waitFor(() =>
    expect(service.snapshot().agents.map((agent) => agent.pubkey)).toContain(
      agentKey.pubkey,
    ),
  );
  // Discovery lists the channel only once it has applied its access change,
  // which would cancel reads still in flight.
  await vi.waitFor(() =>
    expect(session.session.channels.list()).toMatchObject({
      status: "ready",
      channels: [expect.objectContaining({ id: channel })],
    }),
  );
  await session.session.profiles.ensure([owner.pubkey, agentKey.pubkey]);
  await service.core(agentKey.pubkey);
  counted.requests.length = 0;
  let at = Math.floor(Date.now() / 1000);
  let mentions = 0;
  counted.state.afterRuns = () =>
    activity.reader
      .work()
      .filter((work) => !["waiting", "working"].includes(work.state)).length ===
    mentions;
  /** A new top-level mention from the owner: a new conversation. */
  const mention = (root?: string) => {
    mentions++;
    const sent = message(owner, channel, "@agent hello", ++at, [
      ["p", agentKey.pubkey],
      ...(root ? [["e", root, "", "reply"]] : []),
    ]);
    counted.live().receive([sent], { phase: "live", channelId: channel });
    return sent;
  };
  return {
    service,
    native,
    plugin,
    session: session.session,
    requests: counted.requests,
    transport: counted.state,
    deliveries,
    activity,
    attempts,
    mention,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** The runner's refresh of the agent's `core` memory once its work has
 * ended, for a later start that never waits on it (`runner.ts` `release`). */
const postRunCoreRefresh = (request: Request) =>
  request.afterRuns &&
  request.memory?.agent === agentKey.pubkey &&
  request.memory.slug === "core";

/** A Claude Code start's read of one of the agent's recent notes, by slug
 * (`recentNotesSection`). */
const recentNotesRead = (request: Request) =>
  request.memory?.agent === agentKey.pubkey &&
  /^mem\/notes\/\d{4}-\d{2}-\d{2}$/.test(request.memory.slug ?? "");

/** The runner's catch-up read of the agent's mentions, of every channel
 * (`runner.ts` `readMissed`): not a start's. A connect in the second after
 * the agent's mentions began to be caught up leaves that second to read. */
const mentionCatchUp = (request: Request) =>
  request.filters.length === 1 &&
  request.filters[0]?.["#p"]?.join() === agentKey.pubkey &&
  !request.filters[0]["#h"];

/** Apart from the post-run core refresh and mention catch-up, and with
 * `notes` a start's recent notes reads, the recorded requests are exactly one
 * conversation read for each of `conversations`, in order: an extra, a wider
 * or a different read fails. */
function expectOnlyAllowed(
  f: Fixture,
  conversations: readonly RelayEvent[] = [],
  notes = false,
) {
  expect(
    f.requests
      .filter(
        (request) =>
          !postRunCoreRefresh(request) &&
          !mentionCatchUp(request) &&
          !(notes && recentNotesRead(request)),
      )
      .map((request) => request.filters),
  ).toEqual(conversations.map(conversationRead));
}

const synced = (mode: Mode = "synced") => ({
  settings: { mode, subject: settingsSubject },
  instructions: { mode, subject: instructionsSubject },
});

/** Synced copies for `agentType`: these settings, and instructions. */
function heads(agentType: string, settings: Record<string, string>) {
  const s = revision({ agentType, settings });
  const i = revision({ text: "SYNCED INSTRUCTIONS" });
  return {
    revisions: [s.id, i.id],
    seeded: [
      [settingsSubject, s],
      [instructionsSubject, i],
    ] as [Subject, RelayEvent][],
  };
}

/** The same counter records a real config sync read once the relay is back. */
async function expectCounterSeesSync(f: Fixture) {
  f.transport.offline = false;
  f.requests.length = 0;
  const read = f.session.snapshotRead;
  if (!read) throw new Error("snapshotRead unavailable");
  await readHead(
    read,
    configChannel,
    await artifactD("buzz.agent.settings", configChannel),
  );
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.filters[0]).toMatchObject({
    kinds: [45010],
    "#h": [configChannel],
  });
}

it("starts Claude sessions from the synced copies, with no relay request but recent notes online or offline", async () => {
  const claude = fakeClaude();
  const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
  const { revisions, seeded } = heads("buzz/claude-code", {
    model: "synced-model",
    scope: "thread",
  });
  const f = await setup(
    "claude-code",
    (_relay, reads, core) =>
      claudeRun(new ClaudeRuntime(host, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const prompted = (index: number) =>
    vi.waitFor(() =>
      expect(JSON.stringify(claude.processes[index]?.received)).toContain(
        "SYNCED INSTRUCTIONS",
      ),
    );
  f.mention();
  await prompted(0);
  const [first] = claude.processes;
  expect(first?.model).toBe("synced-model");
  expect(first?.options.cwd).toBe("/this/device");
  expect(JSON.stringify(first?.received)).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f, [], true);

  // The relay goes away; the next conversation starts from the same copies.
  f.transport.offline = true;
  f.mention();
  await prompted(1);
  expect(claude.processes[1]?.model).toBe("synced-model");
  expect(JSON.stringify(claude.processes[1]?.received)).not.toContain(
    "LOCAL INSTRUCTIONS",
  );
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f, [], true);
  await expectCounterSeesSync(f);
});

/** A Codex app server that answers what a thread and a turn need. */
function fakeCodex() {
  const sent: Wire[] = [];
  let options: HostProcessOptions | undefined;
  const emit = (value: Wire) =>
    options?.onStdout?.(`${JSON.stringify(value)}\n`);
  const process = {
    write: async (data: string) => {
      const request: Wire = JSON.parse(data);
      sent.push(request);
      if (request.id == null || !request.method) return;
      const params = request.params as Record<string, unknown>;
      const result =
        request.method === "thread/start"
          ? { thread: { id: `thread-${sent.length}`, cwd: params.cwd } }
          : request.method === "turn/start"
            ? { turn: { id: `turn-${sent.length}` } }
            : request.method === "model/list"
              ? {
                  data: ["local-model", "synced-model"].map((model) => ({
                    model,
                    displayName: model,
                    isDefault: model === "local-model",
                    defaultReasoningEffort: "low",
                    supportedReasoningEfforts: ["low", "high"].map(
                      (reasoningEffort) => ({
                        reasoningEffort,
                        description: "",
                      }),
                    ),
                  })),
                  nextCursor: null,
                }
              : request.method === "config/read"
                ? { config: {} }
                : {};
      emit({ id: request.id, result });
      // Each turn finishes at once, so the next conversation can start.
      if (request.method === "turn/start")
        emit({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { ...(result as { turn: object }).turn, status: "completed" },
          },
        });
    },
    end: async () => {},
    kill: async () => {},
    exited: new Promise<number | null>(() => {}),
  };
  const spawn = async (id: string, value?: HostProcessOptions) => {
    if (id === "workspace") {
      value?.onStdout?.(`${value.cwd ?? ""}\n`);
      return { ...process, exited: Promise.resolve(0) };
    }
    options = value;
    return process;
  };
  return { spawn, sent };
}

it("starts a Codex thread and a turn from the synced copies; offline, only its conversation reads fail", async () => {
  const codex = fakeCodex();
  const { revisions, seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "high",
    scope: "thread",
  });
  const f = await setup(
    "codex",
    (_relay, reads, core) =>
      codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "low",
      instructions: "LOCAL INSTRUCTIONS",
      workspace: "/this/device",
      scope: "thread",
    },
    seeded,
    synced(),
  );
  const starts = (method: string) =>
    codex.sent.filter((wire) => wire.method === method);
  const outcome = (id: string) =>
    f.activity.reader.work().find((work) => work.messageId === id);
  f.plugin.agents.registerSessionRouter({
    id: "tasks",
    ready: async () => {},
    matches: () => true,
    prepare: async (input) => ({
      association: { task: input.source.root ?? "channel" },
    }),
  });
  const first = f.mention();
  await vi.waitFor(() => expect(outcome(first.id)?.state).toBe("done"));
  expect(outcome(first.id)?.session).toMatchObject({
    router: "buzz/tasks",
    association: { task: first.id },
  });
  const [thread] = starts("thread/start");
  expect(thread?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  const sentToCodex = JSON.stringify(codex.sent);
  expect(sentToCodex).toContain("SYNCED INSTRUCTIONS");
  expect(sentToCodex).not.toContain("LOCAL INSTRUCTIONS");
  expect(starts("turn/start")).toHaveLength(1);
  expect(starts("turn/start")[0]?.params).toMatchObject({ effort: "high" });
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f, [first]);

  // Offline until the second mention ends: the thread still opens from the
  // copies, and the turn fails on its conversation reads alone (§4.3).
  f.transport.offline = true;
  f.requests.length = 0;
  const second = f.mention();
  await vi.waitFor(() => expect(outcome(second.id)?.state).toBe("error"));
  expect(outcome(second.id)?.error).toBe("Relay unreachable");
  expect(starts("thread/start")).toHaveLength(2);
  expect(starts("thread/start")[1]?.params).toMatchObject({
    model: "synced-model",
    cwd: "/this/device",
  });
  expect(starts("turn/start")).toHaveLength(1);
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  // Until the run ended, the turn's conversation read was all it asked, and
  // it failed.
  expectOnlyAllowed(f, [second]);
  expect(
    f.requests.filter((request) => !postRunCoreRefresh(request)),
  ).toMatchObject([{ failed: true }]);
  await expectCounterSeesSync(f);
});

const GOOSE_LOCAL = {
  model: "local-model",
  provider: "local-provider",
  effort: "",
  instructions: "LOCAL INSTRUCTIONS",
  workspace: "/this/device",
  scope: "thread" as const,
};

function gooseHost() {
  const goose = fakeGoose({
    providers: [
      { providerId: "synced-provider", models: [{ modelId: "synced-model" }] },
    ],
    supported: ["synced-model"],
  });
  const host = {
    spawn: goose.spawn,
    resolveDirectory: goose.resolveDirectory,
    readFile: vi.fn(),
    serveMcp: goose.serve,
  } as unknown as Host;
  return { goose, host };
}

it("starts Goose sessions from the synced copies, with no relay request online or offline", async () => {
  const { goose, host } = gooseHost();
  const { revisions, seeded } = heads("buzz/goose", {
    model: "synced-model",
    provider: "synced-provider",
    scope: "thread",
  });
  const f = await setup(
    "goose",
    (relay, _reads, core) => gooseRun(gooseRuntime(host, relay, core)),
    { ...GOOSE_LOCAL },
    seeded,
    synced(),
  );
  f.mention();
  const process = () => goose.geese[0];
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(1));
  const used = () => JSON.stringify([process()?.opened, process()?.configured]);
  expect(used()).toContain("synced-model");
  expect(used()).toContain("synced-provider");
  expect(used()).not.toContain("local-model");
  expect(process()?.opened[0]).toMatchObject({ cwd: "/this/device" });
  const prompts = () =>
    JSON.stringify([...(process()?.prompts.values() ?? [])]);
  expect(prompts()).toContain("SYNCED INSTRUCTIONS");
  expect(prompts()).not.toContain("LOCAL INSTRUCTIONS");
  expect(f.deliveries[0]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f);

  f.transport.offline = true;
  f.mention();
  await vi.waitFor(() => expect(process()?.turns).toHaveLength(2));
  expect(process()?.opened).toHaveLength(2);
  expect(f.deliveries[1]?.revisions).toEqual(revisions);
  expectOnlyAllowed(f);
  await expectCounterSeesSync(f);
});

it("refuses to start from deleted synced settings once: no launch, the reason on the mention, no retry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { goose, host } = gooseHost();
  const deleted = revision(null, "delete");
  const { seeded } = heads("buzz/goose", { model: "synced-model" });
  const f = await setup(
    "goose",
    (relay, _reads, core) => gooseRun(gooseRuntime(host, relay, core)),
    { ...GOOSE_LOCAL },
    [[settingsSubject, deleted], seeded[1] as [Subject, RelayEvent]],
    synced(),
  );
  f.attempts.mockClear();
  const sent = f.mention();
  const work = () =>
    f.activity.reader.work().filter((item) => item.messageId === sent.id);
  await vi.waitFor(() => expect(work()[0]?.state).toBe("error"));
  expect(work()).toEqual([
    expect.objectContaining({
      state: "error",
      error: "Settings were deleted — restore from History",
    }),
  ]);
  // Past the service's next tick, which runs whatever is still queued.
  await vi.advanceTimersByTimeAsync(6_000);
  expect(f.attempts).toHaveBeenCalledTimes(1);
  expect(work()).toHaveLength(1);
  expect(f.deliveries).toEqual([]);
  expect(goose.geese).toEqual([]);
  expectOnlyAllowed(f);
});

it.each([
  {
    name: "Claude",
    start: async (effort: string) => {
      const claude = fakeClaude();
      const host = { spawn: claude.spawn, request: vi.fn() } as unknown as Host;
      const { seeded } = heads("buzz/claude-code", {
        model: "haiku",
        effort,
        scope: "thread",
      });
      const f = await setup(
        "claude-code",
        (_relay, reads, core) =>
          claudeRun(new ClaudeRuntime(host, reads, core, memoryStorage())),
        { ...GOOSE_LOCAL, model: "haiku", effort: "low" },
        seeded,
        synced(),
      );
      return {
        f,
        prompted: () =>
          claude.processes.reduce((sum, item) => sum + item.prompts.length, 0),
      };
    },
  },
  {
    name: "Codex",
    start: async (effort: string) => {
      const codex = fakeCodex();
      const { seeded } = heads("buzz/codex", {
        model: "synced-model",
        effort,
        scope: "thread",
      });
      const f = await setup(
        "codex",
        (_relay, reads, core) =>
          codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
        { ...GOOSE_LOCAL, model: "local-model", effort: "low" },
        seeded,
        synced(),
      );
      return {
        f,
        prompted: () =>
          codex.sent.filter((wire) => wire.method === "turn/start").length,
      };
    },
  },
  {
    name: "goose",
    start: async (effort: string) => {
      const { goose, host } = gooseHost();
      const { seeded } = heads("buzz/goose", {
        model: "synced-model",
        provider: "synced-provider",
        effort,
        scope: "thread",
      });
      const f = await setup(
        "goose",
        (relay, _reads, core) => gooseRun(gooseRuntime(host, relay, core)),
        { ...GOOSE_LOCAL },
        seeded,
        synced(),
      );
      return {
        f,
        prompted: () =>
          goose.geese.reduce((sum, item) => sum + item.turns.length, 0),
      };
    },
  },
])(
  "refuses $name a synced effort its model lacks, with the reason on the mention",
  async ({ start }) => {
    const { f, prompted } = await start("max");
    const sent = f.mention();
    const work = () =>
      f.activity.reader.work().find((item) => item.messageId === sent.id);
    await vi.waitFor(() => expect(work()?.state).toBe("error"));
    expect(work()?.error).toContain('synced effort "max"');
    expect(f.deliveries[0]?.synced).toMatchObject({ effort: "max" });
    expect(prompted()).toBe(0);
  },
);

it("keeps an addressed Attention wake when a session association declines", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const codex = fakeCodex();
  const root = message(owner, channel, "Task root", 999);
  const { seeded } = heads("buzz/codex", {
    model: "synced-model",
    effort: "high",
    scope: "channel",
  });
  const f = await setup(
    "codex",
    (_relay, reads, core) =>
      codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
    {
      model: "local-model",
      effort: "low",
      instructions: "",
      workspace: "/this/device",
      scope: "channel",
    },
    seeded,
    synced(),
    [root],
  );
  f.native.query.mockResolvedValue([root]);
  f.plugin.agents.controlAttention();
  const prepare = vi.fn(async () => undefined);
  f.plugin.agents.registerSessionRouter({
    id: "decline",
    ready: async () => {},
    matches: () => true,
    prepare,
  });
  await f.service.save(agentKey.pubkey, {
    attentionEnabled: true,
    attention: {
      "interest/task": { type: "interest", instructions: "Check the task" },
      "watch/tick": {
        type: "timer",
        interest_id: "task",
        prompt: "Check",
        enabled: true,
        interval_secs: 60,
        armed_at: 1_000,
        max_occurrences: 1,
        expires_at: null,
        channel,
        root: root.id,
      },
    },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() =>
    expect(
      codex.sent.filter((wire) => wire.method === "turn/start"),
    ).toHaveLength(1),
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(f.deliveries.map((delivery) => delivery.trigger.type)).toEqual([
    "attention",
  ]);
});

it.each(["thread", "channel"] as const)(
  "resets the association with the native %s session",
  async (scope) => {
    const codex = fakeCodex();
    const { seeded } = heads("buzz/codex", {
      model: "synced-model",
      effort: "high",
      scope,
    });
    const f = await setup(
      "codex",
      (_relay, reads, core) =>
        codexRun(new CodexRuntime(codex.spawn, reads, core, memoryStorage())),
      {
        model: "local-model",
        effort: "low",
        instructions: "",
        workspace: "/this/device",
        scope,
      },
      seeded,
      synced(),
    );
    f.plugin.agents.registerSessionRouter({
      id: "tasks",
      ready: async () => {},
      matches: () => true,
      prepare: async (input) => ({
        association: input.association ?? { task: input.sessionKey },
      }),
    });
    const first = f.mention();
    const work = () =>
      f.activity.reader.work().find((row) => row.messageId === first.id);
    await vi.waitFor(() => expect(work()?.state).toBe("done"));
    const prior = work()?.session?.sessionKey;
    const agent = f.service.find(agentKey.pubkey);
    if (!agent) throw new Error("Expected the local agent");
    const place = { channelId: channel, root: first.id };
    await vi.waitFor(() =>
      expect(f.service.sessionState(agent.key, place)).toBe("idle"),
    );
    await f.service.session(agent.key, place, "new");
    const next = f.mention(first.id);
    await vi.waitFor(() =>
      expect(
        f.activity.reader.work().find((row) => row.messageId === next.id)
          ?.state,
      ).toBe("done"),
    );
    const current = f.activity.reader
      .work()
      .find((row) => row.messageId === next.id)?.session?.sessionKey;
    expect(current).toBeTruthy();
    expect(current).not.toBe(prior);
    expect(
      codex.sent.filter((wire) => wire.method === "thread/start"),
    ).toHaveLength(2);
  },
);

const privateChannel = "4b7939a2-f852-42ae-ab59-2d1588b0d337";

/** An agent-only DM between a sibling and the agent, which the owner cannot
 * read, answered by the agent's native query alone. */
async function agentOnlyDm({
  owned = true,
  member = true,
  workflow = false,
  at = Math.floor(Date.now() / 1000) + 1,
} = {}) {
  const sibling = keypair();
  const conditions = "kind=9";
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `nostr:agent-auth:${sibling.pubkey}:${conditions}`,
      ),
    ),
  );
  const auth = [
    "auth",
    owner.pubkey,
    conditions,
    bytesToHex(schnorr.sign(digest, owner.secret)),
  ];
  const earlier = message(
    sibling,
    privateChannel,
    "Prior private context",
    at - 1,
  );
  const sent = message(sibling, privateChannel, "Private assignment", at, [
    ["p", agentKey.pubkey],
    ...(owned ? [auth] : []),
    ...(workflow ? [["buzz:workflow", "true"]] : []),
  ]);
  const records = eventsDto([
    metadata(relayKey, privateChannel, "Agent DM", at - 2, [
      ["t", "dm"],
      ["private"],
      ["hidden"],
    ]),
    roster(
      relayKey,
      privateChannel,
      member ? [sibling.pubkey, agentKey.pubkey] : [sibling.pubkey],
      at - 2,
    ),
    earlier,
    sent,
  ]);
  let withheld: readonly number[] = [];
  const query = async (_member: unknown, filters: readonly object[]) =>
    (filters as readonly ReadFilter[]).flatMap((filter) =>
      relayPage(
        records.filter((event) => !withheld.includes(event.kind)),
        filter,
      ),
    );
  return {
    sent,
    query,
    withhold: (...kinds: number[]) => {
      withheld = kinds;
    },
  };
}

async function gooseSetup(
  prepare?: (storage: AgentStore) => unknown,
  initialMessages: RelayEvent[] = [],
) {
  const { goose, host } = gooseHost();
  const { seeded } = heads("buzz/goose", {
    model: "synced-model",
    provider: "synced-provider",
    scope: "thread",
  });
  let runtime!: GooseRuntime;
  const f = await setup(
    "goose",
    (relay, reads, core) => {
      runtime = new GooseRuntime(
        host,
        relay,
        core,
        memoryStorage(),
        undefined,
        undefined,
        memoryStorage(),
        undefined,
        undefined,
        undefined,
        reads,
      );
      return gooseRun(runtime);
    },
    { ...GOOSE_LOCAL },
    seeded,
    synced(),
    initialMessages,
    prepare,
  );
  return { ...f, goose, runtime };
}

const privateRead = (f: Fixture) =>
  f.requests.some((request) =>
    request.filters.some((filter) => filter["#h"]?.includes(privateChannel)),
  );

it.each(["authorized", "unauthorized", "removed", "workflow"])(
  "delivers an agent-only DM through native catch-up with sender authority preserved (%s)",
  async (authority) => {
    const owned = authority !== "unauthorized";
    const member = authority !== "removed";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = await gooseSetup();
    const dm = await agentOnlyDm({
      owned,
      member,
      workflow: authority === "workflow",
    });
    f.native.query.mockImplementation(dm.query);
    expect(f.session.channels.get?.(privateChannel)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.deliveries).toHaveLength(member ? 1 : 0);
    if (owned && member) {
      await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(1));
      const text = f.goose.geese[0]?.turns[0]?.text;
      expect(text).toContain("Scope: dm");
      expect(text).toContain("Private assignment");
      expect(text).toContain("Prior private context");
      expect(text).toContain("Session scope: dm conversation");
    } else {
      expect(f.goose.geese).toHaveLength(0);
    }
    expect(f.session.channels.get?.(privateChannel)).toBeUndefined();
    expect(f.native.query).toHaveBeenCalledWith(
      expect.objectContaining({
        pubkey: agentKey.pubkey,
        relay: "wss://relay.example.test",
      }),
      expect.any(Array),
    );
    expect(privateRead(f)).toBe(false);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.deliveries).toHaveLength(member ? 1 : 0);
  },
);

it("resumes an interrupted agent-only DM turn by reading it as the agent", async () => {
  const dm = await agentOnlyDm({ at: Math.floor(Date.now() / 1000) - 3_600 });
  const f = await gooseSetup((storage) =>
    writeInterrupted(storage, agentKey.pubkey, {
      [dm.sent.id]: privateChannel,
    }),
  );
  f.native.query.mockImplementation(dm.query);
  await vi.waitFor(() =>
    expect(
      f.service.snapshot().interrupted.map((agent) => agent.pubkey),
    ).toEqual([agentKey.pubkey]),
  );
  expect(f.deliveries).toHaveLength(0);
  f.service.resumeInterrupted();
  await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(1));
  expect(f.deliveries).toHaveLength(1);
  expect(f.deliveries[0]?.trigger).toMatchObject({
    type: "mention",
    resumed: true,
    event: { id: dm.sent.id },
  });
  expect(f.goose.geese[0]?.turns[0]?.text).toContain("Private assignment");
  expect(f.session.channels.get?.(privateChannel)).toBeUndefined();
  expect(privateRead(f)).toBe(false);
});

it("keeps an interrupted private turn for retry when the agent's read fails", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const dm = await agentOnlyDm({ at: Math.floor(Date.now() / 1000) - 3_600 });
  const f = await gooseSetup((storage) =>
    writeInterrupted(storage, agentKey.pubkey, {
      [dm.sent.id]: privateChannel,
    }),
  );
  f.native.query.mockRejectedValue(new Error("Agent read refused"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await vi.waitFor(() =>
    expect(
      f.service.snapshot().interrupted.map((agent) => agent.pubkey),
    ).toEqual([agentKey.pubkey]),
  );
  f.service.resumeInterrupted();
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not resume its private turns"),
      expect.any(Error),
    ),
  );
  expect(f.deliveries).toHaveLength(0);
  const failures = f.native.query.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20_000);
  // Backed off, not read again on every service tick.
  expect(f.native.query.mock.calls.length - failures).toBeLessThanOrEqual(2);
  f.native.query.mockImplementation(dm.query);
  await vi.advanceTimersByTimeAsync(300_000);
  await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(1));
  expect(f.deliveries[0]?.trigger).toMatchObject({
    type: "mention",
    resumed: true,
    event: { id: dm.sent.id },
  });
});

it("backs off Resume while the owner's read fails and the agent's finds nothing", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const dm = await agentOnlyDm({ at: Math.floor(Date.now() / 1000) - 3_600 });
  const f = await gooseSetup((storage) =>
    writeInterrupted(storage, agentKey.pubkey, {
      [dm.sent.id]: privateChannel,
    }),
  );
  f.transport.failIdReads = true;
  f.native.query.mockResolvedValue([]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const ownerReads = () =>
    f.requests.filter((request) =>
      request.filters.some((filter) => filter.ids?.includes(dm.sent.id)),
    ).length;
  await vi.waitFor(() =>
    expect(
      f.service.snapshot().interrupted.map((agent) => agent.pubkey),
    ).toEqual([agentKey.pubkey]),
  );
  f.service.resumeInterrupted();
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not resume its turns"),
      expect.any(Error),
    ),
  );
  const failures = ownerReads();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(ownerReads() - failures).toBeLessThanOrEqual(2);
  expect(f.deliveries).toHaveLength(0);
  f.native.query.mockImplementation(dm.query);
  await vi.advanceTimersByTimeAsync(300_000);
  await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(1));
  expect(f.deliveries[0]?.trigger).toMatchObject({
    type: "mention",
    resumed: true,
    event: { id: dm.sent.id },
  });
});

it("keeps an agent-only DM out of the owner's saved conversations and labels", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const f = await gooseSetup();
  const dm = await agentOnlyDm();
  f.native.query.mockImplementation(dm.query);
  f.mention();
  await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(50_000);
  await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(2));
  const key = f.service.find(agentKey.pubkey)?.key ?? "";
  const rows = f.runtime.conversations(key).map(({ key: saved }) => ({
    key: saved,
    ...f.runtime.source(key, saved),
  }));
  expect(rows.map((row) => row.channelId).sort()).toEqual(
    [channel, privateChannel].sort(),
  );
  expect(f.runtime.readableRows(key, rows).map((row) => row.channelId)).toEqual(
    [channel],
  );
  expect(f.runtime.channelLabel(key, privateChannel)).toBeUndefined();
  expect(f.runtime.channelLabel(key, channel)).toMatchObject({
    name: "general",
  });
});

it.each([
  { withheld: [39002], what: "its roster" },
  { withheld: [39000, 39002], what: "all its details" },
])(
  "keeps a DM mention pending while the relay withholds $what",
  async ({ withheld }) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = await gooseSetup();
    const dm = await agentOnlyDm();
    dm.withhold(...withheld);
    f.native.query.mockImplementation(dm.query);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.deliveries).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not catch up its private mentions"),
      expect.any(Error),
    );
    dm.withhold();
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(1));
    expect(f.deliveries).toHaveLength(1);
  },
);

it("keeps the owner's mention catch-up going while the agent's own reads fail", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const f = await gooseSetup();
  f.native.query.mockRejectedValue(new Error("Agent read refused"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const ownerReads = () => f.requests.filter(mentionCatchUp).length;
  await vi.advanceTimersByTimeAsync(50_000);
  const first = ownerReads();
  expect(first).toBeGreaterThan(0);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("could not catch up its private mentions"),
    expect.any(Error),
  );
  await vi.advanceTimersByTimeAsync(100_000);
  expect(ownerReads()).toBeGreaterThan(first);
});

it("still catches up agent-only DMs while the owner's mention reads fail", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const f = await gooseSetup();
  const dm = await agentOnlyDm();
  f.native.query.mockImplementation(dm.query);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  f.transport.failMentionCatchUp = true;
  await vi.advanceTimersByTimeAsync(50_000);
  await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(1));
});

it("finishes a private catch-up window whose last page outlasts a tick", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const f = await gooseSetup();
  const dm = await agentOnlyDm();
  f.native.query.mockImplementation(async (member, filters) => {
    const events = await dm.query(member, filters);
    const page = (filters as readonly ReadFilter[])[0];
    if (page?.["#p"] && !events.length)
      await new Promise((resolve) => setTimeout(resolve, 7_000));
    return events;
  });
  await vi.advanceTimersByTimeAsync(80_000);
  await vi.waitFor(() => expect(f.goose.geese[0]?.turns).toHaveLength(1));
  expect(f.deliveries).toHaveLength(1);
});
