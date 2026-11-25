// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentsContext } from "./react";
import type { Agents } from "./service";
import { ActivityTranscript, TranscriptFocus } from "./ActivityTranscript";
import { readerInputs } from "../profiles/target";
import type { TranscriptTurn } from "./activity-transcript";
import { activityTranscript } from "./activity-transcript";
import { withSessionPrompts } from "./session-prompts";
import { eventBody } from "../agent-harness/turn-records";
import { codexTurns } from "../../bundled/codex/transcript";
import { restoreRecordedTools } from "../../bundled/codex/recorded-tools";
import {
  clockPreference,
  setClockPreference,
} from "../../shared/clock-preference";
import { formatTime } from "../../shared/datetime";

afterEach(cleanup);

it.each([
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["terminated", "Failed"],
  ["cancelled", "Stopped"],
  ["future-outcome", "Status unknown"],
])("shows the remote turn outcome %s in the Activity tab", (outcome, label) => {
  const at = new Date("2026-11-04T12:00:00Z");
  const transcript = activityTranscript(
    [
      {
        id: "remote",
        agent: "a".repeat(64),
        receivedAt: at.getTime(),
        plaintext: JSON.stringify({
          kind: "turn_completed",
          turnId: "task",
          timestamp: at.toISOString(),
          payload: { outcome },
        }),
      },
    ],
    { agent: "a".repeat(64) },
  );
  render(
    <ActivityTranscript
      transcript={transcript}
      agentName="Remote helper"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText(label, { exact: true })).toBeVisible();
  if (label === "Failed")
    expect(screen.getByText(label).closest("header")).toHaveAttribute(
      "data-status",
      "failed",
    );
});

it.each([
  ["failed", "Failed"],
  ["terminated", "Terminated"],
])("shows %s script status before opening its output", (status, label) => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [],
      },
    ],
    { channelId: "channel" },
  );
  turns[0]?.items.push({
    id: "script",
    toolCallId: "script",
    at: 1000,
    type: "tool",
    title: "exec",
    kind: "execute",
    status,
    input: "throw new Error('failed')",
    output: `Script ${status}\nOutput:\nError`,
    paths: [],
    diffs: [],
    truncated: false,
  });
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText(label, { exact: true })).toBeVisible();
  expect(
    screen.getByText("exec", { exact: true }).closest("details"),
  ).not.toHaveAttribute("open");
});

it("shows the recorded tool name, highlights tool calls, and keeps script text intact without raw details", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [],
      },
    ],
    { channelId: "channel" },
  );
  const script =
    "text(await tools.buzz__channels({all:true}));\ntext(await tools.clock__curr_time({}));";
  restoreRecordedTools(
    turns,
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "script",
          name: "exec",
          input: script,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "script",
          output: [
            {
              type: "input_text",
              text: "Script completed\nOutput:\nchannel list",
            },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  await user.click(screen.getByText("exec", { exact: true }));
  const channels = screen.getByText("tools.buzz__channels", { exact: true });
  expect(channels).toBeVisible();
  expect(channels).toHaveClass("text-accent");
  expect(
    screen.getByText("tools.clock__curr_time", { exact: true }),
  ).toHaveClass("text-accent");
  expect(channels.closest("pre")?.textContent).toBe(script);
  expect(
    screen.getByText(/^Script completed Output: channel list$/),
  ).toBeVisible();
  expect(screen.queryByText("Raw details")).not.toBeInTheDocument();
});

it("shows a failed nested call on the collapsed script while preserving the script's status", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "commandExecution",
            id: "failed",
            command: "false",
            status: "failed",
            aggregatedOutput: "exit 1",
          },
        ],
      },
    ],
    { channelId: "channel" },
  );
  const turn = turns[0];
  const failed = turn?.items[0];
  if (!turn || failed?.type !== "tool") throw new Error("Missing failed tool");
  turn.items = [
    {
      ...failed,
      id: "script",
      toolCallId: "script",
      title: "exec",
      status: "completed",
      children: [failed],
    },
  ];
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText("· 1 failed call")).toBeVisible();
  const script = screen.getByText("exec", { exact: true }).closest("details");
  expect(script).not.toHaveAttribute("open");
  expect(script).toHaveAttribute("data-status", "completed");
  await userEvent.click(screen.getByText("exec", { exact: true }));
  // The script and its nested call each carry their own time.
  expect(script?.querySelectorAll("time")).toHaveLength(2);
  expect(script?.parentElement?.querySelectorAll("time")).toHaveLength(2);
});

