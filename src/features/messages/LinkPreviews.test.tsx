// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type {
  ContributionReader,
  LinkPreviewProps,
  LinkPreviewRenderer,
} from "../conversation/contracts";
import { TargetOpenerProvider } from "../conversation/opener";
import { LinkPreviews } from "./LinkPreviews";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function entry(
  id: string,
  matches: (url: string) => boolean,
  order: number,
  component: LinkPreviewRenderer["component"],
): Contribution<LinkPreviewRenderer> {
  return {
    id,
    title: id,
    matches,
    order,
    component,
    key: id,
    pluginId: id,
    revision: "1",
  } as unknown as Contribution<LinkPreviewRenderer>;
}
const reader = (
  entries: Contribution<LinkPreviewRenderer>[],
): ContributionReader<LinkPreviewRenderer> => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const card =
  (label: string) =>
  ({ url, open }: LinkPreviewProps) => (
    <button type="button" onClick={open}>
      {label} {url}
    </button>
  );

it("lets the lowest order claim a link ahead of the default card", () => {
  const registry = reader([
    entry("web", () => true, 100, card("web")),
    entry("special", (url) => url.includes("special"), 0, card("special")),
  ]);
  render(
    <LinkPreviews
      urls={["https://a.example/", "https://special.example/"]}
      messageId="m"
      registry={registry}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByText("web https://a.example/")).toBeTruthy();
  expect(screen.getByText("special https://special.example/")).toBeTruthy();
  expect(screen.queryByText("web https://special.example/")).toBeNull();
});

it("folds past three cards and opens links through the host", () => {
  const onOpenLink = vi.fn(() => true);
  const urls = [1, 2, 3, 4, 5].map((n) => `https://${n}.example/`);
  render(
    <LinkPreviews
      urls={urls}
      messageId="m"
      registry={reader([entry("web", () => true, 100, card("web"))])}
      onOpenLink={onOpenLink}
    />,
  );
  expect(screen.getAllByRole("button", { name: /^web/ })).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Show 2 more previews" }));
  expect(screen.getAllByRole("button", { name: /^web/ })).toHaveLength(5);
  fireEvent.click(
    screen.getByRole("button", { name: "web https://5.example/" }),
  );
  expect(onOpenLink).toHaveBeenCalledWith("https://5.example/");
  fireEvent.click(screen.getByRole("button", { name: "Show fewer previews" }));
  expect(screen.getAllByRole("button", { name: /^web/ })).toHaveLength(3);
});

it("lets a card open its plugin's own target while its link opens as before", () => {
  const onOpenLink = vi.fn(() => true);
  const openTarget = vi.fn(() => true);
  const Card = ({ url, open, opener }: LinkPreviewProps) => (
    <>
      <button type="button" onClick={() => open()}>
        Link {url}
      </button>
      <button
        type="button"
        disabled={!opener?.canOpen("example-panel:item/7")}
        onClick={() => opener?.open("example-panel:item/7")}
      >
        Open panel
      </button>
    </>
  );
  render(
    <TargetOpenerProvider
      canOpen={(target) => target.startsWith("example-panel:")}
      open={openTarget}
    >
      <LinkPreviews
        urls={["https://item.example/7"]}
        messageId="m"
        registry={reader([entry("item", () => true, 0, Card)])}
        onOpenLink={onOpenLink}
      />
    </TargetOpenerProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open panel" }));
  expect(openTarget).toHaveBeenCalledWith("example-panel:item/7");
  expect(onOpenLink).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Link https://item.example/7" }),
  );
  expect(onOpenLink).toHaveBeenCalledWith("https://item.example/7");
  expect(openTarget).toHaveBeenCalledTimes(1);
});

