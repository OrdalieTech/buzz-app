// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { createPortal } from "react-dom";
import { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsCardsService } from "../../features/settings/service";
import type { AppServices } from "../services";
import { SearchChoices, type SearchGroup } from "./SearchChoices";
import { useSearchSettings } from "./SearchSettings";
import { GearIcon } from "../../shared/design-system/icons";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function fixture({ enabled = true } = {}) {
  const state = {
    preferences: { enabled, sound: true, notifyWhileViewing: false },
    developmentPaused: false,
  };
  const updatePreferences = vi.fn();
  const notifications = {
    subscribe: () => () => {},
    snapshot: () => state,
    updatePreferences,
  } as unknown as AppServices["notifications"];
  const open = vi.fn().mockResolvedValue({ status: "opened" });
  const navigation = { open } as unknown as AppServices["navigation"];
  const close = vi.fn();
  function Palette({ groups = [] }: { groups?: SearchGroup[] }) {
    const inlineSettings = useSearchSettings({
      query: "sound",
      notifications,
      navigation,
      close,
      openSection: vi.fn(),
    });
    return (
      <SearchChoices
        query="sound"
        onQueryChange={() => {}}
        input={createRef()}
        groups={groups}
        inlineSettings={inlineSettings}
      />
    );
  }
  return { Palette, open, close, updatePreferences, notifications };
}

it("changes the trailing switch inline but opens and highlights the setting from its row", async () => {
  const { Palette, open, close, updatePreferences } = fixture();
  const target = document.createElement("div");
  target.id = "setting-sound";
  target.className = "buzz-preference-row";
  document.body.append(target);
  try {
    render(<Palette />);
    fireEvent.click(screen.getByRole("switch", { name: "Sound" }));
    expect(updatePreferences).toHaveBeenCalledWith({ sound: false });
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Sound"));
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "settings",
      section: "notifications",
    });
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(target).toHaveClass("settings-search-highlight"),
    );
    expect(target).toHaveFocus();
    fireEvent.animationEnd(target);
    expect(target).not.toHaveClass("settings-search-highlight");
  } finally {
    target.remove();
  }
});

