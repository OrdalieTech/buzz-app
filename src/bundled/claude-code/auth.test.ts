import { beforeEach, expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeAuth } from "./auth";
import { ENV, type Spawn } from "./claude";
import { PROCESS_LIMIT } from "./sessions";

const KEY = "sk-ant-api03-saved";

/** Native's key store (`claude_key.rs`): whether a key is saved, the asks
 * and saves it took, and a refusal to answer the next save with. */
const state = vi.hoisted(() => ({
  saved: true,
  asked: 0,
  saves: [] as string[],
  clears: 0,
  refusals: [] as string[],
  /** Each local agent's own variable names (`agent_env.rs`). */
  agentEnv: new Map<string, string[]>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (command: string, args?: { value: string; agent?: string }) => {
    if (command === "agent_env_status")
      return { names: state.agentEnv.get(args?.agent ?? "") ?? [] };
    if (command === "claude_api_key_status") {
      state.asked += 1;
      return state.saved;
    }
    if (command === "claude_api_key_clear") {
      state.clears++;
      const refusal = state.refusals.shift();
      if (refusal) throw refusal;
      state.saved = false;
      return null;
    }
    if (command !== "claude_api_key_set" || !args) return null;
    const refusal = state.refusals.shift();
    if (refusal) throw refusal;
    state.saves.push(args.value);
    state.saved = true;
    return null;
  },
}));
/** Starts with a key saved or not. */
function store(saved = true) {
  Object.assign(state, {
    saved,
    asked: 0,
    saves: [],
    clears: 0,
    refusals: [],
  });
  state.agentEnv.clear();
}
beforeEach(() => void store());

/** A host whose `claude.sh review` prints a review folder, and whose
 * `claude auth status` reports `own`, the person's own setup (signed out
 * unless set); every start but that check is recorded. */
function host(own: Record<string, unknown> = { loggedIn: false }) {
  const started: { id: string; options: HostProcessOptions | undefined }[] = [];
  const status = { own, asked: 0 };
  const spawn: Spawn = async (id, options) => {
    if (id === "claude" && options?.args?.join(" ") === "auth status --json") {
      status.asked++;
      // As every Claude starts, and never with the key.
      expect(options).toMatchObject({ env: ENV });
      expect(options).not.toHaveProperty("secrets");
      options.onStdout?.(JSON.stringify(status.own));
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: Promise.resolve(status.own.loggedIn ? 0 : 1),
      };
    }
    started.push({ id, options });
    if (id === "review")
      queueMicrotask(() => options?.onStdout?.("/Users/me/review\n"));
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: Promise.resolve(0),
    };
  };
  return { spawn, started, status };
}

it("asks native code to start every claude, the protected release included, with the key", async () => {
  const { spawn, started } = host();
  const auth = new ClaudeAuth(spawn);
  const authorized = auth.authorize(spawn, true);
  for (const id of ["claude", "claude-protected-arm64"])
    await authorized(id, { args: ["--verbose"], env: { ...ENV, A: "1" } });
  await authorized("platform", { env: { ...ENV } });
  expect(started.map(({ id }) => id)).toEqual([
    "claude",
    "claude-protected-arm64",
    "platform",
  ]);
  for (const { options } of started.slice(0, 2)) {
    expect(options).toEqual({
      args: ["--verbose"],
      env: { ...ENV, A: "1" },
      secrets: ["anthropic-api-key"],
    });
    // Process launches never read or forward the key through JavaScript.
    expect(JSON.stringify(options)).not.toContain("sk-ant-");
  }
  expect(started[2]?.options).toEqual({ env: { ...ENV } });
});