it("closes a card's opener once its contribution is removed or outside a conversation", () => {
  const results: boolean[] = [];
  const Card = ({ opener }: LinkPreviewProps) => (
    <button
      type="button"
      onClick={() =>
        results.push(opener?.open("example-panel:item/7") ?? false)
      }
    >
      Open panel
    </button>
  );
  const openTarget = vi.fn(() => true);
  const live = [entry("item", () => true, 0, Card)];
  const { unmount } = render(
    <TargetOpenerProvider canOpen={() => true} open={openTarget}>
      <LinkPreviews
        urls={["https://item.example/7"]}
        messageId="m"
        registry={reader(live)}
        onOpenLink={() => true}
      />
    </TargetOpenerProvider>,
  );
  const button = screen.getByRole("button", { name: "Open panel" });
  fireEvent.click(button);
  live.length = 0;
  fireEvent.click(button);
  expect(results).toEqual([true, false]);
  expect(openTarget).toHaveBeenCalledTimes(1);
  unmount();

  render(
    <LinkPreviews
      urls={["https://item.example/7"]}
      messageId="m"
      registry={reader([entry("item", () => true, 0, Card)])}
      onOpenLink={() => true}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open panel" }));
  expect(results).toEqual([true, false, false]);
});

it("drops a card whose renderer throws and keeps the rest", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const Broken = () => {
    throw new Error("broken");
  };
  render(
    <LinkPreviews
      urls={["https://broken.example/", "https://ok.example/"]}
      messageId="m"
      registry={reader([
        entry("broken", (url) => url.includes("broken"), 0, Broken),
        entry("web", () => true, 100, card("web")),
      ])}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByText("web https://ok.example/")).toBeTruthy();
});

function provider(initial: "checking" | "ready" | "needs-setup") {
  let status = initial;
  const listeners = new Set<() => void>();
  return {
    status: vi.fn(() => status),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    set(next: typeof status) {
      status = next;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

function settingsWith(
  open: (section: string) => void = () => {},
  sections: string[] = ["tracker/setup"],
) {
  const listeners = new Set<() => void>();
  return {
    has: (section: string) => sections.includes(section),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open,
    add(section: string) {
      sections.push(section);
      for (const listener of [...listeners]) listener();
    },
  };
}

function withStatus(
  base: Contribution<LinkPreviewRenderer>,
  state: ReturnType<typeof provider>,
): Contribution<LinkPreviewRenderer> {
  return {
    ...base,
    title: "Tracker",
    status: state.status,
    subscribe: state.subscribe,
    settings: "setup",
  } as Contribution<LinkPreviewRenderer>;
}

it("draws a setup card that opens the plugin's Settings card while a renderer needs setup", () => {
  const state = provider("needs-setup");
  const Card = vi.fn(card("tracker"));
  const onOpenSettings = vi.fn();
  const onOpenLink = vi.fn(() => true);
  render(
    <LinkPreviews
      urls={["https://tracker.example/1", "https://tracker.example/2"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, Card),
          state,
        ),
      ])}
      onOpenLink={onOpenLink}
      settings={settingsWith(onOpenSettings)}
    />,
  );
  const setups = screen.getAllByRole("button", {
    name: "Set up Tracker for previews tracker.example · Open Settings",
  });
  expect(setups).toHaveLength(2);
  expect(Card).not.toHaveBeenCalled();
  expect(state.subscribe).toHaveBeenCalledTimes(1);
  const [firstSetup] = setups;
  if (!firstSetup) throw new Error("missing setup button");
  fireEvent.click(firstSetup);
  expect(onOpenSettings).toHaveBeenCalledWith("tracker/setup");
  expect(onOpenLink).not.toHaveBeenCalled();
});

it("swaps every card from a renderer once it reports ready, and draws none while checking", () => {
  const state = provider("checking");
  render(
    <LinkPreviews
      urls={["https://tracker.example/1", "https://tracker.example/2"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, card("tracker")),
          state,
        ),
      ])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  act(() => state.set("needs-setup"));
  expect(
    screen.getAllByRole("button", { name: /^Set up Tracker/ }),
  ).toHaveLength(2);
  act(() => state.set("ready"));
  expect(screen.queryAllByRole("button", { name: /^Set up/ })).toHaveLength(0);
  expect(screen.getByText("tracker https://tracker.example/1")).toBeTruthy();
  expect(screen.getByText("tracker https://tracker.example/2")).toBeTruthy();
});

it("draws no setup card where the host cannot open Settings", () => {
  const state = provider("needs-setup");
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, card("tracker")),
          state,
        ),
      ])}
      onOpenLink={() => true}
    />,
  );
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});

