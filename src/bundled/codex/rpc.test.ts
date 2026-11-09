import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { AppServer, type Wire } from "./rpc";
function fixture() {
  let options: HostProcessOptions | undefined;
  let exit!: (code: number) => void;
  const sent: Wire[] = [];
  const process = {
    write: async (text: string) => {
      const wire: Wire = JSON.parse(text);
      sent.push(wire);
      if (wire.method === "initialize" && wire.id != null)
        emit({ id: wire.id, result: {} });
    },
    end: vi.fn(async () => {
      exit(0);
    }),
    kill: vi.fn(async () => {
      exit(1);
    }),
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
  };
  const raw = (text: string) => options?.onStdout?.(text);
  const emit = (wire: Wire) => raw(`${JSON.stringify(wire)}\n`);
  const rpc = new AppServer();
  const open = () =>
    rpc.open(async (_id, value) => {
      options = value;
      return process;
    });
  return { rpc, open, raw, emit, sent, process };
}
it("correlates out-of-order JSONL responses across chunk boundaries and rejects interactive requests once", async () => {
  const f = fixture();
  await f.open();
  const first = f.rpc.request("first");
  const second = f.rpc.request("second");
  const a = f.sent.find((w) => w.method === "first");
  const b = f.sent.find((w) => w.method === "second");
  const text = `${JSON.stringify({ id: b?.id, result: "second result" })}\n${JSON.stringify({ id: a?.id, result: "first result" })}\n`;
  f.raw(text.slice(0, 11));
  f.raw(text.slice(11));
  await expect(first).resolves.toBe("first result");
  await expect(second).resolves.toBe("second result");
  const one = vi.fn();
  const two = vi.fn();
  f.rpc.onMessage(one);
  f.rpc.onMessage(two);
  f.emit({
    id: "interactive",
    method: "item/tool/requestUserInput",
    params: {},
  });
  expect(f.sent.filter((w) => w.id === "interactive")).toEqual([
    { id: "interactive", error: { code: -32601, message: expect.any(String) } },
  ]);
  expect(one).not.toHaveBeenCalled();
  expect(two).not.toHaveBeenCalled();
  await f.rpc.close();
});
it("contains consumer exceptions and closes malformed output while rejecting pending work", async () => {
  const f = fixture();
  await f.open();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const listener = vi.fn();
  f.rpc.onMessage(() => {
    throw new Error("consumer failure");
  });
  f.rpc.onMessage(listener);
  try {
    expect(() => f.emit({ method: "turn/started", params: {} })).not.toThrow();
    expect(listener).toHaveBeenCalledWith({
      method: "turn/started",
      params: {},
    });
    const request = f.rpc.request("waiting");
    const rejected = expect(request).rejects.toThrow();
    expect(() => f.raw("invalid json\n")).not.toThrow();
    await rejected;
    await f.rpc.close();
    expect(f.process.end).toHaveBeenCalledTimes(1);
  } finally {
    consoleError.mockRestore();
  }
});
it("attempts a failed close again and never spawns once closed", async () => {
  const f = fixture();
  await f.open();
  f.process.end.mockRejectedValueOnce(new Error("stuck"));
  f.process.kill.mockRejectedValueOnce(new Error("stuck"));
  await expect(f.rpc.close()).rejects.toThrow("stuck");
  await f.rpc.close();
  expect(f.process.end).toHaveBeenCalledTimes(2);
  const spawn = vi.fn();
  await expect(f.rpc.open(spawn)).rejects.toThrow("Codex connection closed");
  expect(spawn).not.toHaveBeenCalled();
});
it("reopens a protected runtime with the same security check and a live process", async () => {
  const agents = ["fixture buzz-protection-v2", "fixture"];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    const userAgent = agents.shift();
    let exit!: (code: number) => void;
    return {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        if (wire.method === "initialize")
          options?.onStdout?.(
            `${JSON.stringify({ id: wire.id, result: { userAgent } })}\n`,
          );
      },
      end: vi.fn(async () => exit(0)),
      kill: vi.fn(async () => exit(1)),
      exited: new Promise<number>((resolve) => {
        exit = resolve;
      }),
    };
  });
  const rpc = new AppServer();
  await rpc.open(spawn, "/work", true);
  await expect(rpc.reopen()).rejects.toThrow("mandatory security hooks");
  expect(spawn).toHaveBeenLastCalledWith(
    "app-server",
    expect.objectContaining({ cwd: "/work" }),
  );
  agents.push("fixture buzz-protection-v2");
  await expect(rpc.reopen()).resolves.toBe(rpc);
  expect(rpc.exited).toBe(false);
  await rpc.close();
});
