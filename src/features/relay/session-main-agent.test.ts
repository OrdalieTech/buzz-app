import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair } from "./testing";

const owners: ReturnType<typeof createRelaySession>[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("queues account choices and conditional removal through one writer", async () => {
  const viewer = keypair();
  const relay = keypair();
  const writes: string[] = [];
  const writeMainAgent = vi.fn(async (agent: string | null) => {
    writes.push(String(agent));
  });
  const clearMainAgent = vi.fn(async (expected: string) => {
    writes.push(`clear:${expected}`);
    return undefined;
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async () => [],
    readMainAgent: async () => undefined,
    writeMainAgent,
    clearMainAgent,
  });
  owners.push(owner);
  const account = owner.session.mainAgent;
  if (!account) throw new Error("Missing main-agent capability");
  if (!account.clear) throw new Error("Missing conditional clear capability");
  await Promise.all([
    account.write("a".repeat(64)),
    account.clear("a".repeat(64)),
    account.write(null),
  ]);
  expect(writes).toEqual(["a".repeat(64), `clear:${"a".repeat(64)}`, "null"]);
});
