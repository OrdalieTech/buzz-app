// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState, useSyncExternalStore } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { queryEvents } from "../../../tests/fixtures/finder-data";
import { createRelaySession } from "../../features/relay/session";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import {
  keypair,
  message,
  metadata,
  roster,
} from "../../features/relay/testing";
import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
import { createCorpus } from "./corpus";
import { FinderDialog, type FinderScope } from "./FinderDialog";
import { startFinderSync } from "./sync";

const stops: (() => void)[] = [];
beforeEach(() => {
  // These tests cover semantic state. Browser inspection covers preview geometry.
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
});
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function fixture() {
  const viewer = keypair(),
    relay = keypair(),
    author = keypair();
  const root = message(author, "crew", "Release planning", 1_700_000_000);
  const events: RelayEvent[] = [
    root,
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey, author.pubkey]),
    metadata(relay, "public", "public", 1_700_000_000, [
      ["public"],
      ["t", "stream"],
    ]),
    message(author, "crew", "API release", Math.floor(Date.now() / 1000) - 10, [
      ["e", root.id, "", "reply"],
    ]),
    message(author, "crew", "api draft", 1_700_000_020),
    message(author, "public", "api public notes", 1_700_000_030),
  ];
  const reads: ReadFilter[] = [];
  const control: {
    hold?: Promise<void>;
    fail?: boolean;
    signal?: AbortSignal;
  } = {};
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    async query(filters, signal) {
      if (
        filters.some(
          (filter) =>
            filter.search !== undefined ||
            (filter["#h"]?.includes("crew") && filter.kinds?.includes(9)),
        )
      ) {
        reads.push(...filters);
        if (signal) control.signal = signal;
        await control.hold;
        if (control.fail) throw new Error("Search unavailable");
      }
      return queryEvents(events, filters);
    },
  });
  stops.push(owner.dispose);
  await owner.session.channels.ensureList();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  // Revisions as the plugin counts them: one per index change.
  let revisions = 0;
  const watchers = new Set<() => void>();
  const sync = startFinderSync({
    session: owner.session,
    corpus,
    changed() {
      revisions++;
      for (const watcher of watchers) watcher();
    },
  });
  const useRevision = () =>
    useSyncExternalStore(
      (watcher) => {
        watchers.add(watcher);
        return () => watchers.delete(watcher);
      },
      () => revisions,
    );
  stops.push(sync.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sync.status().phase).toBe("ready");
  reads.length = 0;
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    corpus,
    revision: 0,
    session: owner.session,
    sync,
    openMessage: vi.fn(),
  };
  function Finder({
    initial = "buzz",
    open = true,
  }: {
    initial?: FinderScope;
    open?: boolean;
  }) {
    const [scope, setScope] = useState<FinderScope>(initial);
    const revision = useRevision();
    return (
      <FinderDialog
        {...props}
        open={open}
        revision={revision}
        currentChannelId="crew"
        scope={scope}
        onScopeChange={setScope}
      />
    );
  }
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const click = async (element: HTMLElement) => {
    const clicked = user.click(element);
    // RTL drains its async wrapper on a zero-delay timer too.
    await vi.advanceTimersByTimeAsync(0);
    await clicked;
  };
  return { props, Finder, click, reads, control, corpus, events, root };
}
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const type = (value: string) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value } });

const options = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("option")
    .map((row) => row.textContent);
const local = (id: string, text: string) => ({
  id,
  channelId: "crew",
  authorId: "x",
  createdAt: 1_700_000_100,
  author: "Sam",
  place: "#crew",
  text,
});

test("All of Buzz shows device matches at once, then relay hits below them, asking once per pause", async () => {
  const { Finder, reads, corpus } = await fixture();
  corpus.add([local("here", "api notes from this device")]);
  render(
    <StrictMode>
      <Finder />
    </StrictMode>,
  );
  for (const value of ["ap", "api de", "🚀a"]) {
    type(value);
    await tick(SEARCH_DEBOUNCE_MS);
    expect(reads).toHaveLength(0);
  }
  type("apix");
  await tick(SEARCH_DEBOUNCE_MS - 1);
  type("api");
  expect(options("Matches")).toEqual([
    expect.stringContaining("api notes from this device"),
  ]);
  const highlighted = () =>
    screen.getByRole("combobox").getAttribute("aria-activedescendant");
  const first = highlighted();
  await tick(SEARCH_DEBOUNCE_MS - 1);
  expect(reads).toHaveLength(0);
  await tick(1);
  expect(reads).toHaveLength(1);
  // The recent hit also reached the index, as relay events do in the app.
  expect(corpus.search("release").total).toBe(1);
  // Relay hits arrive below; the device row and the highlight stay put.
  expect(options("Matches")).toEqual([
    expect.stringContaining("api notes from this device"),
  ]);
  expect(options("More from all of Buzz")).toEqual([
    expect.stringContaining("API release"),
    expect.stringContaining("api public notes"),
    expect.stringContaining("api draft"),
  ]);
  expect(highlighted()).toBe(first);
  await tick(1000);
  expect(reads).toHaveLength(1);
});

