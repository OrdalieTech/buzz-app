// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRequire } from "node:module";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { StrictMode, Suspense, useState } from "react";
import { Button } from "./Button";
import { ChoiceRow } from "./ChoiceRow";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuLinkItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "./Menu";

afterEach(cleanup);

// The dependency ships both runtime entry points. Exercise real mounted
// roots in each; a handle exposes the live root store without mocking React.
const require = createRequire(import.meta.url);
const menuRuntimes = [
  ["ESM", BaseMenu],
  [
    "CommonJS",
    (require("@base-ui/react/menu") as { Menu: typeof BaseMenu }).Menu,
  ],
] as const;

test.each(menuRuntimes)(
  "%s releases submenu subscriptions on close, replacement and unmount",
  async (_, Menu) => {
    const user = userEvent.setup();
    const handle = Menu.createHandle();
    const selected = vi.fn();
    function Example({
      parent,
      sort = true,
    }: {
      parent: string;
      sort?: boolean;
    }) {
      return (
        <StrictMode>
          <Menu.Root key={parent} handle={handle}>
            <Menu.Trigger>Actions</Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner>
                <Menu.Popup>
                  {sort && (
                    <Menu.SubmenuRoot>
                      <Menu.SubmenuTrigger>Sort</Menu.SubmenuTrigger>
                      <Menu.Portal>
                        <Menu.Positioner>
                          <Menu.Popup>
                            <Menu.Item onClick={selected}>Recent</Menu.Item>
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.SubmenuRoot>
                  )}
                  <Menu.Item onClick={selected}>Sibling action</Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </StrictMode>
      );
    }
    const view = render(<Example parent="first" />);
    const firstListeners = Reflect.get(
      Reflect.get(handle, "store"),
      "listeners",
    ) as Set<unknown>;
    const baseline = firstListeners.size;
    for (let cycle = 0; cycle < 3; cycle++) {
      screen.getByRole("button", { name: "Actions" }).focus();
      await user.keyboard("{ArrowDown}");
      const sort = await screen.findByRole("menuitem", { name: "Sort" });
      sort.focus();
      await user.keyboard("{ArrowRight}");
      const recent = await screen.findByRole("menuitem", { name: "Recent" });
      recent.focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
      );
      expect(firstListeners.size).toBe(baseline);
    }
    view.rerender(<Example parent="first" sort={false} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const sibling = await screen.findByRole("menuitem", {
      name: "Sibling action",
    });
    const siblingBaseline = firstListeners.size;
    view.rerender(<Example parent="first" />);
    expect(await screen.findByRole("menuitem", { name: "Sort" })).toBeVisible();
    view.rerender(<Example parent="first" sort={false} />);
    expect(firstListeners.size).toBe(siblingBaseline);
    sibling.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    view.rerender(<Example parent="replacement" />);
    const replacementListeners = Reflect.get(
      Reflect.get(handle, "store"),
      "listeners",
    ) as Set<unknown>;
    expect(replacementListeners).not.toBe(firstListeners);
    const replacementBaseline = replacementListeners.size;
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Sibling action" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(replacementListeners.size).toBe(replacementBaseline);
    expect(selected).toHaveBeenCalledTimes(5);
    act(() => handle.open(screen.getByRole("button", { name: "Actions" }).id));
    await screen.findByRole("menuitem", { name: "Sort" });
    expect(handle.isOpen).toBe(true);
    act(() => handle.close());
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(replacementListeners.size).toBe(replacementBaseline);
    view.unmount();
    expect(handle.isOpen).toBe(false);
  },
);

test.each(menuRuntimes)(
  "%s never subscribes an abandoned submenu render to its parent",
  async (_, Menu) => {
    const handle = Menu.createHandle();
    const pending = new Promise<never>(() => {});
    function Pending(): never {
      throw pending;
    }
    function Example({ show }: { show: boolean }) {
      return (
        <StrictMode>
          <Menu.Root handle={handle}>
            <Menu.Trigger>Actions</Menu.Trigger>
            <Suspense fallback={<span>Pending submenu</span>}>
              {show && (
                <Menu.SubmenuRoot>
                  <Pending />
                </Menu.SubmenuRoot>
              )}
            </Suspense>
          </Menu.Root>
        </StrictMode>
      );
    }
    const view = render(<Example show={false} />);
    const listeners = Reflect.get(
      Reflect.get(handle, "store"),
      "listeners",
    ) as Set<unknown>;
    const baseline = listeners.size;
    view.rerender(<Example show />);
    expect(await screen.findByText("Pending submenu")).toBeVisible();
    expect(listeners.size).toBe(baseline);
    view.rerender(<Example show={false} />);
    expect(screen.queryByText("Pending submenu")).not.toBeInTheDocument();
    expect(listeners.size).toBe(baseline);
    view.unmount();
  },
);

