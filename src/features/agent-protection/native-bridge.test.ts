import { expect, it, vi } from "vitest";
import type { McpHandler } from "../host/service";
import { nativeProtectionBridge } from "./native-bridge";
import { ProtectionDenied, type AgentProtection } from "./service";

async function fixture(check: AgentProtection["check"]) {
  let handler!: McpHandler, closed!: () => void;
  const close = vi.fn(async () => closed());
  const bridge = await nativeProtectionBridge(
    async (call) => {
      handler = call;
      return {
        url: "http://127.0.0.1:1234/mcp",
        headers: [{ name: "Authorization", value: "Bearer native-owned" }],
        close,
        closed: new Promise<void>((r) => {
          closed = r;
        }),
      };
    },
    {
      key: "policy",
      stateKey: "revision",
      processProtection: { readOnlyPaths: [], hiddenPaths: [] },
      spawn: async () => {
        throw new Error("Unused protected runtime");
      },
      assertAvailable() {},
      check,
    },
  );
  return { bridge, handler, close, closed };
}
const call = {
  id: "native-1",
  method: "buzz/security/check",
  params: {
    kind: "tool",
    session: "native-session",
    content: { command: "write", conversation: ["authorized task"] },
  },
};

it("uses native transport authority and preserves the exact evidence", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const f = await fixture(check);
  expect(f.bridge.env).toEqual({
    BUZZ_SECURITY_CONTEXT: "1",
    BUZZ_SECURITY_TOOL: "1",
    BUZZ_SECURITY_TOOL_RESULT: "1",
    BUZZ_SECURITY_URL: "http://127.0.0.1:1234/mcp",
    BUZZ_SECURITY_TOKEN: "native-owned",
  });
  expect(await f.handler(call)).toEqual({
    jsonrpc: "2.0",
    id: "native-1",
    result: { allowed: true },
  });
  expect(check.mock.calls[0]?.[0]).toEqual(call.params);
  await expect(
    f.handler({ ...call, params: { ...call.params, policy: {} } }),
  ).rejects.toThrow("Invalid native security request");
  await f.bridge.close();
});

it("denies checker failures and cancels held approvals when the server closes", async () => {
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const f = await fixture(async (_action, signal) => {
    entered();
    await new Promise<void>((_r, reject) =>
      signal.addEventListener("abort", () => reject(new Error("closed")), {
        once: true,
      }),
    );
  });
  const pending = f.handler(call);
  await started;
  await f.bridge.close();
  expect(await pending).toEqual({
    jsonrpc: "2.0",
    id: "native-1",
    result: { allowed: false },
  });
});

it("preserves optional command evidence and rejects invalid or extra fields", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const f = await fixture(check);
  const params = { ...call.params, command: "echo approved" };
  try {
    expect(await f.handler({ ...call, params })).toMatchObject({
      result: { allowed: true },
    });
    expect(check.mock.calls[0]?.[0]).toEqual(params);
    for (const invalid of [
      { ...params, command: null },
      { ...params, command: 42 },
      { ...params, command: {} },
      { ...params, policy: {} },
      { ...params, agent: "another-agent" },
    ]) {
      await expect(f.handler({ ...call, params: invalid })).rejects.toThrow(
        "Invalid native security request",
      );
    }
    expect(check).toHaveBeenCalledTimes(1);
  } finally {
    await f.bridge.close();
  }
});

it("rejects saturation instead of admitting unchecked native actions", async () => {
  const f = await fixture(async (_action, signal) => {
    await new Promise<void>((_r, reject) =>
      signal.addEventListener("abort", () => reject(new Error("closed")), {
        once: true,
      }),
    );
  });
  const pending = Array.from({ length: 16 }, (_, i) =>
    f.handler({ ...call, id: String(i) }),
  );
  await expect(f.handler({ ...call, id: "overflow" })).rejects.toThrow(
    "Invalid native security request",
  );
  await f.bridge.close();
  expect(
    (await Promise.all(pending)).every(
      (row) =>
        (row as { result: { allowed: boolean } }).result.allowed === false,
    ),
  ).toBe(true);
});

it("keeps an explained model-input denial for Buzz, never for the runtime", async () => {
  const check = vi.fn<AgentProtection["check"]>();
  const f = await fixture(check);
  const ask = (kind: string, session = "native-session") =>
    f.handler({ ...call, params: { ...call.params, kind, session } });
  const deny = (reason?: string) =>
    check.mockRejectedValueOnce(new ProtectionDenied(reason));
  const turn = f.bridge.explainer("native-session");
  deny("It asks to reveal keys.");
  expect(await ask("context")).toEqual({
    jsonrpc: "2.0",
    id: "native-1",
    result: { allowed: false },
  });
  // A refused tool call or result does not end the turn, so needs no reason.
  deny("A refused tool call.");
  await ask("tool");
  deny("A refused tool result.");
  await ask("tool-result");
  // Nor does a concurrent source that passed, or was refused unexplained.
  check.mockResolvedValueOnce();
  await ask("context");
  deny();
  await ask("context");
  check.mockRejectedValueOnce(new Error("offline"));
  await ask("context");
  expect(turn()).toBe("It asks to reveal keys.");
  expect(turn()).toBeUndefined();
  // Explanations nobody takes age out, oldest first.
  const turns = Array.from({ length: 17 }, (_, index) =>
    f.bridge.explainer(`session-${index}`),
  );
  for (let index = 0; index <= 16; index++) {
    deny(`Session ${index}.`);
    await ask("context", `session-${index}`);
  }
  expect(turns[0]?.()).toBeUndefined();
  expect(turns[1]?.()).toBe("Session 1.");
  expect(turns[16]?.()).toBe("Session 16.");
});

it("explains a turn only by a refusal of a check that turn started", async () => {
  const check = vi.fn<AgentProtection["check"]>();
  const f = await fixture(check);
  const ask = () =>
    f.handler({ ...call, params: { ...call.params, kind: "context" } });
  // A check from an interrupted turn is still with its reviewer.
  const hold = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    check.mockImplementationOnce(async () => {
      await held;
      throw new ProtectionDenied("An earlier turn's refusal.");
    });
    return release;
  };
  let release = hold();
  const earlier = ask();
  expect(check).toHaveBeenCalledTimes(1);
  const turn = f.bridge.explainer("native-session");
  check.mockRejectedValueOnce(new ProtectionDenied("This turn's refusal."));
  await ask();
  // Settling after this turn's refusal, it does not replace it.
  release();
  await earlier;
  expect(turn()).toBe("This turn's refusal.");
  // Nor does it explain a turn that ends for another reason.
  release = hold();
  const stale = ask();
  expect(check).toHaveBeenCalledTimes(3);
  const next = f.bridge.explainer("native-session");
  release();
  await stale;
  expect(next()).toBeUndefined();
});