test("asks the relay even when a full page of device matches has every word apart", async () => {
  const { Finder, reads, corpus } = await fixture();
  corpus.add(
    Array.from({ length: 50 }, (_, n) =>
      local(`d${n}`, `api unrelated unrelated draft ${n}`),
    ),
  );
  render(<Finder />);
  type("api draft");
  await tick(SEARCH_DEBOUNCE_MS);
  expect(reads).toHaveLength(1);
  // The exact phrase, older than the index, would outrank every device row.
  expect(options("More from all of Buzz")).toEqual([
    expect.stringContaining("api draft"),
  ]);
});

test("adds relay hits to the index on close, keeps public previews out, and drops the previous text's hits while the next loads", async () => {
  const { Finder, control, corpus, root, props } = await fixture();
  const view = render(<Finder />);
  type("API");
  await tick(SEARCH_DEBOUNCE_MS);
  const relayed = () =>
    within(screen.getByRole("group", { name: "More from all of Buzz" }))
      .queryAllByRole("option")
      .map((row) => row.textContent);
  expect(relayed()).toHaveLength(3);
  let release = () => {};
  control.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    type("missing");
    await tick(SEARCH_DEBOUNCE_MS);
    // "API release" can't be opened while "missing" loads.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(props.openMessage).not.toHaveBeenCalled();
    expect(relayed()).toEqual([]);
    expect(screen.queryByText("Searching Buzz…")).not.toBeInTheDocument();
    await tick(1000);
    expect(screen.getByRole("status")).toHaveTextContent("Searching Buzz…");
    control.fail = true;
    await act(async () => release());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Messages could not load.",
    );
    expect(relayed()).toEqual([]);
    control.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await tick(SEARCH_DEBOUNCE_MS);
    expect(screen.getByText("Nothing more in Buzz.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
  } finally {
    release();
  }
  // The app received these hits, so even one older than 90 days is in.
  expect(corpus.search("draft").total).toBe(1);
  view.rerender(<Finder open={false} />);
  expect(corpus.search("API").hits[0]?.doc.threadRootId).toBe(root.id);
  expect(corpus.search("").hits.map(({ doc }) => doc.channelId)).toEqual([
    "crew",
    "crew",
  ]);
});

test("closing clears the query, and switching scope keeps it", async () => {
  const { Finder, click } = await fixture();
  const view = render(<Finder />);
  type("release");
  await click(screen.getByRole("tab", { name: "This channel" }));
  expect(screen.getByRole("tab", { name: "This channel" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("combobox")).toHaveValue("release");
  view.rerender(<Finder open={false} />);
  view.rerender(<Finder />);
  expect(screen.getByRole("combobox")).toHaveValue("");
});

test("This channel is unavailable outside a conversation", async () => {
  const { props } = await fixture();
  render(<FinderDialog {...props} scope="buzz" onScopeChange={vi.fn()} />);
  expect(screen.getByRole("tab", { name: "This channel" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test.each(["close", "scope", "session"])(
  "cancels a pending channel read on %s and ignores its late result",
  async (action) => {
    const { props, click, control, reads, corpus } = await fixture();
    let release = () => {};
    control.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onScopeChange = vi.fn();
    const view = render(
      <FinderDialog
        {...props}
        currentChannelId="crew"
        scope="channel"
        onScopeChange={onScopeChange}
      />,
    );
    try {
      await tick(0);
      expect(reads).toHaveLength(1);
      const signal = control.signal;
      if (action === "close")
        view.rerender(
          <FinderDialog
            {...props}
            open={false}
            currentChannelId="crew"
            scope="channel"
            onScopeChange={onScopeChange}
          />,
        );
      else if (action === "scope") {
        await click(screen.getByRole("tab", { name: "All of Buzz" }));
        expect(onScopeChange).toHaveBeenCalledWith("buzz");
        view.rerender(
          <FinderDialog
            {...props}
            currentChannelId="crew"
            scope="buzz"
            onScopeChange={onScopeChange}
          />,
        );
      } else {
        props.sync.dispose();
        view.rerender(
          <FinderDialog
            {...props}
            session={undefined}
            sync={undefined}
            currentChannelId="crew"
            scope="channel"
            onScopeChange={onScopeChange}
          />,
        );
      }
      expect(signal?.aborted).toBe(true);
      await act(async () => release());
      await tick(1000);
      expect(reads).toHaveLength(1);
      expect(corpus.size).toBe(0);
    } finally {
      release();
    }
  },
);