it("ignores a retired registration's updates and stops listening when its cards unmount", () => {
  const state = provider("needs-setup");
  const onOpenSettings = vi.fn();
  const live = [
    withStatus(
      entry("tracker", () => true, 0, card("t")),
      state,
    ),
  ];
  const { unmount } = render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader(live)}
      onOpenLink={() => true}
      settings={settingsWith(onOpenSettings)}
    />,
  );
  const setup = screen.getByRole("button", { name: /^Set up Tracker/ });
  live.length = 0;
  fireEvent.click(setup);
  expect(onOpenSettings).not.toHaveBeenCalled();
  const reads = state.status.mock.calls.length;
  act(() => state.set("ready"));
  expect(state.status.mock.calls.length).toBe(reads);
  unmount();
  expect(state.listeners.size).toBe(0);
});

it("treats a status that throws as ready", () => {
  const base = entry("tracker", () => true, 0, card("tracker"));
  const throwing = {
    ...base,
    status: () => {
      throw new Error("broken");
    },
    subscribe: () => () => {},
    settings: "setup",
  } as unknown as Contribution<LinkPreviewRenderer>;
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([throwing])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  expect(screen.getByText("tracker https://tracker.example/1")).toBeTruthy();
});

it("folds only the links that draw, and keeps folded links' status live", () => {
  const state = provider("checking");
  const urls = [1, 2, 3, 4].map((n) => `https://tracker.example/${n}`);
  render(
    <LinkPreviews
      urls={[...urls, "https://web.example/"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", (url) => url.includes("tracker"), 0, card("t")),
          state,
        ),
        entry("web", () => true, 100, card("web")),
      ])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  expect(screen.getByText("web https://web.example/")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /more preview/ })).toBeNull();
  act(() => state.set("needs-setup"));
  expect(
    screen.getAllByRole("button", { name: /^Set up Tracker/ }),
  ).toHaveLength(3);
  expect(screen.queryByText("web https://web.example/")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 2 more previews" }));
  act(() => state.set("checking"));
  expect(screen.queryAllByRole("button", { name: /^Set up/ })).toHaveLength(0);
  expect(screen.getByText("web https://web.example/")).toBeTruthy();
});

it("draws the setup card again after a ready preview failed to render", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const state = provider("ready");
  const Broken = () => {
    throw new Error("broken");
  };
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, Broken),
          state,
        ),
      ])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  act(() => state.set("needs-setup"));
  expect(
    screen.getAllByRole("button", { name: /^Set up Tracker/ }),
  ).toHaveLength(1);
});

it("mounts no preview on a status read before its subscription", () => {
  const state = provider("ready");
  state.subscribe.mockImplementation((listener: () => void) => {
    state.set("needs-setup");
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  });
  const Card = vi.fn(card("tracker"));
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, Card),
          state,
        ),
      ])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  expect(Card).not.toHaveBeenCalled();
  expect(
    screen.getAllByRole("button", { name: /^Set up Tracker/ }),
  ).toHaveLength(1);
});

it("does not subscribe to a registration that left before its cards mounted", () => {
  const state = provider("needs-setup");
  const retired = withStatus(
    entry("tracker", () => true, 0, card("t")),
    state,
  );
  const registry: ContributionReader<LinkPreviewRenderer> = {
    snapshot: vi
      .fn<() => readonly Contribution<LinkPreviewRenderer>[]>()
      .mockReturnValueOnce([retired])
      .mockReturnValue([]),
    subscribe: () => () => {},
  };
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={registry}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  expect(state.subscribe).not.toHaveBeenCalled();
});

it("draws previews when a provider's subscribe throws, and tries again on the next mount", () => {
  const state = provider("checking");
  state.subscribe.mockImplementationOnce(() => {
    throw new Error("broken");
  });
  const registry = reader([
    withStatus(
      entry("tracker", () => true, 0, card("tracker")),
      state,
    ),
  ]);
  const view = (
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={registry}
      onOpenLink={() => true}
      settings={settingsWith()}
    />
  );
  const { unmount } = render(view);
  expect(screen.getByText("tracker https://tracker.example/1")).toBeTruthy();
  unmount();
  render(view);
  expect(state.subscribe).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("tracker https://tracker.example/1")).toBeNull();
  act(() => state.set("ready"));
  expect(screen.getByText("tracker https://tracker.example/1")).toBeTruthy();
});

