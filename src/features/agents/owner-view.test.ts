import { expect, it } from "vitest";
import { steerPrompt, turnPrompt } from "../../bundled/claude-code/prompt";
import { claudeTurns } from "../../bundled/claude-code/transcript";
import { turnInput } from "../../bundled/codex/prompt";
import { codexTurns } from "../../bundled/codex/transcript";
import type { EventData } from "../relay/events";
import type { TranscriptTurn } from "./activity-transcript";
import { ownerTurns, ownerUsage } from "./owner-view";
import type { AgentReads } from "./reads";

const agent = "a".repeat(64);
const open = "7a1b2c3d-0000-4000-8000-000000000001";
const hidden = "7a1b2c3d-0000-4000-8000-000000000002";
const reads = {
  ownerReadable: (id: string) => id === open,
} as unknown as AgentReads;
const event = (id: string, channel: string): EventData => ({
  id: id.repeat(64),
  pubkey: "b".repeat(64),
  kind: 9,
  created_at: 1_800_000_000,
  content: `from ${channel}`,
  tags: [["h", channel]],
});
const claudePrompt = (id: string, channel: string, name: string) =>
  turnPrompt({
    agent,
    event: event(id, channel),
    channel: { id: channel, name, dm: channel === hidden },
    scope: "community",
    context: [],
    total: 1,
  });
let clock = 0;
const line = (type: string, content: unknown) =>
  JSON.stringify({
    type,
    uuid: `u${++clock}`,
    timestamp: new Date(++clock * 1000).toISOString(),
    message: { role: type, content },
  });
const claudeSession = (...prompts: string[]) =>
  claudeTurns(
    prompts
      .flatMap((prompt) => [
        line("user", prompt),
        line("assistant", [{ type: "text", text: "Done." }]),
      ])
      .join("\n"),
    { sessionId: "community", channelId: open },
    false,
  );
const shown = (turns: readonly TranscriptTurn[]) =>
  turns.map((turn) => turn.items.map((item) => item.type));

it("keeps a community session's turns from channels the owner cannot read out of its transcript", () => {
  clock = 0;
  const turns = claudeSession(
    claudePrompt("1", open, "general"),
    claudePrompt("2", hidden, "Agent DM"),
    claudePrompt("3", open, "general"),
  );
  expect(turns).toHaveLength(3);
  const readable = ownerTurns(turns, reads, {
    channelId: open,
    community: true,
  });
  expect(readable.map((turn) => turn.turnId)).toEqual([
    turns[0]?.turnId,
    turns[2]?.turnId,
  ]);
  expect(JSON.stringify(readable)).not.toContain("Agent DM");
  expect(JSON.stringify(readable)).not.toContain(`from ${hidden}`);
});

it("hides a turn a steer from an unreadable channel joined, and one with no known source", () => {
  clock = 0;
  const steered = claudeSession(
    claudePrompt("1", open, "general"),
    steerPrompt(claudePrompt("2", hidden, "Agent DM")),
  );
  expect(steered).toHaveLength(1);
  expect(
    ownerTurns(steered, reads, { channelId: open, community: true }),
  ).toEqual([]);
  const [turn] = claudeSession(claudePrompt("1", open, "general"));
  if (!turn) throw new Error("no turn");
  const headless = { ...turn, items: turn.items.slice(1) };
  expect(
    ownerTurns([headless], reads, { channelId: open, community: true }),
  ).toEqual([]);
});

it("hides a turn joined by a prompt whose source channel is unknown", () => {
  clock = 0;
  const mixed = claudeSession(
    claudePrompt("1", open, "general"),
    steerPrompt("Undisclosed body without a channel context"),
  );
  expect(mixed).toHaveLength(1);
  const readable = ownerTurns(mixed, reads, {
    channelId: open,
    community: true,
  });
  expect(readable).toEqual([]);
  expect(JSON.stringify(readable)).not.toContain("Undisclosed body");
});

it("hides a turn whose opening prompt was cut off, leaving only a readable steer", () => {
  clock = 0;
  const [turn] = claudeSession(steerPrompt(claudePrompt("1", open, "general")));
  if (!turn) throw new Error("no turn");
  expect(
    ownerTurns([turn], reads, { channelId: open, community: true }),
  ).toEqual([]);
});

it("hides a turn whose first prompt is flagged as a steer, even once unwrapped", () => {
  clock = 0;
  const [turn] = claudeSession(claudePrompt("1", open, "general"));
  if (!turn) throw new Error("no turn");
  const flagged = {
    ...turn,
    items: turn.items.map((item) =>
      item.type === "prompt" ? { ...item, steer: true } : item,
    ),
  };
  expect(
    ownerTurns([flagged], reads, { channelId: open, community: true }),
  ).toEqual([]);
});

it("reads the source channel of a Codex community turn from its context", () => {
  const input = (channel: string, name: string) =>
    turnInput(
      agent,
      event("4", channel),
      {
        channelId: channel,
        name,
        community: true,
      } as never,
      `from ${channel}`,
    );
  const codex = codexTurns(
    [open, hidden].map((channel, index) => ({
      id: `turn-${index}`,
      status: "completed",
      error: null,
      startedAt: index + 1,
      completedAt: index + 2,
      items: [
        {
          type: "userMessage",
          id: `item-${index}`,
          content: [
            { text: input(channel, channel === open ? "general" : "Agent DM") },
          ],
        },
      ],
    })),
    { channelId: open },
  );
  expect(shown(codex)).toEqual([["prompt"], ["prompt"]]);
  expect(
    ownerTurns(codex, reads, { channelId: open, community: true }).map(
      (turn) => turn.turnId,
    ),
  ).toEqual(["turn-0"]);
});

it("shows nothing of a conversation in a channel the owner cannot read", () => {
  clock = 0;
  const turns = claudeSession(claudePrompt("1", hidden, "Agent DM"));
  expect(ownerTurns(turns, reads, { channelId: hidden })).toEqual([]);
  expect(ownerTurns(turns, reads, { channelId: open })).toHaveLength(1);
  expect(ownerTurns(turns, undefined, { channelId: open })).toEqual([]);
});

it("keeps a hidden channel's usage but not where or what it was", () => {
  const session = (channelId: string) => ({
    id: channelId,
    revision: "1",
    gaps: [],
    channelId,
    root: "r".repeat(64),
    title: `About ${channelId}`,
    startedAt: 1,
    lastAt: 2,
    observations: [],
  });
  const [shown, kept] = ownerUsage([session(open), session(hidden)], reads);
  expect(shown).toEqual(session(open));
  expect(kept).toEqual({
    id: hidden,
    revision: "1",
    gaps: [],
    startedAt: 1,
    lastAt: 2,
    observations: [],
  });
});

it("keeps a session's cost but not its title when its channel is unknown", () => {
  const [kept] = ownerUsage(
    [
      {
        id: "standalone",
        revision: "1",
        gaps: [],
        title: "About a private DM",
        startedAt: 1,
        lastAt: 2,
        observations: [],
      },
    ],
    reads,
  );
  expect(kept).toEqual({
    id: "standalone",
    revision: "1",
    gaps: [],
    startedAt: 1,
    lastAt: 2,
    observations: [],
  });
});
