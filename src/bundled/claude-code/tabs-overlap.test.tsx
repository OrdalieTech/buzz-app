// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LIVE_READ_MS } from "../../features/agents/TranscriptPanel";
import type { TranscriptTurn } from "../../features/agents/activity-transcript";
import type { Agent } from "../../features/agents/service";
import { ClaudeDefaults } from "./defaults";
import { ClaudeRuntime, type Config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup } from "./setup";
import { createTabs } from "./tabs";
import type { AgentReads } from "../../features/agents/reads";

const agent: Agent<Config> = {
  key: "c".repeat(64),
  pubkey: "c".repeat(64),
  owner: "a".repeat(64),
  name: "Claude",
  type: "buzz.claude-code/claude-code",
  relay: "wss://example.org",
  place: "here",
  config: DEFAULT_CONFIG,
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

function turn(text: string, at: number) {
  return {
    turnId: text,
    startedAt: at,
    channelId: "channel",
    threadRootId: null,
    triggeringEventIds: [],
    sessionId: "kept",
    newSession: false,
    config: [],
    partial: false,
    items: [{ id: text, at, type: "prompt", text, sections: [], steer: false }],
  } satisfies TranscriptTurn;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const ownerReads = {
  ownerReadable: () => true,
  channelLabel: () => undefined,
  name: () => undefined,
} as unknown as AgentReads;

it("loads full Claude history when work stops after a poll observes invalid overlap", async () => {
  vi.useFakeTimers();
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent.key]: { channel: { id: "kept", seen: 0, at: 1 } },
    }),
  );
  const runtime = new ClaudeRuntime(
    {},
    () => ownerReads,
    async () => undefined,
  );
  const sessions = vi
    .spyOn(runtime, "sessions")
    .mockReturnValue([{ key: "channel", busy: true }]);
  const next = turn("Latest after the stop", 3);
  const finish = deferred<void>();
  vi.spyOn(runtime, "transcriptPreview")
    .mockResolvedValueOnce({
      turns: [turn("Previewed activity", 2)],
      more: true,
    })
    .mockImplementation(async () => {
      await finish.promise;
      return { turns: [next], more: true };
    });
  vi.spyOn(runtime, "transcript").mockImplementation(async () => {
    await finish.promise;
    return { turns: [turn("Earlier history", 1), next], more: false };
  });
  const poll = deferred<TranscriptTurn[]>();
  let pollSignal: AbortSignal | undefined;
  vi.spyOn(runtime, "latestTurns").mockImplementationOnce(
    (_, _workspace, _working, signal) => {
      pollSignal = signal;
      return poll.promise;
    },
  );
  const { ActivityTab } = createTabs({
    runtime,
    defaults: new ClaudeDefaults(),
    setup: new ClaudeSetup(undefined),
  });
  const view = () => <ActivityTab agent={agent} />;
  const { rerender } = render(view());
  const load = "Load earlier activity";
  const summary = { selector: "summary span" };
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^View transcript/ }));
  });
  expect(screen.getByText("Previewed activity", summary)).toBeVisible();
  expect(screen.getByRole("button", { name: load })).toBeVisible();

  act(() => vi.advanceTimersByTime(LIVE_READ_MS));
  expect(pollSignal?.aborted).toBe(false);
  const stop = poll.promise.then(() => {
    sessions.mockReturnValue([{ key: "channel", busy: false }]);
    rerender(view());
    expect(pollSignal?.aborted).toBe(true);
  });
  poll.resolve([next]);
  try {
    await stop;
  } finally {
    await act(async () => finish.resolve());
  }

  expect(screen.getByText("Latest after the stop", summary)).toBeVisible();
  expect(screen.getByText("Earlier history", summary)).toBeVisible();
  expect(screen.queryByRole("button", { name: load })).toBeNull();
});
