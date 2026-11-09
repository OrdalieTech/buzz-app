import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { TypingEntry } from "../relay/typing";
export const agent = "a".repeat(64),
  human = "b".repeat(64),
  other = "c".repeat(64);
export const root = "d".repeat(64),
  secondRoot = "e".repeat(64);
export type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
export function fixture() {
  const listeners = new Set<() => void>();
  let typing: readonly TypingEntry[] = [];
  let activity: Snapshot = {
    status: "listening",
    typing: [],
    records: [],
    turns: [],
    trimmed: 0,
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const profiles = new Map([
    [agent, { name: "Agent" }],
    [human, { name: "Human" }],
    [
      "public-agent",
      { name: "Sam’s assistant", isAgent: true, ownerPubkey: "sam" },
    ],
    [other, { name: "Other" }],
  ]);
  const library = { identities: [{ pubkey: agent }, { pubkey: other }] };
  const rows = [
    { id: root, content: "First task" },
    { id: secondRoot, content: "Second task" },
  ];
  const ensure = vi.fn();
  const session = {
    viewer: "viewer",
    typing: { snapshot: () => typing, subscribe },
    agentActivity: { snapshot: () => activity, subscribe },
    profiles: { snapshot: () => profiles, subscribe, ensure },
    agentChoices: { snapshot: () => library, subscribe },
    channels: {
      window: () => ({ rows }),
      subscribeWindow: (_id: string, fn: () => void) => subscribe(fn),
      ensure,
    },
  } as unknown as RelaySession;
  return {
    session,
    ensure,
    update(entries: readonly TypingEntry[], patch: Partial<Snapshot> = {}) {
      act(() => {
        typing = entries;
        activity = { ...activity, ...patch };
        for (const listener of listeners) listener();
      });
    },
  };
}
export const entry = (
  pubkey = agent,
  threadRootId: string | undefined = root,
): TypingEntry => ({ pubkey, channelId: "channel", threadRootId });