it("refuses a turn's claude without a key, but lets setup run its checks", async () => {
  const { spawn, started } = host();
  store(false);
  const auth = new ClaudeAuth(spawn);
  await expect(
    auth.authorize(spawn, true)("claude", { env: ENV }),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
  expect(started).toEqual([]);
  await auth.authorize(spawn)("claude", { args: ["--version"], env: ENV });
  expect(started.at(-1)).toEqual({
    id: "claude",
    options: {
      args: ["--version"],
      env: ENV,
      secrets: ["anthropic-api-key"],
    },
  });
});

it("starts a turn's claude with no saved key when its agent's own variables set one", async () => {
  const { spawn, started } = host();
  store(false);
  const agent = "a".repeat(64);
  const other = "b".repeat(64);
  state.agentEnv.set(agent, ["ANTHROPIC_API_KEY"]);
  state.agentEnv.set(other, ["OTHER"]);
  const authorized = new ClaudeAuth(spawn).authorize(spawn, true);
  const options = { env: ENV, secrets: ["agent-env" as const] };
  await authorized("claude", { ...options, envAgent: agent });
  expect(started.at(-1)?.options?.envAgent).toBe(agent);
  await expect(
    authorized("claude", { ...options, envAgent: other }),
  ).rejects.toThrow("Claude needs an Anthropic API key.");
  // An inherited key is still no credential: Claude's env removes it.
  await expect(authorized("claude", options)).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
  expect(started).toHaveLength(1);
  // One the device list sets counts for every agent, and for the spare.
  state.agentEnv.set("", ["ANTHROPIC_API_KEY"]);
  await authorized("claude", { ...options, envAgent: other });
  await authorized("claude", options);
  expect(started).toHaveLength(3);
  // Without own setup, each asks native for a key: its own list's, the
  // device's, then the shared one.
  for (const { options } of started)
    expect(options?.secrets).toEqual(["agent-env", "anthropic-api-key"]);
  // A launch that doesn't ask for the lists never gets that key.
  await expect(authorized("claude", { env: ENV })).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
});

it("passes a full host's refusal on, rather than taking it for no setup", async () => {
  const { spawn, started } = host();
  store(false);
  let full = true;
  const capped: Spawn = (id, options) =>
    full ? Promise.reject(PROCESS_LIMIT) : spawn(id, options);
  const auth = new ClaudeAuth(capped);
  const authorized = auth.authorize(capped, true);
  await expect(authorized("claude", { env: ENV })).rejects.toBe(PROCESS_LIMIT);
  // Asked again once there is room, it finds no setup and no key.
  full = false;
  await expect(authorized("claude", { env: ENV })).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
  expect(started).toEqual([]);
});

it("reads a full host as no own setup outside a turn", async () => {
  const capped: Spawn = () => Promise.reject(PROCESS_LIMIT);
  const auth = new ClaudeAuth(capped);
  // The saved key still counts, as when the setup check found none.
  await expect(auth.check()).resolves.toEqual({});
  store(false);
  await expect(auth.check()).resolves.toBeUndefined();
});

it("counts a device-list key for ordinary agents, after the person's own setup", async () => {
  store(false);
  state.agentEnv.set("", ["ANTHROPIC_API_KEY"]);
  await expect(new ClaudeAuth(host().spawn).check()).resolves.toEqual({});
  // The person's own sign-in still wins: Claude starts without a key.
  const own = host({ loggedIn: true });
  const signedIn = new ClaudeAuth(own.spawn);
  await expect(signedIn.check()).resolves.toEqual({});
  expect(signedIn.usesOwnSetup).toBe(true);
  await signedIn.authorize(own.spawn, true)("claude", { env: ENV });
  expect(own.started).toEqual([{ id: "claude", options: { env: ENV } }]);
  // Security reviews still need the saved key.
  await expect(new ClaudeAuth(host().spawn).review()).rejects.toThrow();
  state.agentEnv.clear();
  await expect(new ClaudeAuth(host().spawn).check()).resolves.toBeUndefined();
});

it("asks again until a key is saved, then once until it is saved or checked", async () => {
  const { spawn } = host();
  store(false);
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toBeUndefined();
  // No key is not kept: another Buzz on this computer may save one.
  state.saved = true;
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(2);
  // A key is kept until it is checked or saved.
  state.saved = false;
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(2);
  await expect(auth.check()).resolves.toBeUndefined();
  state.saved = true;
  await expect(auth.check()).resolves.toEqual({});
  await auth.save(KEY);
  await auth.authorize(spawn, true)("claude");
  expect(state.asked).toBe(5);
});

it("saves the key with native code alone and tells listeners, but not of a refused one", async () => {
  const { spawn, started } = host();
  store(false);
  state.refusals.push("That is not an Anthropic API key.");
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  await expect(auth.save("nope")).rejects.toBe(
    "That is not an Anthropic API key.",
  );
  expect(told).not.toHaveBeenCalled();
  await expect(auth.save(KEY)).resolves.toBe("Saved the Anthropic API key.");
  expect(told).toHaveBeenCalledTimes(1);
  expect(state.saves).toEqual([KEY]);
  expect(started).toEqual([]);
  // A save stopped before it reaches the store saves nothing.
  const stopped = new AbortController();
  stopped.abort();
  await expect(auth.save(KEY, stopped.signal)).rejects.toThrow();
  expect(state.saves).toEqual([KEY]);
});

it("gives a review its own folder, the key coming from native code", async () => {
  const { spawn } = host();
  await expect(new ClaudeAuth(spawn).review()).resolves.toEqual({
    home: "/Users/me/review",
    env: {},
  });
  store(false);
  await expect(new ClaudeAuth(spawn).review()).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
});

it("clears the native key, invalidates cached authorization, and notifies sessions", async () => {
  const { spawn, started } = host();
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  await auth.authorize(spawn, true)("claude");
  await auth.clear();
  expect(state.clears).toBe(1);
  expect(told).toHaveBeenCalledOnce();
  await expect(auth.authorize(spawn, true)("claude")).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
  await expect(auth.review()).rejects.toThrow(
    "Claude needs an Anthropic API key.",
  );
  expect(started).toHaveLength(1);
  await auth.save(KEY);
  await auth.authorize(spawn, true)("claude");
  expect(started).toHaveLength(2);
});

it("preserves authorization on a failed removal and notifies only after retry succeeds", async () => {
  const { spawn } = host();
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  state.refusals.push("Keychain access was denied.");
  await expect(auth.clear()).rejects.toBe("Keychain access was denied.");
  expect(told).not.toHaveBeenCalled();
  await expect(auth.check()).resolves.toEqual({});
  await auth.clear();
  expect(told).toHaveBeenCalledOnce();
  await expect(auth.check()).resolves.toBeUndefined();
});

it("links a turn that failed for want of a working key to Settings", async () => {
  const auth = new ClaudeAuth(undefined);
  const settings = "buzz://settings?section=agents";
  const missing = await auth
    .authorize(async () => {
      throw new Error("unreachable");
    }, true)("claude")
    .then(
      () => "",
      (error: unknown) => String(error),
    );
  expect(auth.explainTurn(missing, settings)).toBe(
    `Claude is missing an API key. Head to [Settings](${settings}) to add one.`,
  );
  expect(
    auth.explainTurn("Invalid API key · Fix external API key", settings),
  ).toBe(
    `Anthropic rejected Claude's API key. It may have been revoked or run out of credit. Head to [Settings](${settings}) to replace it.`,
  );
  expect(auth.explainTurn("Error: overloaded", settings)).toBe(
    "Error: overloaded",
  );
});

it("points a refusal at both the saved key and the own setup while protected launches use the key", async () => {
  const { spawn } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  await auth.check();
  // A protected launch selects the saved key beside the own setup.
  await auth.authorize(spawn, true)("claude-protected-arm64", {
    env: ENV,
    args: ["--setting-sources", ""],
  });
  const settings = "buzz://settings?section=agents";
  for (const error of [
    "Invalid API key",
    "Invalid API key · Please run /login",
  ])
    expect(auth.explainTurn(error, settings)).toBe(
      `Claude could not authenticate. Protected agents use the API key in [Settings](${settings}): replace it there if it was revoked or ran out of credit. Other agents use your own Claude setup: fix it with the Claude CLI. Then try again.`,
    );
  // Once the key is removed, only the own setup is left to fix.
  await auth.clear();
  await auth.check();
  expect(auth.explainTurn("Invalid API key", settings)).toBe(
    "Claude could not authenticate with your own Claude setup. Fix it with the Claude CLI, then try again.",
  );
});

const SIGNED_IN = {
  loggedIn: true,
  authMethod: "third_party",
  apiProvider: "vertex",
};

it("runs turns with the person's own Claude setup, without the key, even with one saved", async () => {
  const { spawn, started } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  // Ready, without naming the setup.
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.usesOwnSetup).toBe(true);
  const authorized = auth.authorize(spawn, true);
  for (const id of ["claude", "claude-protected-arm64"])
    await authorized(id, { env: ENV });
  expect(started).toEqual([
    { id: "claude", options: { env: ENV } },
    { id: "claude-protected-arm64", options: { env: ENV } },
  ]);
});

