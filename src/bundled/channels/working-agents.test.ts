import { expect, test } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import {
  activityTranscript,
  workingAgentDetails,
  workingAgentMessage,
  workingAgents,
} from "./working-agents";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;

test("only current channel-wide work appears, once per agent, and clears on end", () => {
  const turn = (
    agent: string,
    channelId: string,
    state: "working" | "ended",
  ): Snapshot["turns"][number] => ({
    agent,
    channelId,
    state,
    turnId: agent,
    timestamp: 1,
  });
  const typing = (
    agent: string,
    channelId: string,
    threadRootId?: string,
  ): Snapshot["typing"][number] => ({
    agent,
    channelId,
    threadRootId,
    startedAt: 1,
    working: true,
  });
  const active: Snapshot = {
    status: "listening",
    records: [],
    turns: [
      turn("b", "design", "working"),
      turn("a", "design", "working"),
      turn("c", "other", "working"),
      turn("d", "design", "ended"),
    ],
    typing: [
      typing("a", "design"),
      typing("e", "design", "thread"),
      typing("f", "other"),
    ],
    trimmed: 0,
  };
  expect(workingAgents(active, "design")).toEqual(["a", "b"]);
  expect(workingAgents(active, "other")).toEqual(["c", "f"]);
  expect(workingAgents({ ...active, status: "interrupted" }, "design")).toEqual(
    [],
  );
  expect(workingAgents({ ...active, turns: [], typing: [] }, "design")).toEqual(
    [],
  );
});

test("links only a current turn to its single captured message", () => {
  const agent = "a".repeat(64);
  const messageId = "b".repeat(64);
  const start = (turnId: string, ids: string[]) => ({
    id: "c".repeat(64),
    agent,
    receivedAt: 1,
    kind: "turn_started",
    plaintext: JSON.stringify({
      kind: "turn_started",
      channelId: "design",
      turnId,
      timestamp: new Date(1).toISOString(),
      payload: { triggeringEventIds: ids },
    }),
    createdAt: 1,
    channelIds: ["design"],
  });
  const active: Snapshot = {
    status: "listening",
    records: [start("old", ["d".repeat(64)]), start("current", [messageId])],
    turns: [
      {
        agent,
        channelId: "design",
        turnId: "old",
        timestamp: 1,
        state: "ended",
      },
      {
        agent,
        channelId: "design",
        turnId: "current",
        timestamp: 2,
        state: "working",
      },
    ],
    typing: [],
    trimmed: 0,
  };
  expect(workingAgentMessage(active, "design", agent)).toBe(messageId);
  expect(workingAgentDetails(active, "design", agent)).toEqual({
    messageId,
    startedAt: 1,
  });
  expect(workingAgentMessage(active, "other", agent)).toBeUndefined();
  expect(
    workingAgentMessage(
      { ...active, records: [start("old", ["d".repeat(64)])] },
      "design",
      agent,
    ),
  ).toBeUndefined();
  expect(
    workingAgentMessage(
      { ...active, records: [start("current", [messageId, "e".repeat(64)])] },
      "design",
      agent,
    ),
  ).toBeUndefined();
  expect(
    workingAgentMessage({ ...active, status: "interrupted" }, "design", agent),
  ).toBeUndefined();
  expect(
    workingAgentDetails(
      {
        ...active,
        turns: [],
        typing: [
          {
            agent,
            channelId: "design",
            threadRootId: undefined,
            startedAt: 1000,
            working: true,
          },
        ],
      },
      "design",
      agent,
    ),
  ).toEqual({ startedAt: 1000 });
});

test("View activity names a transcript only for a Solo chat, a DM or a loaded request", () => {
  const top = "a".repeat(64);
  const reply = "b".repeat(64);
  const channels = {
    list: () => ({
      status: "ready",
      channels: [
        { id: "solo", name: "Planning", channelType: "solo" },
        { id: "dm", name: "Ada", channelType: "dm" },
        { id: "design", name: "design", channelType: "stream" },
      ],
    }),
    window: (channelId: string) => ({
      rows:
        channelId === "design"
          ? [{ id: top }, { id: reply, threadRootId: top }]
          : [],
    }),
  } as unknown as Pick<RelaySession["channels"], "list" | "window">;
  // One conversation, whichever message started the work.
  expect(activityTranscript(channels, "solo", undefined)).toEqual({});
  // A DM is one conversation too, loaded or not.
  expect(activityTranscript(channels, "dm", "c".repeat(64))).toEqual({});
  expect(activityTranscript(channels, "design", top)).toEqual({ rootId: top });
  expect(activityTranscript(channels, "design", reply)).toEqual({
    rootId: top,
  });
  // Unknown or unloaded work never guesses a thread.
  expect(activityTranscript(channels, "design", undefined)).toBeUndefined();
  expect(
    activityTranscript(channels, "design", "c".repeat(64)),
  ).toBeUndefined();
});
