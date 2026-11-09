// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import { createProfileDirectory } from "../../features/relay/profile-directory";
import { createRelayReader } from "../../features/relay/reader";
import {
  flush,
  keypair,
  profile,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import {
  CANVAS_DIFF_EDIT_LENGTH,
  CANVAS_DIFF_TIMEOUT_MS,
  canvasDiffRows,
} from "./CanvasDiff";
import { CanvasHistory } from "./CanvasHistory";

afterEach(cleanup);

it.each([
  [false, 1],
  [true, 0],
] as const)(
  "after an access purge, a read-only history (%s) rereads %i author reads",
  async (readOnly, rereads) => {
    const author = keypair();
    const revision = signed(author, {
      kind: 40100,
      content: "Saved",
      tags: [["h", "x"]],
    });
    const canvas = {
      history: vi
        .fn()
        .mockResolvedValue({ revisions: [revision], next: undefined }),
    } as unknown as ChannelCanvas;
    const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
    const reader = createRelayReader(wire.transport);
    const directory = createProfileDirectory(reader.reader);
    const show = (readOnly: boolean) => (
      <CanvasHistory
        canvas={canvas}
        channelId="x"
        profiles={directory.queries}
        head={revision}
        busy={false}
        loaded
        dirty={false}
        readOnly={readOnly}
        refreshHead={async () => {}}
        retryHead={() => {}}
        restore={async () => {}}
      />
    );
    try {
      const view = render(show(false));
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      wire.next().respond([profile(author, { name: "Author" })]);
      expect(await screen.findAllByText(/Author/)).not.toHaveLength(0);

      // Losing the channel leaves its history mounted read-only, then purges.
      view.rerender(show(readOnly));
      act(() => directory.clear());
      await act(flush);
      expect(wire.pending).toHaveLength(rereads);
    } finally {
      cleanup();
      directory.dispose();
      reader.dispose();
    }
  },
);

const radio = (index: number) =>
  screen.getAllByRole("radio")[index] as HTMLElement;
const author = keypair();
const revision = (content: string, created_at = 1700000000) =>
  signed(author, { kind: 40100, content, tags: [["h", "x"]], created_at });

function mount(
  history: ReturnType<typeof vi.fn>,
  head: ReturnType<typeof revision> | undefined,
) {
  const canvas = { available: true, history } as unknown as ChannelCanvas;
  const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  render(
    <CanvasHistory
      canvas={canvas}
      channelId="x"
      profiles={directory.queries}
      head={head}
      busy={false}
      loaded
      dirty={false}
      refreshHead={async () => {}}
      retryHead={() => {}}
      restore={async () => {}}
    />,
  );
  return () => {
    cleanup();
    directory.dispose();
    reader.dispose();
  };
}

const lines = () =>
  [
    ...screen
      .getByRole("region", { name: "Changes from current version" })
      .querySelectorAll("[data-change], div:not([data-change])"),
  ].map((row) =>
    [...row.childNodes]
      .filter((node) => !(node as Element).classList?.contains("sr-only"))
      .map((node) => node.textContent)
      .join(""),
  );

const diff = () =>
  screen.getByRole("region", { name: "Changes from current version" });

it("diffs a revision against the current Canvas, with markers and collapsed context", async () => {
  const older = revision(
    ["a", "b", "c", "d", "e", "F", "g", "h", "i", "j"].join("\n"),
    1,
  );
  const current = revision(
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n"),
    2,
  );
  const dispose = mount(
    vi.fn().mockResolvedValue({ revisions: [current, older], next: undefined }),
    current,
  );
  try {
    expect(await screen.findByText("Same as current version.")).toBeVisible();
    act(() => radio(1).click());
    expect(diff()).toBeVisible();
    expect(lines()).toEqual([
      "⋯ 2 unchanged lines",
      " c",
      " d",
      " e",
      "−f",
      "+F",
      " g",
      " h",
      " i",
      " j",
    ]);
    expect(screen.getAllByText("Removed:")).toHaveLength(1);
    expect(screen.getAllByText("Added:")).toHaveLength(1);
    act(() =>
      screen.getByRole("checkbox", { name: "Show full content" }).click(),
    );
    expect(screen.getByLabelText("Revision Markdown")).toHaveValue(
      older.content,
    );
  } finally {
    dispose();
  }
});

it("diffs empty revisions and an empty current Canvas, and treats identical content as current", async () => {
  const empty = revision("", 1);
  const same = revision("x\ny", 2);
  const current = revision("x\ny", 3);
  const dispose = mount(
    vi.fn().mockResolvedValue({
      revisions: [current, same, empty],
      next: undefined,
    }),
    current,
  );
  try {
    await screen.findAllByRole("radio");
    act(() => radio(1).click());
    expect(screen.getByText("Same as current version.")).toBeVisible();
    act(() => radio(2).click());
    expect(lines()).toEqual(["−x", "−y"]);
    expect(screen.getByText("This version is empty.")).toBeVisible();
  } finally {
    dispose();
  }
  const dispose2 = mount(
    vi.fn().mockResolvedValue({ revisions: [empty, same], next: undefined }),
    empty,
  );
  try {
    await screen.findAllByRole("radio");
    act(() => radio(1).click());
    expect(lines()).toEqual(["+x", "+y"]);
  } finally {
    dispose2();
  }
});

it("shows full content when a comparison exceeds its bounds", async () => {
  const many = (prefix: string) =>
    Array.from({ length: 5001 }, (_, i) => `${prefix}${i}`).join("\n");
  const current = revision(many("b"), 2);
  const dispose = mount(
    vi.fn().mockResolvedValue({
      revisions: [current, revision(many("a"), 1)],
      next: undefined,
    }),
    current,
  );
  try {
    await screen.findAllByRole("radio");
    act(() => radio(1).click());
    expect(
      screen.getByText("Comparison too large; showing full content."),
    ).toBeVisible();
    expect(screen.getByLabelText("Revision Markdown")).toHaveValue(many("a"));
  } finally {
    dispose();
  }
});

it("falls back when a comparison exceeds the edit-length bound", () => {
  const side = (prefix: string) =>
    Array.from(
      { length: CANVAS_DIFF_EDIT_LENGTH },
      (_, i) => `${prefix}${i}`,
    ).join("\n");
  // A fixed clock keeps the time bound from also tripping on this fixture.
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    expect(canvasDiffRows(side("a"), side("a"))).toBeDefined();
    expect(canvasDiffRows("a\nb", "a\nc")).toBeDefined();
    expect(canvasDiffRows(side("a"), side("b"))).toBeUndefined();
  } finally {
    now.mockRestore();
  }
});