it("discloses tool arguments and results without raw details, including a posted send", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "dynamicToolCall",
            id: "read",
            namespace: "buzz",
            tool: "read",
            arguments: { limit: 2 },
            status: "completed",
            contentItems: [{ type: "inputText", text: "two messages" }],
            success: true,
          },
          {
            type: "dynamicToolCall",
            id: "send",
            namespace: "buzz",
            tool: "send",
            arguments: { text: "Done" },
            status: "completed",
            contentItems: [{ type: "inputText", text: "sent" }],
            success: true,
          },
        ],
      },
    ],
    { channelId: "channel" },
  );
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  const tool = screen.getByText("buzz.read").closest("details");
  expect(tool).not.toHaveAttribute("open");
  await user.click(screen.getByText("buzz.read"));
  expect(tool).toHaveAttribute("open");
  expect(screen.getByText('{ "limit": 2 }')).toBeVisible();
  expect(screen.getByText("two messages")).toBeVisible();
  expect(screen.getByText("Done", { selector: "summary span" })).toBeVisible();
  expect(screen.queryByText("Raw details")).not.toBeInTheDocument();
});

it("renders thought formatting and keeps entry times available, except the prompt", async () => {
  const at = Date.UTC(2026, 9, 20, 20, 1, 28);
  const { container } = render(
    <ActivityTranscript
      transcript={{
        turns: [
          {
            turnId: "t",
            startedAt: at,
            endedAt: at + 9000,
            threadRootId: null,
            config: [],
            items: [
              { id: "prompt", at, type: "prompt", text: "hi", sections: [] },
              {
                id: "thought",
                at: at + 3000,
                type: "thought",
                text: "**Inspecting the bootstrap script**\n\nChecking **formatting**.",
              },
              { id: "reply", at: at + 70_000, type: "message", text: "done" },
            ],
          } as never,
        ],
      }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  await userEvent.click(screen.getByText("Inspecting the bootstrap script"));
  expect(screen.getByText("formatting", { selector: "strong" }).tagName).toBe(
    "STRONG",
  );
  expect(container.querySelectorAll("time")).toHaveLength(3);
  for (const text of ["Inspecting the bootstrap script", "done"]) {
    expect(
      screen
        .getByText(text, { selector: "summary span" })
        .closest("details")
        ?.querySelector("time")
        ?.getAttribute("title"),
    ).toContain("2026");
  }
});

it("updates mounted transcript clocks while keeping elapsed time and navigation", () => {
  const previous = { ...clockPreference() };
  const at = new Date(2026, 9, 20, 14, 1, 28).getTime();
  const openConversation = vi.fn();
  setClockPreference({ hourCycle: "h12", seconds: false });
  try {
    const { container } = render(
      <ActivityTranscript
        transcript={{
          turns: [
            {
              turnId: "clock",
              triggeringEventIds: [],
              newSession: false,
              partial: false,
              startedAt: at,
              endedAt: at + 9000,
              channelId: "channel",
              threadRootId: null,
              config: [],
              items: [
                {
                  id: "thought",
                  at: at + 3000,
                  type: "thought",
                  text: "Checking the clock",
                },
              ],
            },
          ],
        }}
        agentName="Sol"
        state={() => "ended"}
        openConversation={openConversation}
      />,
    );
    const clocks = Array.from(container.querySelectorAll("time"));
    expect(clocks).toHaveLength(2);
    const before = clocks.map((clock) => clock.textContent);
    act(() => setClockPreference({ hourCycle: "h23", seconds: true }));
    expect(clocks.map((clock) => clock.textContent)).toEqual([
      formatTime((at + 9000) / 1000),
      formatTime((at + 3000) / 1000),
    ]);
    expect(clocks.map((clock) => clock.textContent)).not.toEqual(before);
    expect(container.querySelector("header")).toHaveTextContent("9.0s");
    fireEvent.click(screen.getByRole("button", { name: "Channel" }));
    expect(openConversation).toHaveBeenCalledWith("channel", undefined);
  } finally {
    act(() => setClockPreference(previous));
  }
});

it("shows no time for an entry with a zero, non-finite or invalid time", async () => {
  const { container } = render(
    <ActivityTranscript
      transcript={{
        turns: [
          {
            turnId: "t",
            startedAt: 0,
            endedAt: 0,
            threadRootId: null,
            config: [],
            items: [
              { id: "zero", at: 0, type: "thought", text: "a" },
              { id: "inf", at: Infinity, type: "thought", text: "b" },
              { id: "nan", at: NaN, type: "message", text: "c" },
              {
                id: "script",
                at: 0,
                type: "tool",
                title: "exec",
                status: "completed",
                paths: [],
                diffs: [],
                children: [
                  { id: "child", at: 1e20, type: "message", text: "d" },
                ],
              },
            ],
          } as never,
        ],
      }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  await userEvent.click(screen.getByText("exec", { exact: true }));
  expect(screen.getByText("d", { selector: "summary span" })).toBeVisible();
  expect(container.querySelectorAll("time")).toHaveLength(0);
});

it.each([
  ["ended", 2000, undefined, undefined, "Completed"],
  ["working", undefined, undefined, undefined, "Working"],
  ["working", undefined, "ended", undefined, "Completed"],
  ["working", undefined, "error", undefined, "Failed"],
  ["working", undefined, "stopped", undefined, "Stopped"],
  ["working", undefined, "unknown", undefined, "Status unknown"],
  ["ended", 2000, undefined, "Command failed", "Failed"],
  ["unknown", undefined, undefined, undefined, "Status unknown"],
] as const)(
  "shows only the turn status for %s/%s/%s/%s",
  (state, endedAt, outcome, error, label) => {
    const turn = {
      turnId: "status",
      startedAt: 1000,
      endedAt,
      outcome,
      error,
      channelId: "channel",
      threadRootId: "a".repeat(64),
      config: ["gpt-6"],
      source: "heartbeat",
      stopReason: "stop",
      items: [],
    } as unknown as TranscriptTurn;
    const { container } = render(
      <ActivityTranscript
        transcript={{ turns: [turn] }}
        agentName="Agent"
        state={() => state}
      />,
    );
    if (label === "Working") {
      expect(container.querySelector("header")).toBeNull();
      expect(screen.getAllByText("Working")).toHaveLength(1);
    } else {
      expect(screen.queryByText("Working")).not.toBeInTheDocument();
      expect(container.querySelector("header")).toHaveTextContent(label);
      expect(container.querySelector("header time") !== null).toBe(!!endedAt);
    }
  },
);

it("opens at the latest turn and follows new ones until the reader scrolls up", () => {
  const turn = (id: string, at: number): TranscriptTurn => ({
    turnId: id,
    channelId: "channel",
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: at,
    endedAt: at + 1000,
    partial: false,
    items: [],
  });
  let height = 1000;
  const scrolling = () => {
    const view = document.createElement("div");
    view.style.overflowY = "auto";
    Object.defineProperty(view, "scrollHeight", { get: () => height });
    Object.defineProperty(view, "clientHeight", { get: () => 200 });
    return document.body.appendChild(view);
  };
  const view = scrolling();
  const show = (turns: TranscriptTurn[], follow?: boolean) => (
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
      {...(follow === undefined ? {} : { follow })}
    />
  );
  const { rerender, unmount } = render(show([turn("a", 1)]), {
    container: view,
  });
  expect(view.scrollTop).toBe(1000);
  height = 1400;
  rerender(show([turn("a", 1), turn("b", 2)]));
  expect(view.scrollTop).toBe(1400);
  view.scrollTop = 100;
  fireEvent.scroll(view);
  height = 1800;
  rerender(show([turn("a", 1), turn("b", 2), turn("c", 3)]));
  expect(view.scrollTop).toBe(100);
  unmount();
  const shared = scrolling();
  render(show([turn("a", 1)], false), { container: shared });
  expect(shared.scrollTop).toBe(0);
  view.remove();
  shared.remove();
});

it.each([
  {
    situation: "when the partial transcript fits",
    resized: false,
    fits: true,
    expectedTop: 90,
  },
  {
    situation: "when the viewport grows to fit after scrolling up",
    resized: true,
    fits: true,
    expectedTop: 90,
  },
  {
    situation: "when native restoration scroll fires inside the follow margin",
    resized: false,
    fits: false,
    expectedTop: 205,
  },
])(
  "keeps the open disclosure and its viewport $situation",
  async ({ fits, resized, expectedTop }) => {
    const item = (id: string, text: string) => ({
      id,
      text,
      type: "thought" as const,
      at: 1,
    });
    const turn: TranscriptTurn = {
      turnId: "ongoing",
      channelId: null,
      threadRootId: null,
      triggeringEventIds: [],
      newSession: false,
      config: [],
      startedAt: 1,
      partial: false,
      items: [
        item("first", "First"),
        item("middle", "Middle\n\nDetails"),
        item("last", "Last"),
      ],
    };
    const older = item("history", "Older");
    const newer = item("live", "Newer");
    const view = document.body.appendChild(document.createElement("div"));
    view.style.overflowY = "auto";
    const prependHeight = () =>
      view.querySelector('[data-entry="item:history"]') ? 150 : 0;
    let viewportHeight = resized ? 35 : 150;
    const rowLengths = fits ? [20, 50, 20] : [80, 140, 100];
    const contentHeight = fits ? 90 : 320;
    const naturalHeight = () =>
      contentHeight +
      prependHeight() -
      (view.querySelector('[data-entry="item:last"]') ? 0 : 100) +
      (view.querySelector('[data-entry="item:live"]') ? 120 : 0);
    Object.defineProperty(view, "clientHeight", { get: () => viewportHeight });
    Object.defineProperty(view, "scrollHeight", {
      get: () => Math.max(viewportHeight, naturalHeight()),
    });
    let scrollTop = 0;
    Object.defineProperty(view, "scrollTop", {
      get: () => scrollTop,
      set: (desired: number) => {
        scrollTop = Math.min(
          Math.max(0, desired),
          view.scrollHeight - viewportHeight,
        );
      },
    });
    const canonicalItems = !fits ? turn.items.slice(0, -1) : turn.items;
    const show = (history: boolean, live = false) => (
      <ActivityTranscript
        transcript={{
          ...(!history && { partial: true }),
          turns: [
            history
              ? {
                  ...turn,
                  items: live
                    ? [older, ...canonicalItems, newer]
                    : [older, ...canonicalItems],
                }
              : turn,
          ],
        }}
        agentName="Agent"
        state={() => "working"}
      />
    );
    try {
      const { rerender } = render(show(false), { container: view });
      const timeline = view.firstElementChild;
      const renderedTurn = timeline?.lastElementChild;
      if (!timeline || !renderedTurn)
        throw new Error("Missing transcript turn");
      Object.defineProperty(renderedTurn, "getBoundingClientRect", {
        value: () => new DOMRect(0, -scrollTop, 100, naturalHeight()),
      });
      const rowStarts = [0, rowLengths[0] ?? 0, fits ? 70 : 220];
      for (const [index, entry] of [
        ...renderedTurn.querySelectorAll("[data-entry]"),
      ].entries()) {
        Object.defineProperty(entry, "getBoundingClientRect", {
          value: () =>
            new DOMRect(
              0,
              (rowStarts[index] ?? 0) + prependHeight() - scrollTop,
              100,
              rowLengths[index],
            ),
        });
      }
      const summary = screen.getByText("Middle");
      await userEvent.click(summary);
      expect(screen.getByText("Details")).toBeVisible();
      if (resized) {
        view.scrollTop = 0;
        fireEvent.scroll(view);
        viewportHeight = 150;
      }
      if (!fits) {
        view.scrollTop = 95;
        fireEvent.scroll(view);
        view.scrollTop = 55;
      }

      rerender(show(true));
      expect(view.scrollTop).toBe(expectedTop);
      expect(screen.getByText("Middle")).toBe(summary);
      expect(screen.getByText("Details")).toBeVisible();
      if (!fits) {
        view.dispatchEvent(new Event("scroll"));
        rerender(show(true, true));
        expect(view.scrollTop).toBe(expectedTop);
      }
    } finally {
      view.remove();
    }
  },
);

it.each([
  { promptHeight: 40, expectedAnchor: "item:reading" },
  { promptHeight: 200, expectedAnchor: "turn:reading" },
])(
  "holds $expectedAnchor when the session prompt moves to an older turn",
  ({ promptHeight, expectedAnchor }) => {
    const turn = (id: string, startedAt: number) =>
      ({
        turnId: id,
        startedAt,
        sessionId: "s",
        channelId: null,
        threadRootId: null,
        triggeringEventIds: [],
        newSession: false,
        config: [],
        partial: false,
        items: [{ type: "thought", id, at: startedAt, text: id }],
      }) satisfies TranscriptTurn;
    const reading = turn("reading", 2);
    const show = (history: boolean) => (
      <ActivityTranscript
        agentName="Agent"
        state={() => "ended"}
        transcript={{
          ...(!history && { partial: true }),
          turns: withSessionPrompts(
            history ? [turn("older", 1), reading] : [reading],
            () => [{ label: "base", text: "Instructions" }],
          ),
        }}
      />
    );
    const view = document.body.appendChild(document.createElement("div"));
    view.style.overflowY = "auto";
    Object.defineProperty(view, "clientHeight", { value: 150 });
    const loaded = () => !!view.querySelector('[data-entry="turn:older"]');
    Object.defineProperty(view, "scrollHeight", {
      get: () => (loaded() ? 700 : 500),
    });
    try {
      const { rerender } = render(show(false), { container: view });
      const entry = (id: string) => {
        const el = view.querySelector<HTMLElement>(`[data-entry="${id}"]`);
        if (!el) throw new Error(`Missing entry ${id}`);
        return el;
      };
      const rect = (top: number, height: number) =>
        new DOMRect(0, top - view.scrollTop, 100, height);
      const prompt = entry("item:s:system-prompt");
      prompt.getBoundingClientRect = () => rect(20, promptHeight);
      entry("turn:reading").getBoundingClientRect = () =>
        rect(loaded() ? 340 : 0, 360);
      entry("item:reading").getBoundingClientRect = () =>
        rect(loaded() ? 360 : 20 + promptHeight, 130);
      view.scrollTop = 25;
      fireEvent.scroll(view);
      const anchor = entry(expectedAnchor);
      const offset = anchor.getBoundingClientRect().top;
      rerender(show(true));
      expect(entry("item:s:system-prompt").closest("article")).toBe(
        entry("turn:older"),
      );
      expect(entry(expectedAnchor)).toBe(anchor);
      expect(anchor.getBoundingClientRect().top).toBe(offset);
    } finally {
      view.remove();
    }
  },
);

it("shows the turn a message began, its prompt open, instead of the latest, once", async () => {
  const id = (n: number) => String(n).repeat(64);
  // A retry asks the same message again, so `event` can repeat.
  const turn = (n: number, event = n): TranscriptTurn => ({
    turnId: `t${n}`,
    channelId: "channel",
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: n,
    endedAt: n + 1000,
    partial: false,
    items: [
      {
        id: `p${n}`,
        at: n,
        type: "prompt",
        text: `Prompt ${n}`,
        sections: [
          {
            tag: "buzz-event",
            body: eventBody(
              {
                id: id(event),
                pubkey: "a".repeat(64),
                kind: 9,
                created_at: event,
                content: `Prompt ${n}`,
                tags: [],
              },
              `Prompt ${n}`,
            ),
          },
        ],
        steer: false,
      },
    ],
  });
  const view = document.createElement("div");
  view.style.overflowY = "auto";
  Object.defineProperty(view, "scrollHeight", { get: () => 1000 });
  document.body.appendChild(view);
  const shown: string[] = [];
  const margins: string[] = [];
  Element.prototype.scrollIntoView = function (this: HTMLElement) {
    if (this.dataset.entry === "item:m6") {
      expect(
        this.querySelector("[data-arrival-surface][data-arrived]"),
      ).not.toBeNull();
      expect(this).toHaveTextContent("Details of the linked reply");
    }
    shown.push(this.dataset.entry ?? "");
    margins.push(this.style.scrollMarginBlockStart);
  };
  const done = vi.fn();
  // The panel's sticky header, 40px tall.
  const header = (node: HTMLDivElement | null) => {
    if (node) Object.defineProperty(node, "offsetHeight", { value: 40 });
  };
  const show = (turns: TranscriptTurn[], events: string[], partial = false) => (
    <TranscriptFocus.Provider value={{ events, inputs: readerInputs(), done }}>
      <div data-transcript>
        <div data-transcript-header ref={header} />
        <ActivityTranscript
          transcript={{ turns, ...(partial && { partial: true }) }}
          agentName="Sol"
          state={() => "ended"}
        />
      </div>
    </TranscriptFocus.Provider>
  );
  try {
    // Not loaded yet: it opens at the latest and waits.
    const { rerender } = render(show([turn(1)], ["reply", id(2)]), {
      container: view,
    });
    expect(view.scrollTop).toBe(1000);
    expect(done).not.toHaveBeenCalled();
    // Focus the menu put back on its trigger, outside the panel, is not the
    // reader's own move.
    const trigger = document.body.appendChild(document.createElement("button"));
    trigger.focus();
    rerender(show([turn(1), turn(2), turn(3)], ["reply", id(2)], true));
    expect(done).not.toHaveBeenCalled();
    expect(shown).toEqual([]);
    rerender(show([turn(1), turn(2), turn(3)], ["reply", id(2)]));
    expect(shown).toEqual(["item:p2"]);
    // It starts below the sticky header, with room for its focus ring, and
    // keeps no margin afterwards.
    expect(margins).toEqual(["calc(40px + var(--space-2))"]);
    expect(
      view.querySelector<HTMLElement>('[data-entry="item:p2"]')?.style
        .scrollMarginBlockStart,
    ).toBe("");
    expect(done).toHaveBeenCalledOnce();
    const prompt = screen.getByText("Prompt 2", { selector: "p" });
    expect(prompt.closest("details")).toHaveAttribute("open");
    // Its text is marked, not its title.
    expect(prompt).toHaveAttribute("data-arrived");
    expect(view.querySelectorAll("[data-arrived]")).toHaveLength(1);
    // Keyboard focus follows it, after the panel's own handoff.
    await act(() => new Promise(requestAnimationFrame));
    expect(
      prompt.closest("details")?.querySelector(":scope > summary"),
    ).toHaveFocus();
    trigger.remove();
    // Once shown, the mark is gone, so the transcript shown again (a hidden
    // pane reopened) does not replay it.
    fireEvent.animationEnd(prompt);
    expect(view.querySelectorAll("[data-arrived]")).toHaveLength(0);
    // New turns no longer pull it to the latest.
    view.scrollTop = 0;
    rerender(show([turn(1), turn(2), turn(3), turn(4)], ["reply", id(2)]));
    expect(view.scrollTop).toBe(0);
    // A retried request shows its latest attempt, the one that answered.
    // Focus the reader has since moved elsewhere stays there.
    const retried = show([turn(1), turn(2), turn(5, 2)], ["retry", id(2)]);
    const elsewhere = document.body.appendChild(
      document.createElement("button"),
    );
    fireEvent.pointerDown(elsewhere);
    elsewhere.focus();
    rerender(retried);
    expect(shown.at(-1)).toBe("item:p5");
    await act(() => new Promise(requestAnimationFrame));
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
    // A reply lands on itself before the prompt it answered, its bubble
    // marked.
    const replied = turn(6);
    rerender(
      show(
        [
          turn(1),
          {
            ...replied,
            items: [
              ...replied.items,
              {
                id: "m6",
                at: 7,
                type: "message",
                text: "Reply 6\n\nDetails of the linked reply",
                messageId: "reply",
              },
            ],
          },
        ],
        ["reply", id(6)],
      ),
    );
    expect(shown.at(-1)).toBe("item:m6");
    expect(
      screen
        .getByText("Reply 6", { selector: "p" })
        .closest("[data-arrival-surface]"),
    ).toHaveAttribute("data-arrived");
    expect(view.querySelectorAll("[data-arrived]")).toHaveLength(1);
    // A reply a script sent lands on the call that ran it.
    const scripted = turn(7);
    rerender(
      show(
        [
          {
            ...scripted,
            items: [
              ...scripted.items,
              {
                id: "x7",
                at: 8,
                type: "tool",
                toolCallId: "x7",
                title: "exec",
                kind: "execute",
                status: "completed",
                input: "",
                output: "",
                diffs: [],
                paths: [],
                truncated: false,
                children: [
                  {
                    id: "s7",
                    at: 9,
                    type: "message",
                    text: "Reply 7",
                    posted: true,
                    messageId: id(8),
                  },
                ],
              },
            ],
          },
        ],
        [id(8), id(7)],
      ),
    );
    expect(shown.at(-1)).toBe("item:x7");
    // The call itself is marked, not the reply recorded inside it.
    const call = view.querySelector('[data-entry="item:x7"] > details');
    expect(call).toHaveProperty("open", true);
    expect(call?.querySelector(":scope > summary")).toHaveAttribute(
      "data-arrived",
    );
    expect(view.querySelectorAll("[data-arrived]")).toHaveLength(1);
  } finally {
    // jsdom has no scrollIntoView of its own.
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    view.remove();
  }
});

it("divides sessions, and shows each one's prompt once at its top", async () => {
  const turn = (
    turnId: string,
    sessionId: string,
    newSession: boolean,
  ): TranscriptTurn => ({
    turnId,
    channelId: "channel",
    threadRootId: null,
    triggeringEventIds: [],
    sessionId,
    newSession,
    config: [],
    startedAt: 1,
    endedAt: 2,
    partial: false,
    items: [],
  });
  const turns = withSessionPrompts(
    [turn("1", "old", false), turn("2", "new", true), turn("3", "new", false)],
    (session) =>
      session === "new"
        ? [
            {
              label: "",
              text: "<agent-instructions>\nBe kind\n</agent-instructions>",
            },
          ]
        : undefined,
  );
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Agent"
      state={() => "ended"}
    />,
  );
  expect(
    screen
      .getAllByText(/^(New session|Session continued)/)
      .map((line) => line.textContent),
  ).toEqual(["Session continued; earlier turns not shown", "New session"]);
  expect(screen.getAllByText(/System prompt/)).toHaveLength(1);
  expect(screen.queryByText("Agent instructions")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText(/System prompt/));
  expect(screen.getByText("Agent instructions")).toBeVisible();
});

it("keeps the conversation readable while disclosing work and showing the current step", async () => {
  const at = Date.UTC(2026, 10, 2, 17);
  const turn: TranscriptTurn = {
    turnId: "turn",
    channelId: null,
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: at,
    partial: false,
    items: [
      {
        id: "prompt",
        at,
        type: "prompt",
        text: "Fix the preview",
        sections: [],
        steer: false,
      },
      { id: "thought", at, type: "thought", text: "Inspecting the renderer" },
      {
        id: "tool",
        at,
        type: "tool",
        toolCallId: "tool",
        title: "Read renderer",
        kind: "read",
        status: "completed",
        input: "renderer.tsx",
        output: "source",
        paths: [],
        diffs: [],
        truncated: false,
      },
      { id: "reply", at, type: "message", text: "Found the layout problem" },
      { id: "latest", at, type: "thought", text: "Applying the fix" },
    ],
  };
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns: [turn] }}
      agentName="Sol"
      state={() => "working"}
    />,
  );
  expect(
    screen.getByText("Fix the preview", { selector: "summary span" }),
  ).toBeVisible();
  expect(
    screen.getByText("Found the layout problem", { selector: "summary span" }),
  ).toBeVisible();
  expect(
    screen
      .getAllByText("Applying the fix")
      .some((element) => !element.closest("[hidden]")),
  ).toBe(true);
  expect(
    screen.getByText("Inspecting the renderer", { selector: "summary span" }),
  ).toBeVisible();
  expect(screen.getByText("renderer")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "2 activity steps" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("source")).not.toBeInTheDocument();
  await user.click(screen.getByText("renderer"));
  expect(screen.getByText("source")).toBeVisible();
  await user.click(screen.getByText("renderer"));
  expect(screen.getByText("source")).not.toBeVisible();
});