it("needs no key while the person's own setup works", async () => {
  store(false);
  const { spawn, started } = host({
    loggedIn: true,
    authMethod: "third_party",
    apiProvider: "bedrock",
  });
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toEqual({});
  await auth.authorize(spawn, true)("claude", { env: ENV });
  expect(started).toEqual([{ id: "claude", options: { env: ENV } }]);
  expect(state.asked).toBe(0);
});

it("still gives security reviews the key, in their own folder", async () => {
  const { spawn, started } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  await auth.check();
  const review = await auth.review();
  const env = { ...ENV, CLAUDE_CONFIG_DIR: review.home };
  await auth.authorize(spawn)("claude-protected-arm64", { env });
  expect(started.at(-1)).toEqual({
    id: "claude-protected-arm64",
    options: { env, secrets: ["anthropic-api-key"] },
  });
});

it("keeps the saved key for protected launches, which read no settings files", async () => {
  const { spawn, started } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  await auth.check();
  const args = ["--verbose", "--setting-sources", ""];
  await auth.authorize(spawn, true)("claude-protected-arm64", {
    env: ENV,
    args,
  });
  expect(started.at(-1)).toEqual({
    id: "claude-protected-arm64",
    options: { env: ENV, args, secrets: ["anthropic-api-key"] },
  });
  // With no key saved, the person's own setup is all a protected launch has.
  store(false);
  const keyless = new ClaudeAuth(spawn);
  await keyless.check();
  await keyless.authorize(spawn, true)("claude-protected-arm64", {
    env: ENV,
    args,
  });
  expect(started.at(-1)).toEqual({
    id: "claude-protected-arm64",
    options: { env: ENV, args },
  });
});