it("offers setup only once the plugin's Settings card is registered", () => {
  const state = provider("needs-setup");
  const settings = settingsWith(() => {}, []);
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, card("t")),
          state,
        ),
      ])}
      onOpenLink={() => true}
      settings={settings}
    />,
  );
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  act(() => settings.add("other/setup"));
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  act(() => settings.add("tracker/setup"));
  expect(
    screen.getAllByRole("button", { name: /^Set up Tracker/ }),
  ).toHaveLength(1);
});

it("keeps keyboard focus in the message when a focused setup card goes away", () => {
  const state = provider("needs-setup");
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, card("tracker")),
          state,
        ),
      ])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  screen.getByRole("button", { name: /^Set up Tracker/ }).focus();
  act(() => state.set("checking"));
  expect(document.activeElement).toBe(
    screen.getByRole("group", { name: "Link previews" }),
  );
  act(() => state.set("needs-setup"));
  screen.getByRole("button", { name: /^Set up Tracker/ }).focus();
  act(() => state.set("ready"));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "tracker https://tracker.example/1" }),
  );
});

it("moves focus to another setup card when the focused one's renderer is ready", () => {
  const tracker = provider("needs-setup");
  const other = provider("needs-setup");
  const otherEntry = {
    ...withStatus(
      entry("other", (url) => url.includes("other"), 0, card("other")),
      other,
    ),
    title: "Other",
  } as Contribution<LinkPreviewRenderer>;
  render(
    <LinkPreviews
      urls={["https://tracker.example/1", "https://other.example/1"]}
      messageId="m"
      registry={reader([
        otherEntry,
        withStatus(
          entry("tracker", (url) => url.includes("tracker"), 1, card("t")),
          tracker,
        ),
      ])}
      onOpenLink={() => true}
      settings={settingsWith(() => {}, ["tracker/setup", "other/setup"])}
    />,
  );
  screen.getByRole("button", { name: /^Set up Tracker/ }).focus();
  act(() => tracker.set("checking"));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /^Set up Other/ }),
  );
});

it("focuses the labelled previews group when a ready preview has nothing to focus", () => {
  const state = provider("needs-setup");
  const Plain = ({ url }: LinkPreviewProps) => <p>Preview {url}</p>;
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, Plain),
          state,
        ),
      ])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  screen.getByRole("button", { name: /^Set up Tracker/ }).focus();
  act(() => state.set("ready"));
  expect(screen.getByText("Preview https://tracker.example/1")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("group", { name: "Link previews" }),
  );
});

it("skips hidden, inert and aria-hidden controls when a focused setup card becomes a ready preview", () => {
  const state = provider("needs-setup");
  const Hidden = ({ url }: LinkPreviewProps) => (
    <div>
      <a href={url} hidden>
        Hidden {url}
      </a>
      <span style={{ display: "none" }}>
        <button type="button">Collapsed</button>
      </span>
      <a href={url} style={{ visibility: "hidden" }}>
        Invisible {url}
      </a>
      <div inert>
        <button type="button">Inert</button>
      </div>
      <div aria-hidden="true">
        <button type="button">Unexposed</button>
      </div>
      <button type="button">Open {url}</button>
    </div>
  );
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, Hidden),
          state,
        ),
      ])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  screen.getByRole("button", { name: /^Set up Tracker/ }).focus();
  act(() => state.set("ready"));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Open https://tracker.example/1" }),
  );
});

it("focuses the labelled previews group when a ready preview's only control is hidden", () => {
  const state = provider("needs-setup");
  const Hidden = ({ url }: LinkPreviewProps) => (
    <p>
      Preview {url}
      <a href={url} hidden>
        Hidden
      </a>
    </p>
  );
  render(
    <LinkPreviews
      urls={["https://tracker.example/1"]}
      messageId="m"
      registry={reader([
        withStatus(
          entry("tracker", () => true, 0, Hidden),
          state,
        ),
      ])}
      onOpenLink={() => true}
      settings={settingsWith()}
    />,
  );
  screen.getByRole("button", { name: /^Set up Tracker/ }).focus();
  act(() => state.set("ready"));
  expect(document.activeElement).toBe(
    screen.getByRole("group", { name: "Link previews" }),
  );
  expect(document.activeElement).not.toBe(document.body);
});