test("actions and links keep semantics, callbacks and dismissal while disabled items reject activation", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  const disabled = vi.fn();
  render(
    <StrictMode>
      <MenuRoot>
        <MenuTrigger render={<Button>Actions</Button>} />
        <MenuPopup>
          <MenuItem onClick={action}>Copy link</MenuItem>
          <MenuItem disabled onClick={disabled}>
            Unavailable
          </MenuItem>
          <MenuLinkItem href="#documentation">Documentation</MenuLinkItem>
        </MenuPopup>
      </MenuRoot>
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: "Actions" }));
  const unavailable = await screen.findByRole("menuitem", {
    name: "Unavailable",
  });
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await user.click(unavailable);
  unavailable.focus();
  await user.keyboard("{Enter} ");
  expect(disabled).not.toHaveBeenCalled();
  expect(
    screen.getByRole("menuitem", { name: "Documentation" }),
  ).toHaveAttribute("href", "#documentation");
  await user.click(screen.getByRole("menuitem", { name: "Copy link" }));
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

test("controlled checkbox and radio choices report selection and retain disabled values", async () => {
  const user = userEvent.setup();
  const checkboxChange = vi.fn();
  const radioChange = vi.fn();
  const disabledChange = vi.fn();
  function Example() {
    const [checked, setChecked] = useState(false);
    const [value, setValue] = useState("comfortable");
    return (
      <MenuRoot>
        <MenuTrigger render={<Button>Options</Button>} />
        <MenuPopup>
          <MenuCheckboxItem
            checked={checked}
            closeOnClick={false}
            onCheckedChange={(next) => {
              checkboxChange(next);
              setChecked(next);
            }}
          >
            Show details
          </MenuCheckboxItem>
          <MenuCheckboxItem
            disabled
            checked={false}
            onCheckedChange={disabledChange}
          >
            Unavailable toggle
          </MenuCheckboxItem>
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              radioChange(next);
              setValue(next);
            }}
          >
            <MenuRadioItem value="comfortable" closeOnClick={false}>
              Comfortable
            </MenuRadioItem>
            <MenuRadioItem value="compact" closeOnClick={false}>
              Compact
            </MenuRadioItem>
            <MenuRadioItem value="unavailable" disabled>
              Unavailable choice
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
    );
  }
  render(
    <StrictMode>
      <Example />
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: "Options" }));
  const checkbox = await screen.findByRole("menuitemcheckbox", {
    name: "Show details",
  });
  await user.click(checkbox);
  expect(checkbox).toBeChecked();
  expect(checkboxChange).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("menuitemradio", { name: "Compact" }));
  expect(screen.getByRole("menuitemradio", { name: "Compact" })).toBeChecked();
  expect(
    screen.getByRole("menuitemradio", { name: "Comfortable" }),
  ).not.toBeChecked();
  expect(radioChange).toHaveBeenCalledExactlyOnceWith("compact");
  await user.click(
    screen.getByRole("menuitemcheckbox", { name: "Unavailable toggle" }),
  );
  await user.click(
    screen.getByRole("menuitemradio", { name: "Unavailable choice" }),
  );
  expect(disabledChange).not.toHaveBeenCalled();
  expect(radioChange).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("menuitemradio", { name: "Compact" })).toBeChecked();
});