it("asks for the person's own setup once until checked, and tells listeners when it changes", async () => {
  const { spawn, status } = host();
  const auth = new ClaudeAuth(spawn);
  const told = vi.fn();
  auth.subscribe(told);
  const authorized = auth.authorize(spawn, true);
  await authorized("claude");
  await authorized("claude");
  // The version needs no credentials.
  await authorized("claude", { args: ["--version"] });
  expect(status.asked).toBe(1);
  await auth.check();
  expect(told).not.toHaveBeenCalled();
  status.own = SIGNED_IN;
  // Ready, without naming the setup.
  await expect(auth.check()).resolves.toEqual({});
  expect(told).toHaveBeenCalledOnce();
  status.own = { loggedIn: false };
  await expect(auth.check()).resolves.toEqual({});
  expect(told).toHaveBeenCalledTimes(2);
});

it("uses the key when Claude cannot say whether the person has a setup", async () => {
  const started: string[] = [];
  const spawn: Spawn = async (id, options) => {
    started.push([id, ...(options?.args ?? [])].join(" "));
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      // Not installed yet: no JSON.
      exited: Promise.resolve(127),
    };
  };
  const auth = new ClaudeAuth(spawn);
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.usesOwnSetup).toBe(false);
  await auth.authorize(spawn, true)("claude");
  // An answer Claude could not give is asked again.
  expect(started).toEqual([
    "claude auth status --json",
    "claude auth status --json",
    "claude",
  ]);
});