it("disables only the switch while Desktop alerts are off, so the row still opens Settings", () => {
  const { Palette, open, close } = fixture({ enabled: false });
  render(<Palette />);
  const row = screen.getByRole("row", { name: "Sound — Notifications" });
  expect(row.querySelector(".buzz-preference-row")).not.toHaveAttribute(
    "data-disabled",
  );
  expect(screen.getByRole("switch", { name: "Sound" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  const input = screen.getByRole("combobox", { name: "Search Buzz" });
  expect(input).toHaveAttribute("aria-activedescendant", row.id);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "notifications",
  });
  expect(close).toHaveBeenCalledOnce();
});

it("retains inline matches and keyboard selection when conversation results arrive", () => {
  const { Palette, open } = fixture();
  const { rerender } = render(<Palette />);
  const input = screen.getByRole("combobox", { name: "Search Buzz" });
  const selected = input.getAttribute("aria-activedescendant");
  rerender(
    <Palette
      groups={[
        {
          label: "Conversations",
          destinations: [
            { key: "sound-chat", label: "Sound", icon: GearIcon, run: vi.fn() },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByRole("switch", { name: "Sound" })).toBeVisible();
  expect(input).toHaveAttribute("aria-activedescendant", selected);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "notifications",
  });
});

it("keeps an exact category ahead of late conversation and message matches", () => {
  const input = createRef<HTMLElement>();
  const plugin: SearchGroup = {
    label: "Plugins",
    destinations: [
      {
        key: "plugin",
        label: "Productivity",
        detail: "Example",
        rank: 2,
        content: <button type="button">Enable Example</button>,
        icon: GearIcon,
        run: vi.fn(),
      },
    ],
  };
  const props = {
    query: "plugins",
    onQueryChange: () => {},
    input,
    inlineSettings: [plugin],
  };
  const { rerender } = render(<SearchChoices {...props} groups={[]} />);
  rerender(
    <SearchChoices
      {...props}
      groups={[
        {
          label: "Channels",
          destinations: [
            {
              key: "chat",
              label: "Plugins discussion",
              icon: GearIcon,
              run: vi.fn(),
            },
          ],
        },
        {
          label: "Most relevant",
          rank: Infinity,
          destinations: [
            { key: "message", label: "plugins", icon: GearIcon, run: vi.fn() },
          ],
        },
      ]}
    />,
  );
  expect(
    screen
      .getAllByRole("rowgroup")
      .map((group) => group.getAttribute("aria-label")),
  ).toEqual(["Plugins", "Channels", "Most relevant"]);
});

it.each(["Enter", "shortcut", "title"])(
  "focuses the plugin switch without saving on %s, reserving writes for its control",
  (action) => {
    const change = vi.fn();
    const state = {
      configuration: {
        status: "ready",
        catalog: {
          plugins: [
            {
              manifest: {
                id: "example",
                name: "Example",
                description: "Example plugin",
              },
              enabled: true,
            },
          ],
        },
      },
      activation: {},
      busy: false,
    };
    const plugins = {
      subscribe: () => () => {},
      snapshot: () => state,
      change,
    } as unknown as AppServices["plugins"];
    function Palette() {
      const groups = useSearchSettings({
        query: "Example",
        plugins,
        navigation: {} as AppServices["navigation"],
        close: vi.fn(),
        openSection: vi.fn(),
      });
      return (
        <SearchChoices
          query="Example"
          onQueryChange={() => {}}
          input={createRef()}
          groups={[]}
          inlineSettings={groups}
        />
      );
    }
    render(<Palette />);
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    if (action === "title") fireEvent.click(screen.getByText("Example"));
    else
      fireEvent.keyDown(
        input,
        action === "Enter"
          ? { key: "Enter" }
          : { key: "1", code: "Digit1", shiftKey: true, ctrlKey: true },
      );
    const toggle = screen.getByRole("switch", { name: "Enable Example" });
    expect(change).not.toHaveBeenCalled();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(change).toHaveBeenCalledWith("disable", "example");
  },
);

it("announces selected rows and lets arrows leave inline switches", () => {
  const { Palette } = fixture();
  render(
    <Palette
      groups={[
        {
          label: "Pages",
          rank: 10,
          destinations: [
            { key: "page", label: "Sound page", icon: GearIcon, run: vi.fn() },
          ],
        },
      ]}
    />,
  );
  const grid = screen.getByRole("grid", { name: "Search results" });
  expect(
    [...grid.children].every(
      (child) => child.getAttribute("role") === "rowgroup",
    ),
  ).toBe(true);
  const row = screen.getByRole("row", { name: "Sound — Notifications" });
  expect(row).toHaveAttribute("aria-selected", "true");
  const input = screen.getByRole("combobox", { name: "Search Buzz" });
  expect(input).toHaveAttribute("aria-activedescendant", row.id);
  const toggle = screen.getByRole("switch", { name: "Sound" });
  toggle.focus();
  fireEvent.keyDown(toggle, { key: "ArrowDown" });
  const page = screen.getByRole("row", { name: "Sound page" });
  expect(page).toHaveFocus();
  expect(page).toHaveAttribute("aria-selected", "true");
  expect(input).toHaveAttribute("aria-activedescendant", page.id);
});

it.each(["buzz.moderation", "buzz.relay-staff"])(
  "gates restricted enablement for %s",
  (id) => {
    const change = vi.fn();
    let access = "checking";
    const state = {
      configuration: {
        status: "ready",
        catalog: {
          plugins: [
            {
              source: "bundled",
              manifest: { id, name: "Restricted", description: "" },
              enabled: false,
            },
          ],
        },
      },
      activation: {},
      busy: false,
    };
    const plugins = {
      subscribe: () => () => {},
      snapshot: () => state,
      change,
    } as unknown as AppServices["plugins"];
    const adminAccess = {
      ensure: vi.fn(),
      subscribe: () => () => {},
      status: () => access,
    } as unknown as AppServices["adminAccess"];
    function Palette() {
      const groups = useSearchSettings({
        query: "Restricted",
        plugins,
        adminAccess,
        navigation: {} as AppServices["navigation"],
        close: vi.fn(),
        openSection: vi.fn(),
      });
      return (
        <SearchChoices
          query="Restricted"
          onQueryChange={() => {}}
          input={createRef()}
          groups={[]}
          inlineSettings={groups}
        />
      );
    }
    const view = render(<Palette />);
    for (const status of ["checking", "denied", "unavailable", "allowed"]) {
      access = status;
      view.rerender(<Palette />);
      const toggle = screen.getByRole("switch", { name: "Enable Restricted" });
      fireEvent.click(toggle);
      if (status !== "allowed") expect(change).not.toHaveBeenCalled();
    }
    expect(change).toHaveBeenCalledExactlyOnceWith("enable", id);
  },
);

it("ignores portaled control clicks while retaining row navigation", () => {
  const run = vi.fn(),
    select = vi.fn();
  render(
    <SearchChoices
      query="Color"
      onQueryChange={() => {}}
      input={createRef()}
      groups={[]}
      inlineSettings={[
        {
          label: "Settings",
          destinations: [
            {
              key: "color",
              label: "Color mode",
              detail: "Appearance",
              icon: GearIcon,
              run,
              content: (
                <>
                  <span>Color mode</span>
                  {createPortal(
                    <div
                      role="option"
                      aria-selected="false"
                      onClick={select}
                      onKeyDown={() => {}}
                      tabIndex={0}
                    >
                      Dark
                    </div>,
                    document.body,
                  )}
                </>
              ),
            },
          ],
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("option", { name: "Dark" }));
  expect(select).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Color mode"));
  expect(run).toHaveBeenCalledOnce();
});

const noCards: ReturnType<AppServices["settingsCards"]["snapshot"]> = [];

function sections({
  selected = "primary",
  cards = {
    subscribe: () => () => {},
    snapshot: () => noCards,
    retainVisibility: () => () => {},
  } as unknown as AppServices["settingsCards"],
  plugins,
  notifications,
}: {
  selected?: string | null;
  cards?: AppServices["settingsCards"];
  plugins?: AppServices["plugins"];
  notifications?: AppServices["notifications"];
} = {}) {
  const client = {
    selected,
    memberships: [{ id: "primary", name: "Primary" }],
  };
  const communities = {
    subscribe: () => () => {},
    snapshot: () => client,
  } as unknown as AppServices["communities"];
  const openSection = vi.fn();
  function Palette({ query }: { query: string }) {
    const inlineSettings = useSearchSettings({
      query,
      settingsCards: cards,
      communities,
      plugins,
      notifications,
      navigation: {} as AppServices["navigation"],
      close: vi.fn(),
      openSection,
    });
    return (
      <SearchChoices
        query={query}
        onQueryChange={() => {}}
        input={createRef()}
        groups={[]}
        inlineSettings={inlineSettings}
      />
    );
  }
  return { Palette, openSection };
}

it.each([
  ["shortcuts", "Shortcuts", "Buzz", "shortcuts"],
  ["identity", "Identity", "Buzz", "identity"],
  ["profile", "Profile", "Community", "profile"],
  ["agent setup", "Agent setup", "Buzz", "agents"],
  ["software updates", "Software updates", "Buzz", "updates"],
])(
  "lists the %s section under Settings and opens it on Enter or click",
  (query, label, group, id) => {
    const { Palette, openSection } = sections();
    render(<Palette query={query} />);
    const row = within(
      screen.getByRole("group", { name: "Settings" }),
    ).getByRole("option");
    expect(row.textContent).toBe(label + group);
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveAttribute("aria-activedescendant", row.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openSection).toHaveBeenCalledExactlyOnceWith(id);
    fireEvent.click(row);
    expect(openSection).toHaveBeenCalledTimes(2);
    expect(openSection).toHaveBeenLastCalledWith(id);
  },
);

it("leads plugin switches with Manage plugins and notification switches with their section", () => {
  const change = vi.fn();
  const state = {
    configuration: {
      status: "ready",
      catalog: {
        plugins: [
          {
            manifest: {
              id: "buzz.profiles",
              name: "Profiles",
              description: "Profile cards",
            },
            enabled: true,
          },
        ],
      },
    },
    activation: {},
    busy: false,
  };
  const plugins = {
    subscribe: () => () => {},
    snapshot: () => state,
    change,
  } as unknown as AppServices["plugins"];
  const { notifications } = fixture();
  const { Palette, openSection } = sections({ plugins, notifications });
  const rows = (group: string) =>
    within(screen.getByRole("rowgroup", { name: group }))
      .getAllByRole("row")
      .map((row) => row.getAttribute("aria-label"));
  const view = render(<Palette query="plugins" />);
  expect(
    screen
      .getAllByRole("rowgroup")
      .map((group) => group.getAttribute("aria-label")),
  ).toEqual(["Settings", "Plugins"]);
  expect(rows("Settings")).toEqual(["Manage plugins — Plugins"]);
  expect(rows("Plugins")[0]).toBe("Profiles — Other");
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
    key: "Enter",
  });
  expect(openSection).toHaveBeenCalledExactlyOnceWith("plugins");
  expect(change).not.toHaveBeenCalled();
  view.rerender(<Palette query="notifications" />);
  expect(rows("Settings")).toEqual([
    "Notifications — Buzz",
    "Sound — Notifications",
    "Notify while viewing — Notifications",
  ]);
});

it("lists only Personal space and app sections without a selected community", () => {
  const cards = [
    { key: "buzz.emoji/custom-emoji", title: "Custom emoji" },
    { key: "buzz.pairing/mobile", title: "Pair mobile", personal: true },
  ].map((card) => ({
    ...card,
    id: card.key.split("/")[1] ?? "",
    pluginId: card.key.split("/")[0] ?? "",
    revision: "one",
    component: () => null,
  }));
  const settingsCards = {
    subscribe: () => () => {},
    snapshot: () => cards,
    retainVisibility: () => () => {},
  } as unknown as AppServices["settingsCards"];
  // Plain rows read as the section label followed by its group.
  const rows = ({ Palette }: ReturnType<typeof sections>, query: string) => {
    const view = render(<Palette query={query} />);
    const names = screen
      .queryAllByRole("option")
      .map((option) => option.textContent);
    view.unmount();
    return names;
  };
  const community = sections({ cards: settingsCards });
  expect(rows(community, "local settings")).toEqual([
    "Local settingsCommunity",
  ]);
  expect(rows(community, "custom emoji")).toEqual(["Custom emojiCommunity"]);
  expect(rows(community, "leave")).toEqual(["Leave or removeCommunity"]);
  const personal = sections({ selected: null, cards: settingsCards });
  expect(rows(personal, "profile")).toEqual(["ProfilePersonal space"]);
  expect(rows(personal, "pair mobile")).toEqual(["Pair mobilePersonal space"]);
  expect(rows(personal, "shortcuts")).toEqual(["ShortcutsBuzz"]);
  for (const query of ["local settings", "custom emoji", "leave"])
    expect(rows(personal, query)).toEqual([]);
});

it("lists a gated admin card only once visible, retaining visibility while open", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const cards = new SettingsCardsService(root);
  let visible = false;
  const listeners = new Set<() => void>();
  const release = vi.fn();
  const ensure = vi.fn(() => release);
  const fiber = root
    .extend({ pluginOwner: { id: "moderation", revision: "one" } })
    .plugin((ctx) => {
      ctx.settingsCards.register({
        id: "membership",
        title: "Membership",
        section: "administration",
        visibility: {
          snapshot: () => visible,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          ensure,
        },
        component: () => null,
      });
    });
  await fiber.await();
  try {
    const { Palette } = sections({ cards });
    const view = render(<Palette query="membership" />);
    expect(ensure).toHaveBeenCalledOnce();
    expect(screen.queryByRole("option")).toBeNull();
    visible = true;
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(screen.getByRole("option").textContent).toBe(
      "MembershipCommunity admin",
    );
    view.unmount();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    await fiber.dispose();
    await root.fiber.dispose();
  }
});

/** The rendered title and subtitle of a ⌘K row, apart from its accessible
 * name, which is stated separately and can drift from what is shown. */
function shown(row: HTMLElement) {
  return [
    row.querySelector(".buzz-preference-row-label")?.textContent,
    row.querySelector(".buzz-preference-row-description")?.textContent,
  ];
}

function namedRows({ developmentPaused = false } = {}) {
  const pluginState = {
    configuration: {
      status: "ready",
      catalog: {
        plugins: [
          {
            manifest: {
              id: "example.reminders",
              name: "Reminders",
              description: "Reminder messages",
              discovery: { category: "productivity" },
            },
            enabled: true,
          },
          {
            manifest: {
              id: "buzz.channels",
              name: "Channels",
              description: "Channel conversations",
              discovery: { category: "communication" },
            },
            enabled: true,
          },
        ],
      },
    },
    activation: {},
    busy: false,
  };
  const plugins = {
    subscribe: () => () => {},
    snapshot: () => pluginState,
    change: vi.fn(),
  } as unknown as AppServices["plugins"];
  const appearanceState = { preference: "system" };
  const appearance = {
    subscribe: () => () => {},
    snapshot: () => appearanceState,
    setMode: vi.fn(),
  } as unknown as AppServices["appearance"];
  const notificationState = {
    preferences: { enabled: true, sound: true, notifyWhileViewing: false },
    developmentPaused,
  };
  const notifications = {
    subscribe: () => () => {},
    snapshot: () => notificationState,
    updatePreferences: vi.fn(),
  } as unknown as AppServices["notifications"];
  return function Palette({ query }: { query: string }) {
    const inlineSettings = useSearchSettings({
      query,
      plugins,
      appearance,
      notifications,
      navigation: {} as AppServices["navigation"],
      close: vi.fn(),
      openSection: vi.fn(),
    });
    return (
      <SearchChoices
        query={query}
        onQueryChange={() => {}}
        input={createRef()}
        groups={[]}
        inlineSettings={inlineSettings}
      />
    );
  };
}

it.each([
  ["reminders", "Reminders — Productivity", "Reminders", "Productivity"],
  ["channels", "Channels — Communication", "Channels", "Communication"],
  ["color mode", "Color mode — Appearance", "Color mode", "Appearance"],
  ["sound", "Sound — Notifications", "Sound", "Notifications"],
  [
    "notify while viewing",
    "Notify while viewing — Notifications",
    "Notify while viewing",
    "Notifications",
  ],
])(
  "titles the %s row with its name and subtitles it with its category",
  (query, name, title, subtitle) => {
    const Palette = namedRows();
    render(<Palette query={query} />);
    expect(shown(screen.getByRole("row", { name }))).toEqual([title, subtitle]);
  },
);

it("keeps the name as the title of a notification row paused in a development build", () => {
  const Palette = namedRows({ developmentPaused: true });
  render(<Palette query="sound" />);
  expect(
    shown(screen.getByRole("row", { name: "Sound — Notifications" })),
  ).toEqual(["Sound", "Notifications · Paused in this development build"]);
});