test("context menus reuse the shared popup and action boundary", async () => {
  const action = vi.fn();
  const user = userEvent.setup();
  render(
    <StrictMode>
      <ContextMenuRoot>
        <ContextMenuTrigger>Context target</ContextMenuTrigger>
        <MenuPopup>
          <MenuItem onClick={action}>Copy context link</MenuItem>
        </MenuPopup>
      </ContextMenuRoot>
    </StrictMode>,
  );
  fireEvent.contextMenu(screen.getByText("Context target"), {
    clientX: 20,
    clientY: 20,
  });
  const item = await screen.findByRole("menuitem", {
    name: "Copy context link",
  });
  expect(screen.getByRole("menu")).toHaveAttribute("data-buzz-ui");
  expect(screen.getByText("Context target")).toHaveAttribute(
    "data-context-menu-present",
  );
  await user.click(item);
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

test("context targets do not become present when an open is canceled or controlled closed", async () => {
  const changed = vi.fn();
  const { unmount } = render(
    <ContextMenuRoot
      onOpenChange={(next, details) => {
        changed(next);
        details.cancel();
      }}
    >
      <ContextMenuTrigger>Context target</ContextMenuTrigger>
      <MenuPopup>
        <MenuItem>Action</MenuItem>
      </MenuPopup>
    </ContextMenuRoot>,
  );
  fireEvent.contextMenu(screen.getByText("Context target"));
  expect(changed).toHaveBeenCalledWith(true);
  expect(screen.getByText("Context target")).not.toHaveAttribute(
    "data-context-menu-present",
  );
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  unmount();
  changed.mockClear();
  render(
    <ContextMenuRoot open={false} onOpenChange={(next) => changed(next)}>
      <ContextMenuTrigger>Context target</ContextMenuTrigger>
      <MenuPopup>
        <MenuItem>Action</MenuItem>
      </MenuPopup>
    </ContextMenuRoot>,
  );
  fireEvent.contextMenu(screen.getByText("Context target"));
  expect(changed).toHaveBeenCalledExactlyOnceWith(true);
  expect(screen.getByText("Context target")).not.toHaveAttribute(
    "data-context-menu-present",
  );
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("rich choices retain their names and selected state while disabled choices reject activation", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <MenuRoot>
      <MenuTrigger render={<Button>Agents</Button>} />
      <MenuPopup>
        <MenuRadioGroup value="studio" onValueChange={change}>
          <MenuRadioItem value="studio">
            <ChoiceRow
              label="Studio"
              description="Already in this session"
              leading={<span>S</span>}
            />
          </MenuRadioItem>
          <MenuRadioItem value="archive" disabled>
            <ChoiceRow
              label="Archive"
              description="Unavailable"
              leading={<span>A</span>}
            />
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </MenuRoot>,
  );
  await user.click(screen.getByRole("button", { name: "Agents" }));
  await screen.findByRole("menu");
  expect(
    screen.getByRole("menuitemradio", {
      name: "Studio Already in this session",
    }),
  ).toBeChecked();
  const unavailable = screen.getByRole("menuitemradio", {
    name: "Archive Unavailable",
  });
  await user.click(unavailable);
  expect(change).not.toHaveBeenCalled();
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
});

test("keyboard-opened menus ignore a stationary pointer and open submenus immediately on movement", async () => {
  const user = userEvent.setup();
  render(
    <MenuRoot>
      <MenuTrigger>Actions</MenuTrigger>
      <MenuPopup>
        <MenuSubmenu>
          <MenuSubmenuTrigger>Sort</MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuItem>Recent</MenuItem>
          </MenuSubmenuPopup>
        </MenuSubmenu>
      </MenuPopup>
    </MenuRoot>,
  );
  screen.getByRole("button", { name: "Actions" }).focus();
  await user.keyboard("{ArrowDown}");
  const trigger = await screen.findByRole("menuitem", { name: "Sort" });
  vi.useFakeTimers();
  try {
    fireEvent.mouseEnter(trigger);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.mouseMove(trigger);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Recent" })).toBeVisible();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test("highlight radio choices keep single-selection semantics without a check icon", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  function ViewMenu() {
    const [value, setValue] = useState("all");
    return (
      <MenuRoot>
        <MenuTrigger render={<Button>Views</Button>} />
        <MenuPopup>
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              setValue(next);
              change(next);
            }}
          >
            <MenuRadioItem
              value="all"
              selection="highlight"
              closeOnClick={false}
            >
              All
            </MenuRadioItem>
            <MenuRadioItem
              value="threads"
              selection="highlight"
              closeOnClick={false}
            >
              Threads
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
    );
  }
  render(<ViewMenu />);
  await user.click(screen.getByRole("button", { name: "Views" }));
  const all = await screen.findByRole("menuitemradio", { name: "All" });
  const threads = screen.getByRole("menuitemradio", { name: "Threads" });
  expect(all).toBeChecked();
  expect(all).toHaveAttribute("data-selection", "highlight");
  expect(all.querySelector("svg")).toBeNull();
  expect(threads.querySelector("svg")).toBeNull();
  await user.click(threads);
  expect(threads).toBeChecked();
  expect(all).not.toBeChecked();
  expect(change).toHaveBeenLastCalledWith("threads");
});