it("falls back when a comparison exceeds its time bound", () => {
  const now = vi.spyOn(Date, "now");
  let clock = 0;
  now.mockImplementation(() => (clock += CANVAS_DIFF_TIMEOUT_MS));
  try {
    expect(canvasDiffRows("a\nb\nc", "x\nb\ny")).toBeUndefined();
  } finally {
    now.mockRestore();
  }
  expect(canvasDiffRows("a\nb\nc", "x\nb\ny")).toBeDefined();
});

it("never compares against a current Canvas that could not be read", async () => {
  const older = revision("Plan", 1);
  const history = vi
    .fn()
    .mockResolvedValue({ revisions: [older], next: undefined });
  const canvas = { available: true, history } as unknown as ChannelCanvas;
  const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const retryHead = vi.fn();
  const show = (
    loaded: boolean,
    head: ReturnType<typeof revision> | undefined,
    busy = false,
  ) => (
    <CanvasHistory
      canvas={canvas}
      channelId="x"
      profiles={directory.queries}
      head={head}
      busy={busy}
      loaded={loaded}
      dirty={false}
      refreshHead={async () => {}}
      retryHead={retryHead}
      restore={async () => {}}
    />
  );
  try {
    const view = render(show(false, undefined));
    expect(
      await screen.findByText(/current Canvas could not be read/),
    ).toBeVisible();
    expect(screen.getByLabelText("Revision Markdown")).toHaveValue("Plan");
    expect(screen.queryByText("Same as current version.")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Changes from current version" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
    act(() => screen.getByRole("button", { name: "Retry" }).click());
    expect(retryHead).toHaveBeenCalledTimes(1);
    // A retry of a known failure is pending, and keeps its failure feedback.
    view.rerender(show(false, undefined, true));
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveAttribute("aria-busy", "true");
    expect(retry.closest("[aria-busy]:not(button)")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    view.rerender(show(false, undefined));
    // The read failure stays visible when showing full content.
    act(() =>
      screen.getByRole("checkbox", { name: "Show full content" }).click(),
    );
    expect(screen.getByText(/current Canvas could not be read/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.getByLabelText("Revision Markdown")).toHaveValue("Plan");
    act(() =>
      screen.getByRole("checkbox", { name: "Show full content" }).click(),
    );
    // Recovered: a genuinely absent head compares against empty.
    view.rerender(show(true, undefined));
    expect(lines()).toEqual(["+Plan"]);
    expect(screen.queryByText(/could not be read/)).toBeNull();
  } finally {
    cleanup();
    directory.dispose();
    reader.dispose();
  }
});
