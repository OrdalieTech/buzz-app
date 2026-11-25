import { expect, it, vi } from "vitest";
import { AGENT_KEY } from "../../features/agents/membership";
import hostSource from "./host.mjs?raw";
import manifest from "./manifest.json";
import type { AgentProtection } from "../../features/agent-protection/service";
import { Pi, PiStopped } from "./pi";
import { deferred, fakeHost, type FakeProcess } from "./pi-testing";

const env = vi.hoisted(() => ({
  own: new Map<string, boolean | undefined>(),
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("../agents/agent-env", () => ({
  hasOwnEnv: async (agent: string) => {
    await env.gate;
    return env.own.has(agent) ? env.own.get(agent) : false;
  },
}));

const handlers = () => ({ tool: vi.fn(), event: vi.fn() });
const evidence = (worker: FakeProcess, operation: string, params: object) =>
  worker.tool(params, `buzz/security/evidence/${operation}`);
/** Sends one action over the evidence protocol, as host.mjs does. */
async function review(worker: FakeProcess, action: Record<string, unknown>) {
  const { content, ...metadata } = action;
  const id = crypto.randomUUID();
  const data = Buffer.from(JSON.stringify(content));
  await evidence(worker, "begin", { id, ...metadata });
  await evidence(worker, "chunk", {
    id,
    sequence: 0,
    data: data.toString("base64"),
  });
  return evidence(worker, "finish", { id, sequence: 1, bytes: data.length });
}

it("declares file reads through the bundled helper with a positional path", () => {
  expect(
    manifest.host.processes.find((process) => process.id === "read-protected"),
  ).toEqual({
    id: "read-protected",
    program: "buzz-agent-command",
    bundled: true,
    args: [
      "--shell",
      `case "$1" in "~/"*) set -- "$HOME/\${1:2}";; esac; exec /usr/bin/base64 -i "$1"`,
      "buzz-read",
    ],
  });
});

it("starts the host once, with the install script, and pairs each answer with its request", async () => {
  const slow = deferred<object>();
  const host = fakeHost({
    first: () => slow.promise,
    second: (params) => ({ echo: params.value }),
  });
  const pi = new Pi(() => host.spawn, handlers());
  const first = pi.request("first");
  const second = pi.request("second", { value: 2 });
  await expect(second).resolves.toEqual({ echo: 2 });
  slow.resolve({ done: 1 });
  await expect(first).resolves.toEqual({ done: 1 });
  expect(host.processes).toHaveLength(1);
  const [process] = host.processes;
  expect(process?.id).toBe("pi-sh");
  expect(process?.options.secrets).toEqual(["agent-env"]);
  expect(process?.options.cwd).toBe("~");
  expect(process?.options.args?.[1]).toBe("pi.sh");
  expect(process?.options.args?.at(-1)).toContain("BUZZ_PI_HOST");
  // The packages it installs are the ones the lock pins.
  expect(process?.launched?.lock).toContain('"lockfileVersion"');
  expect(process?.launched?.host).toContain("export function serve");
});

it("starts Node itself on Windows, which has no bash", async () => {
  vi.stubGlobal("navigator", { platform: "Win32" });
  try {
    const host = fakeHost({ first: () => ({ ok: true }) });
    const pi = new Pi(() => host.spawn, handlers());
    await expect(pi.request("first")).resolves.toEqual({ ok: true });
    const [process] = host.processes;
    expect(process?.id).toBe("node");
    expect(process?.options.args).toHaveLength(1);
    expect(process?.options.args?.[0]).toContain("BUZZ_PI_HOST");
    expect(process?.launched?.lock).toContain('"lockfileVersion"');
  } finally {
    vi.unstubAllGlobals();
  }
});

it("reads messages split across chunks, and several in one", async () => {
  // Its answer comes from the test, in pieces.
  const host = fakeHost(
    { first: () => new Promise(() => {}) },
    { ready: false },
  );
  const events = handlers();
  const pi = new Pi(() => host.spawn, events);
  const started = pi.request("first");
  await vi.waitFor(() => expect(host.processes).toHaveLength(1));
  const stdout = host.processes[0]?.options.onStdout;
  stdout?.('{"method":"rea');
  stdout?.(
    'dy","params":{}}\n{"method":"event","params":{"agent":"a","conversation":1,"type":"step","tool":"bash"}}\n',
  );
  await vi.waitFor(() => expect(host.requests("first")).toHaveLength(1));
  stdout?.('{"id":1,"result":{"ok":true}}');
  stdout?.("\n");
  await expect(started).resolves.toEqual({ ok: true });
  expect(events.event).toHaveBeenCalledWith({
    agent: "a",
    conversation: 1,
    type: "step",
    tool: "bash",
  });
});

it("says why a host could not start, and starts another for the next request", async () => {
  const host = fakeHost({ ping: () => ({ pong: true }) }, { ready: false });
  const pi = new Pi(() => host.spawn, handlers());
  const failed = pi.request("ping");
  await vi.waitFor(() => expect(host.processes).toHaveLength(1));
  host.processes[0]?.exit(
    127,
    "Installing…\nPi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.\n",
  );
  const error = await failed.catch((reason: unknown) => reason);
  expect(error).not.toBeInstanceOf(PiStopped);
  expect((error as Error).message).toBe(
    "Pi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.",
  );
  const retried = pi.request("ping");
  await vi.waitFor(() => expect(host.processes).toHaveLength(2));
  host.processes[1]?.send({ method: "ready", params: {} });
  await expect(retried).resolves.toEqual({ pong: true });
});

it("fails what a running host had not answered when it stops", async () => {
  const host = fakeHost({ wait: () => new Promise(() => {}) });
  const pi = new Pi(() => host.spawn, handlers());
  const waiting = pi.request("wait");
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  host.processes[0]?.exit(1, "FATAL: out of memory\n");
  const error = await waiting.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PiStopped);
  expect((error as Error).message).toBe("Pi stopped: FATAL: out of memory");
});

it("names Node's error, not its version, when a host crashes", async () => {
  const host = fakeHost({ wait: () => new Promise(() => {}) });
  const pi = new Pi(() => host.spawn, handlers());
  const waiting = pi.request("wait");
  await vi.waitFor(() => expect(host.requests("wait")).toHaveLength(1));
  host.processes[0]?.exit(
    1,
    "file:///host.mjs:9\n  throw new Error(x);\n  ^\n\nTypeError: x is not a function\n    at file:///host.mjs:9:3\n\nNode.js v22.19.0\n",
  );
  const error = await waiting.catch((reason: unknown) => reason);
  expect((error as Error).message).toBe(
    "Pi stopped: TypeError: x is not a function",
  );
});

it("runs the tools the host calls, and sends back each result or error", async () => {
  const host = fakeHost();
  const tool = vi
    .fn()
    .mockResolvedValueOnce({ content: [{ type: "text", text: "sent" }] })
    .mockRejectedValueOnce(new Error("No such channel"));
  const pi = new Pi(() => host.spawn, { tool, event: vi.fn() });
  await pi.request("open");
  const process = host.processes[0];
  const call = {
    agent: "a",
    conversation: 3,
    context: { channel: "c" },
    name: "send",
    arguments: { text: "hi" },
  };
  await expect(process?.tool(call)).resolves.toMatchObject({
    result: { content: [{ type: "text", text: "sent" }] },
  });
  expect(tool).toHaveBeenCalledWith(call, expect.any(AbortSignal));
  await expect(process?.tool(call)).resolves.toMatchObject({
    error: "No such channel",
  });
});

it("cancels a Buzz tool when its run stops or the host goes", async () => {
  const host = fakeHost();
  const signals: AbortSignal[] = [];
  const tool = vi.fn(
    (_call: unknown, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const pi = new Pi(() => host.spawn, { tool, event: vi.fn() });
  await pi.request("open");
  const process = host.processes[0];
  const call = {
    agent: "a",
    conversation: 3,
    context: {},
    name: "send",
    arguments: { text: "hi" },
  };
  const stopped = process?.tool(call);
  void process?.tool(call);
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  process?.send({ method: "security_cancel", params: { id: "h1" } });
  await expect(stopped).resolves.toHaveProperty("error");
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  process?.exit(1);
  await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
});

it("cancels a gateway check when the host cancels that request", async () => {
  const host = fakeHost();
  const signals: AbortSignal[] = [];
  const gateway = vi.fn(
    (_call: unknown, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const pi = new Pi(() => host.spawn, {
    tool: vi.fn(),
    event: vi.fn(),
    gateway,
  });
  await pi.request("open");
  const process = host.processes[0];
  const call = { op: "admit", agent: "a", binding: {} };
  const stopped = process?.tool(call, "gateway");
  void process?.tool(call, "gateway");
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  process?.send({ method: "security_cancel", params: { id: "h1" } });
  await expect(stopped).resolves.toHaveProperty("error");
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  process?.exit(1);
  await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
});

it("closes the host's stdin to stop it, and refuses requests after", async () => {
  const host = fakeHost();
  const pi = new Pi(() => host.spawn, handlers());
  await pi.request("open");
  const process = host.processes[0];
  const disposed = pi.dispose();
  await vi.waitFor(() => expect(process?.ended).toBe(true));
  process?.exit(0);
  await disposed;
  expect(process?.killed).toBe(false);
  await expect(pi.request("open")).rejects.toThrow("Pi has stopped");
});

it("accepts in the host the membership keys the app names agents with", () => {
  // host.mjs cannot import the app's pattern, so it keeps a copy that names
  // the agent's storage file: it must stay the same, and path-safe.
  const copy = /^const AGENT_KEY = (\/.*\/);$/m.exec(hostSource)?.[1];
  expect(copy).toBe(`/${AGENT_KEY.source}/`);
});

it.each(["dispose", "exit", "retire", "policy"])(
  "retires completed protection checks with their Pi connection (%s)",
  async (retirement) => {
    const agent = "a".repeat(64);
    const checkEvidence = vi.fn<AgentProtection["checkEvidence"]>(
      async (_action, source) => {
        for await (const _part of source.read()) {
          /* consume */
        }
      },
    );
    let gate: AgentProtection = {
      key: "a:1",
      stateKey: "a:1",
      checkEvidence,
      check: async () => {
        throw new Error("Unexpected object check in this fixture");
      },
      assertAvailable() {},
      processProtection: { readOnlyPaths: [], hiddenPaths: [] },
      spawn: async () => {
        throw new Error("Unused protected runtime");
      },
    };
    const host = fakeHost(
      {
        runtime: () => ({
          file: "/runtime/deps/host.mjs",
          node: "/runtime/node/bin/node",
          codeRoot: "/runtime/deps",
          nodeRoot: "/runtime/node",
          data: "/runtime/state",
          auth: "/runtime/auth",
        }),
      },
      { close: true },
    );
    const pi = new Pi(
      () => host.spawn,
      handlers(),
      () => gate,
    );
    const action = {
      kind: "context",
      session: "native-session",
      content: "reviewed input",
    };
    try {
      await pi.request("open", { agent });
      const worker = host.processes.find(
        (process) => process.options.protection,
      );
      if (!worker) throw new Error("Missing protected worker");
      await expect(review(worker, action)).resolves.toMatchObject({
        result: { allowed: true },
      });
      const signal = checkEvidence.mock.calls[0]?.[2];
      expect(signal?.aborted).toBe(false);
      if (retirement === "dispose") await pi.dispose();
      else {
        if (retirement === "exit") worker.exit(1);
        else if (retirement === "retire") await pi.retire(agent);
        else gate = { ...gate, key: "a:2", stateKey: "a:2" };
        if (retirement === "exit")
          await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        await pi.request("open", { agent });
        const next = host.processes
          .filter((process) => process.options.protection)
          .at(-1);
        expect(next).not.toBe(worker);
        if (!next) throw new Error("Missing replacement worker");
        await expect(review(next, action)).resolves.toMatchObject({
          result: { allowed: true },
        });
        expect(checkEvidence.mock.calls[1]?.[2].aborted).toBe(false);
      }
      expect(signal?.aborted).toBe(true);
    } finally {
      await pi.dispose();
    }
  },
);

it("isolates protected agents, contains their runtime code and cancels a native check", async () => {
  const entered = deferred();
  let waiting: AbortSignal | undefined;
  const gates = new Map<string, AgentProtection>();
  const make = (key: string): AgentProtection => ({
    key,
    stateKey: key,
    assertAvailable: vi.fn(),
    processProtection: {
      readOnlyPaths: ["/security/provider"],
      hiddenPaths: ["/security/approvals"],
    },
    spawn: async () => {
      throw new Error("Unused protected runtime");
    },
    checkEvidence: vi.fn(async (_action, _source, signal) => {
      waiting = signal;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    }),
    check: async () => {
      throw new Error("Unexpected object check in this fixture");
    },
  });
  const a = "a".repeat(64),
    b = "b".repeat(64);
  gates.set(a, make("a:1"));
  gates.set(b, make("b:1"));
  const host = fakeHost(
    {
      runtime: () => ({
        file: "/runtime/deps/version/host.mjs",
        node: "/runtime/node/bin/node",
        codeRoot: "/runtime/deps",
        nodeRoot: "/runtime/node",
        data: "/runtime/state",
        auth: "/runtime/auth",
      }),
    },
    { close: true },
  );
  const pi = new Pi(
    () => host.spawn,
    handlers(),
    (agent) => gates.get(agent),
  );
  try {
    await Promise.all([
      pi.request("open", { agent: a }),
      pi.request("open", { agent: b }),
    ]);
    const protectedHosts = host.processes.filter(
      (process) => process.options.protection,
    );
    expect(protectedHosts).toHaveLength(2);
    const worker = protectedHosts.find((process) =>
      process.options.args?.at(-1)?.includes(a),
    );
    if (!worker) throw new Error("Missing protected worker");
    expect(worker.id).toBe("pi-protected-sh");
    expect(worker.options.secrets).toBeUndefined();
    expect(
      manifest.host.processes.find((process) => process.id === worker.id),
    ).toMatchObject({
      program: "buzz-agent-command",
      bundled: true,
      args: ["--shell"],
    });
    expect(worker.options.args?.[0]).toContain("--disable-sigusr1");
    expect(worker.options.env).toMatchObject({
      BASH_ENV: null,
      ENV: null,
      NODE_OPTIONS: null,
      NODE_PATH: null,
      DYLD_INSERT_LIBRARIES: null,
    });
    expect(worker.options.protection).toEqual({
      readOnlyPaths: ["/security/provider", "/runtime/deps", "/runtime/node"],
      hiddenPaths: ["/security/approvals"],
    });
    const id = crypto.randomUUID();
    await expect(
      evidence(worker, "begin", { id, kind: "tool", session: "1" }),
    ).resolves.toMatchObject({ result: { id } });
    await entered.promise;
    await expect(evidence(worker, "cancel", { id })).resolves.toMatchObject({
      result: { allowed: false },
    });
    expect(waiting?.aborted).toBe(true);
    // Each worker's evidence reaches only its own agent's provider.
    expect(gates.get(b)?.checkEvidence).not.toHaveBeenCalled();
    gates.set(a, make("a:2"));
    await pi.request("open", { agent: a });
    expect(worker.ended).toBe(true);
    expect(
      host.processes.filter((process) => process.options.protection),
    ).toHaveLength(3);
  } finally {
    await pi.dispose();
  }
});

it("starts an agent with its own list in its own host, and chooses again when a host exits", async () => {
  const ada = "a".repeat(64);
  const bo = "b".repeat(64);
  const host = fakeHost({ ping: (params) => ({ agent: params.agent }) });
  const pi = new Pi(
    () => host.spawn,
    handlers(),
    () => undefined,
  );
  env.own.set(ada, true);
  try {
    await pi.request("ping", { agent: ada });
    await pi.request("ping", { agent: bo });
    expect(host.processes.map((process) => process.options.envAgent)).toEqual([
      ada,
      undefined,
    ]);
    // Its list is removed while its host runs: the route holds until it exits.
    env.own.set(ada, false);
    await pi.request("ping", { agent: ada });
    expect(host.processes).toHaveLength(2);
    host.processes[0]?.exit(0);
    await pi.request("ping", { agent: ada });
    expect(host.processes).toHaveLength(2);
    expect(host.requests("ping").at(-1)?.params.agent).toBe(ada);
    expect(host.processes[1]?.requests.at(-1)?.params.agent).toBe(ada);
    // The shared host exits after a list is added: the next start reads it.
    env.own.set(bo, true);
    host.processes[1]?.exit(0);
    await pi.request("ping", { agent: bo });
    expect(host.processes.at(-1)?.options.envAgent).toBe(bo);
    // An unreadable list starts on the shared host, and is read again when
    // that host exits.
    env.own.set(ada, undefined);
    await pi.request("ping", { agent: ada });
    expect(host.processes.at(-1)?.options.envAgent).toBeUndefined();
    env.own.set(ada, true);
    host.processes.at(-1)?.exit(0);
    await pi.request("ping", { agent: ada });
    expect(host.processes.at(-1)?.options.envAgent).toBe(ada);
  } finally {
    env.own.clear();
    await pi.dispose();
  }
});

it("moves a restarted agent to its own host on its first list, and back on its last", async () => {
  const ada = "a".repeat(64);
  const bo = "b".repeat(64);
  const host = fakeHost({ ping: (params) => ({ agent: params.agent }) });
  const pi = new Pi(
    () => host.spawn,
    handlers(),
    () => undefined,
  );
  try {
    await pi.request("ping", { agent: ada });
    await pi.request("ping", { agent: bo });
    expect(host.processes).toHaveLength(1);
    env.own.set(ada, true);
    await pi.retire(ada);
    await pi.request("ping", { agent: ada });
    expect(host.processes.map((process) => process.options.envAgent)).toEqual([
      undefined,
      ada,
    ]);
    env.own.set(ada, false);
    await pi.retire(ada);
    await pi.request("ping", { agent: ada });
    expect(host.processes).toHaveLength(2);
    expect(host.processes[1]?.gone).toBe(true);
    expect(host.processes[0]?.requests.at(-1)?.params.agent).toBe(ada);
  } finally {
    env.own.clear();
    await pi.dispose();
  }
});

/** A host whose `acquire` takes the agent's storage lock, as the SQLite
 * lockfile does: one process at a time, until it closes or exits. */
function lockingHost() {
  const locks = new Map<string, FakeProcess>();
  const held = (agent: string) => {
    const owner = locks.get(agent);
    return owner && !owner.gone ? owner : undefined;
  };
  const host = fakeHost({
    acquire: (params, process) => {
      const agent = String(params.agent);
      const owner = held(agent);
      if (owner && owner !== process) throw new Error("storage is locked");
      locks.set(agent, process);
      return { by: host.processes.indexOf(process) };
    },
    close: (params) => void locks.delete(String(params.agent)),
  });
  return host;
}

it("releases an agent's own host's storage before the shared host opens it", async () => {
  const ada = "a".repeat(64);
  const host = lockingHost();
  const pi = new Pi(
    () => host.spawn,
    handlers(),
    () => undefined,
  );
  env.own.set(ada, true);
  try {
    await expect(pi.request("acquire", { agent: ada })).resolves.toEqual({
      by: 0,
    });
    env.own.set(ada, false);
    let retired = false;
    const retiring = pi.retire(ada).then(() => {
      retired = true;
    });
    const next = pi.request("acquire", { agent: ada });
    // `end()` is the retirement's last step before it waits for the exit, so
    // from here on only the exit can let it, and the next host, go on.
    await vi.waitFor(() => expect(host.processes[0]?.ended).toBe(true));
    await Promise.resolve();
    expect(retired).toBe(false);
    expect(host.processes).toHaveLength(1);
    host.processes[0]?.exit(0);
    await retiring;
    await expect(next).resolves.toEqual({ by: 1 });
    expect(host.processes[1]?.options.envAgent).toBeUndefined();
  } finally {
    await pi.dispose();
  }
});

it("ends an own host whose start comes back after its retirement, before the next one opens", async () => {
  const ada = "a".repeat(64);
  const host = lockingHost();
  const started = deferred<void>();
  let first = true;
  const pi = new Pi(
    () => async (id, options) => {
      const spawned = host.spawn(id, options);
      if (first) {
        first = false;
        await started.promise;
      }
      return spawned;
    },
    handlers(),
    () => undefined,
  );
  env.own.set(ada, true);
  try {
    const late = pi.request("acquire", { agent: ada });
    late.catch(() => undefined);
    await vi.waitFor(() => expect(host.processes).toHaveLength(1));
    env.own.set(ada, false);
    const retiring = pi.retire(ada);
    const next = pi.request("acquire", { agent: ada });
    started.resolve();
    await vi.waitFor(() => expect(host.processes[0]?.ended).toBe(true));
    expect(host.processes).toHaveLength(1);
    host.processes[0]?.exit(0);
    await retiring;
    await expect(next).resolves.toEqual({ by: 1 });
    expect(host.processes[1]?.options.envAgent).toBeUndefined();
  } finally {
    await pi.dispose();
  }
});

it.each(["shared", "own", "protected"] as const)(
  "answers two requests at once for one agent (%s host)",
  async (route) => {
    const isProtected = route === "protected";
    if (route === "own") env.own.set("a".repeat(64), true);
    const ada = "a".repeat(64);
    const gate: AgentProtection = {
      key: "a:1",
      stateKey: "a:1",
      assertAvailable: vi.fn(),
      processProtection: { readOnlyPaths: [], hiddenPaths: [] },
      spawn: async () => {
        throw new Error("Unused protected runtime");
      },
      checkEvidence: vi.fn(),
      check: vi.fn(),
    };
    const host = fakeHost({
      ping: () => ({ pong: true }),
      runtime: () => ({
        file: "/runtime/deps/version/host.mjs",
        node: "/runtime/node/bin/node",
        codeRoot: "/runtime/deps",
        nodeRoot: "/runtime/node",
        data: "/runtime/state",
        auth: "/runtime/auth",
      }),
    });
    const pi = new Pi(
      () => host.spawn,
      handlers(),
      () => (isProtected ? gate : undefined),
    );
    const answer = deferred<void>();
    env.gate = answer.promise;
    try {
      const both = Promise.all([
        pi.request("ping", { agent: ada }),
        pi.request("ping", { agent: ada }),
      ]);
      answer.resolve();
      await expect(both).resolves.toEqual([{ pong: true }, { pong: true }]);
      // Both ran on one host: the shared one, or the agent's own.
      expect(host.processes).toHaveLength(isProtected ? 2 : 1);
      if (route !== "protected")
        expect(host.processes[0]?.options.envAgent).toBe(
          route === "own" ? ada : undefined,
        );
    } finally {
      env.own.clear();
      env.gate = undefined;
      await pi.dispose();
    }
  },
);

it("starts an agent's own host again after its start fails", async () => {
  const ada = "a".repeat(64);
  const host = fakeHost({ ping: () => ({ pong: true }) }, { ready: false });
  const pi = new Pi(
    () => host.spawn,
    handlers(),
    () => undefined,
  );
  env.own.set(ada, true);
  try {
    const failed = pi.request("ping", { agent: ada });
    await vi.waitFor(() => expect(host.processes).toHaveLength(1));
    host.processes[0]?.exit(1, "Pi could not start\n");
    await expect(failed).rejects.toThrow("Pi could not start");
    const retried = pi.request("ping", { agent: ada });
    await vi.waitFor(() => expect(host.processes).toHaveLength(2));
    host.processes[1]?.send({ method: "ready", params: {} });
    await expect(retried).resolves.toEqual({ pong: true });
    expect(host.processes.map((process) => process.options.envAgent)).toEqual([
      ada,
      ada,
    ]);
  } finally {
    await pi.dispose();
  }
});

it.each(["retire", "dispose"] as const)(
  "starts no host for a presence answer that comes after %s",
  async (end) => {
    const ada = "a".repeat(64);
    const host = fakeHost({ ping: () => ({ pong: true }) });
    const pi = new Pi(
      () => host.spawn,
      handlers(),
      () => undefined,
    );
    const answer = deferred<void>();
    env.gate = answer.promise;
    env.own.set(ada, true);
    try {
      const late = pi.request("ping", { agent: ada });
      const ending = end === "retire" ? pi.retire(ada) : pi.dispose();
      answer.resolve();
      await expect(late).rejects.toThrow("Pi has stopped");
      await ending;
      expect(host.processes).toHaveLength(0);
    } finally {
      env.gate = undefined;
      await pi.dispose();
    }
  },
);
