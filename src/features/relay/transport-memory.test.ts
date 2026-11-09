import { afterEach, expect, it, vi } from "vitest";
import { connectBrokerTransport } from "./transport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("ends a stalled web Memory read in an error after 10 seconds", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/register")) return Promise.resolve(new Response("{}"));
      if (url.endsWith("/session"))
        return Promise.resolve(
          Response.json({
            viewer: "c".repeat(64),
            relayAuthor: "d".repeat(64),
            agentMemories: true,
          }),
        );
      // The broker never answers; only the signal ends the request.
      return new Promise((_, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }),
  );
  const transport = await connectBrokerTransport(
    "",
    undefined,
    "wss://relay.example",
  );
  const deadlines: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    deadlines.push(ms);
    return timeout(0);
  });
  await expect(
    transport.readAgentMemories?.("a".repeat(64), new AbortController().signal),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(deadlines).toContain(10000);
});