it("keeps an expanded thought open at turn end without rereading earlier activity", async () => {
  const turn: TranscriptTurn = {
    turnId: "thought-turn",
    channelId: null,
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: 1,
    partial: false,
    items: [
      {
        id: "thought",
        at: 1,
        type: "thought",
        text: "**Checking the view**\n\nDetails with **formatting**.",
      },
    ],
  };
  const earlierItems: TranscriptTurn["items"] = [
    { id: "previous", at: 1, type: "status", text: "Previous activity" },
  ];
  let earlierReads = 0;
  const earlier: TranscriptTurn = {
    ...turn,
    turnId: "earlier",
    endedAt: 1,
    get items() {
      earlierReads++;
      return earlierItems;
    },
  };
  const user = userEvent.setup();
  const { rerender } = render(
    <ActivityTranscript
      transcript={{ turns: [earlier, turn] }}
      agentName="Agent"
      state={() => "working"}
    />,
  );
  expect(screen.queryByText("formatting")).not.toBeInTheDocument();
  const disclosure = screen
    .getByText("Checking the view", { selector: "summary span" })
    .closest("summary");
  if (!disclosure) throw new Error("Missing thought disclosure");
  await user.click(disclosure);
  expect(screen.getByText("formatting")).toBeVisible();
  expect(screen.getAllByText("Checking the view")).toHaveLength(1);
  expect(screen.getByText("Previous activity")).toBeVisible();
  const readsBeforeStop = earlierReads;
  rerender(
    <ActivityTranscript
      transcript={{ turns: [earlier, { ...turn, endedAt: 2 }] }}
      agentName="Agent"
      state={() => "ended"}
    />,
  );
  expect(screen.queryByText("Working")).not.toBeInTheDocument();
  expect(earlierReads).toBe(readsBeforeStop);
  expect(screen.getByText("formatting")).toBeVisible();
  await user.click(disclosure);
  expect(screen.getByText("formatting")).not.toBeVisible();
});