it("points a refused own setup at the Claude CLI rather than a key", async () => {
  store(false);
  const { spawn } = host(SIGNED_IN);
  const auth = new ClaudeAuth(spawn);
  await auth.check();
  const settings = "buzz://settings?section=agents";
  for (const error of [
    "Invalid API key · Please run /login",
    "OAuth token has expired. Please run /login",
  ])
    expect(auth.explainTurn(error, settings)).toBe(
      "Claude could not authenticate with your own Claude setup. Fix it with the Claude CLI, then try again.",
    );
  expect(auth.explainTurn("Error: overloaded", settings)).toBe(
    "Error: overloaded",
  );
});

it("keeps the person's own setup with a device-list key: no key is asked for", async () => {
  const { spawn, started } = host({ loggedIn: true });
  store(false);
  state.agentEnv.set("", ["ANTHROPIC_API_KEY"]);
  const authorized = new ClaudeAuth(spawn).authorize(spawn, true);
  const agent = "a".repeat(64);
  const options = { env: ENV, secrets: ["agent-env" as const] };
  await authorized("claude", { ...options, envAgent: agent });
  await authorized("claude", options);
  expect(started.map(({ options }) => options)).toEqual([
    { ...options, envAgent: agent },
    options,
  ]);
});

it("keeps protected eligibility to the person's own setup or a saved key, from the check's own answers", async () => {
  // Only the device list: ordinary agents are ready, protected ones are not.
  store(false);
  state.agentEnv.set("", ["ANTHROPIC_API_KEY"]);
  const device = host();
  const auth = new ClaudeAuth(device.spawn);
  expect(auth.protectedEligible).toBeUndefined();
  await expect(auth.check()).resolves.toEqual({});
  expect(auth.protectedEligible).toBe(false);
  // Read from what the check sampled: no second key or own-setup ask.
  const asked = [state.asked, device.status.asked];
  await expect(auth.protectedReady()).resolves.toBe(false);
  expect([state.asked, device.status.asked]).toEqual(asked);
  // A saved key counts at once, and clearing it takes it away again.
  await auth.save(KEY);
  expect(auth.protectedEligible).toBe(true);
  await auth.clear();
  expect(auth.protectedEligible).toBe(false);
  // The person's own setup counts without a key.
  const own = new ClaudeAuth(host({ loggedIn: true }).spawn);
  await own.check();
  expect(own.protectedEligible).toBe(true);
  // Unsampled, it asks rather than assuming either way.
  store(true);
  await expect(new ClaudeAuth(host().spawn).protectedReady()).resolves.toBe(
    true,
  );
});

it("stops admitting protected agents on the person's own setup once a fresh check of it fails", async () => {
  store(false);
  state.agentEnv.set("", ["ANTHROPIC_API_KEY"]);
  const own = host({ loggedIn: true });
  const auth = new ClaudeAuth(own.spawn);
  await auth.check();
  expect(auth.protectedEligible).toBe(true);
  // Claude can't say this time: ordinary agents keep the device key...
  own.status.own = null as never;
  await expect(auth.check()).resolves.toEqual({});
  // ...and the last answer, but protected admission is unknown, not yes.
  expect(auth.usesOwnSetup).toBe(true);
  expect(auth.protectedEligible).toBeUndefined();
  await expect(auth.protectedReady()).rejects.toThrow();
  // A saved key still admits it.
  await auth.save(KEY);
  expect(auth.protectedEligible).toBe(true);
});

it("never admits a protected agent on a probe a newer, failed check replaced", async () => {
  store(false);
  const answers: ((status: unknown) => void)[] = [];
  const spawn: Spawn = async (_id, options) => {
    let stdout = "";
    const exited = new Promise<number>((resolve) => {
      answers.push((status) => {
        stdout = JSON.stringify(status);
        options?.onStdout?.(stdout);
        resolve(0);
      });
    });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited,
    };
  };
  const auth = new ClaudeAuth(spawn);
  // Admission starts probe A; a newer check replaces it with probe B.
  const admitted = auth.protectedReady();
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  const checked = auth.check();
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  // B can't say, then A answers yes.
  (answers[1] as (status: unknown) => void)(null);
  await checked;
  (answers[0] as (status: unknown) => void)({ loggedIn: true });
  await expect(admitted).rejects.toThrow();
  expect(auth.protectedEligible).toBeUndefined();
});