it("resolves author avatars by identity and falls back when that identity is absent", () => {
  const key = "a".repeat(64);
  const listeners = new Set<() => void>();
  let profiles = new Map([
    [key, { name: "Alex", picture: "https://example.com/alex.png" }],
  ]);
  const ensure = vi.fn(async () => {});
  const directory = {
    snapshot: () => profiles,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
  };
  const connection = { status: "ready", session: { profiles: directory } };
  const relay = { subscribe: () => () => {}, snapshot: () => connection };
  const agents = {
    subscribe: () => () => {},
    relay: () => relay,
  } as unknown as Agents;
  const turn = {
    turnId: "avatar",
    startedAt: 1,
    config: [],
    items: [
      {
        id: "prompt",
        at: 1,
        type: "prompt",
        author: "Alex",
        authorPubkey: key,
        text: "Hello",
        sections: [],
      },
      {
        id: "unknown",
        at: 1,
        type: "prompt",
        author: "Alex",
        text: "Another person",
        sections: [],
      },
    ],
  } as unknown as TranscriptTurn;
  const { container } = render(
    <AgentsContext.Provider value={agents}>
      <ActivityTranscript
        agentKey="agent"
        agentName="Agent"
        transcript={{ turns: [turn] }}
        state={() => "ended"}
      />
    </AgentsContext.Provider>,
  );
  expect(ensure).toHaveBeenCalledWith([key], "background");
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.com/alex.png",
  );
  act(() => {
    profiles = new Map();
    for (const listener of listeners) listener();
  });
  expect(container.querySelector("img")).toBeNull();
});
