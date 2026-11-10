// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  PluginUpdateFailure,
  PluginUpdates,
  PluginUpdatesMenu,
} from "./PluginUpdates";
import { PluginMenu } from "./PluginMenu";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../shared/design-system/ui/Menu";
import type { PluginManager } from "../plugins/manager";
import type { ImportPreview, PluginInfo } from "../plugins/types";
import type { AppServices } from "./services";
import { createPluginInstallRequests } from "../plugins/installer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fixture() {
  const source = {
    repository: "https://example.com/plugins.git",
    reference: "main",
    path: ".",
  };
  const plugin: PluginInfo = {
    manifest: {
      id: "example.notes",
      name: "Notes",
      apiVersion: 1,
      updates: { defaultEnabled: true },
    },
    source: "external",
    enabled: true,
    revision: "old",
    previous: "older",
    reloadable: true,
    error: null,
    updateSource: source,
  };
  const candidate = {
    path: ".",
    manifest: plugin.manifest,
    revision: "new",
    publisher: null as string | null,
  };
  const freshCandidate = { ...candidate };
  const discovered: ImportPreview = {
    token: "metadata",
    source: source.repository,
    commit: "a".repeat(40),
    candidates: [candidate],
    warnings: [],
  };
  const fresh: ImportPreview = {
    ...discovered,
    token: "immutable-preview",
    candidates: [freshCandidate],
  };
  let snapshot: ReturnType<PluginManager["snapshot"]> = {
    configuration: {
      status: "ready" as const,
      externalPluginsPaused: false,
      catalog: { profile: "test", location: "test", plugins: [plugin] },
    },
    busy: false,
    activation: {},
    error: null,
    refreshError: null,
  };
  const listeners = new Set<() => void>();
  const imports = {
    checkGit: vi.fn(async () => discovered),
    git: vi.fn(async () => fresh),
    discard: vi.fn(async () => {}),
  };
  const installImport = vi.fn(async () => true);
  const manager = {
    imports,
    installImport,
    change: vi.fn(),
    retryPlugin: vi.fn(),
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as PluginManager;
  const navigation = {
    open: vi.fn(async () => ({ status: "opened" as const })),
  };
  const relay = { snapshot: () => ({ session: {} }) } as AppServices["relay"];
  const mount = () =>
    render(
      <ToastProvider>
        <PluginUpdates
          plugins={manager}
          navigation={navigation}
          relay={relay}
          installRequests={createPluginInstallRequests()}
        >
          <button type="button">View Notes details</button>
          <PluginUpdateFailure
            pluginId="example.notes"
            returnFocus={() =>
              screen.getByRole("button", { name: "View Notes details" })
            }
          />
          <MenuRoot>
            <MenuTrigger>Profile</MenuTrigger>
            <MenuPopup>
              <PluginUpdatesMenu recommendations={0} onManage={vi.fn()} />
            </MenuPopup>
          </MenuRoot>
        </PluginUpdates>
      </ToastProvider>,
    );
  return {
    source,
    candidate,
    freshCandidate,
    plugin,
    discovered,
    fresh,
    imports,
    installImport,
    navigation,
    manager,
    state: () => snapshot,
    emit(next: Partial<ReturnType<PluginManager["snapshot"]>>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    mount,
  };
}

it("checks one hour after configuration becomes ready", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const f = fixture();
  const ready = f.state().configuration;
  f.candidate.revision = f.plugin.revision;
  f.emit({ configuration: { status: "loading" } });
  const view = f.mount();
  try {
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => f.emit({ configuration: ready }));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(3_599_999));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    visibility.mockRestore();
  }
});

it("stops scheduling during configuration recovery after pending discovery", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const f = fixture();
  const ready = f.state().configuration;
  f.candidate.revision = f.plugin.revision;
  let finish!: (preview: ImportPreview) => void;
  f.imports.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const snapshot = vi.spyOn(f.manager, "snapshot");
  const view = f.mount();
  try {
    await act(async () => {});
    expect(f.imports.checkGit).toHaveBeenCalledTimes(1);
    await act(async () => f.emit({ configuration: { status: "loading" } }));
    await act(() => vi.advanceTimersByTimeAsync(3_600_000));
    await act(async () => finish(f.discovered));
    const reads = snapshot.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(snapshot).toHaveBeenCalledTimes(reads);
    await act(async () => f.emit({ configuration: ready }));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(2);
  } finally {
    finish(f.discovered);
    view.unmount();
    visibility.mockRestore();
    snapshot.mockRestore();
  }
});

it.each([true, false])(
  "lets the user override the plugin's default check policy (%s)",
  async (defaultEnabled) => {
    const f = fixture();
    f.plugin.manifest = { ...f.plugin.manifest, updates: { defaultEnabled } };
    render(<PluginMenu plugin={f.plugin} plugins={f.manager} busy={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: "More plugin actions" }),
    );
    const choice = await screen.findByRole("menuitemcheckbox", {
      name: "Check for updates automatically",
    });
    expect(choice).toHaveAttribute("aria-checked", String(defaultEnabled));
    fireEvent.click(choice);
    expect(f.manager.change).toHaveBeenCalledWith(
      defaultEnabled ? "disable-update-checks" : "enable-update-checks",
      f.plugin.manifest.id,
    );
  },
);

it("removes a pending update action when the user turns off checks", async () => {
  const f = fixture();
  let finish!: (preview: ImportPreview) => void;
  f.imports.git.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.imports.git).toHaveBeenCalled());
  act(() => {
    f.plugin.updateChecks = false;
    f.emit({});
  });
  await act(async () => {
    finish(f.fresh);
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Update and reload" }),
    ).not.toBeInTheDocument(),
  );
  expect(f.installImport).not.toHaveBeenCalled();
});

it("opens the plugin's update settings from the notice body", async () => {
  const f = fixture();
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage Notes update checks" }),
  );
  expect(f.navigation.open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginId: "example.notes",
  });
  expect(f.installImport).not.toHaveBeenCalled();
});

it("shows progress while applying a fresh preview without more access", async () => {
  const f = fixture();
  f.freshCandidate.revision = "newer";
  let finish!: (success: boolean) => void;
  f.installImport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() =>
    expect(f.installImport).toHaveBeenCalledExactlyOnceWith(
      "immutable-preview",
      ".",
    ),
  );
  try {
    const dialog = screen.getByRole("dialog", { name: "Updating Notes" });
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Updating plugin",
    );
    expect(
      within(dialog).queryByRole("button", { name: /^Update$/ }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("region", { name: "Computer access" }),
    ).toBeNull();
    expect(screen.queryByRole("region", { name: "Plugin updates" })).toBeNull();
  } finally {
    await act(async () => {
      finish(true);
    });
  }
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Updating Notes" })).toBeNull(),
  );
  expect(f.imports.git).toHaveBeenCalledOnce();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it.each(["discovered", "fresh", "publisher"] as const)(
  "requires confirmation when %s data requires review",
  async (kind) => {
    const f = fixture();
    if (kind === "discovered")
      f.candidate.manifest = {
        ...f.plugin.manifest,
        host: { files: true },
      };
    if (kind === "publisher") f.freshCandidate.publisher = "b".repeat(64);
    else
      f.freshCandidate.manifest = {
        ...f.plugin.manifest,
        host: { files: true },
      };
    f.mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name:
          kind === "discovered" ? "Review permissions" : "Update and reload",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
    const confirm = await within(dialog).findByRole("button", {
      name: "Update",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(f.installImport).not.toHaveBeenCalled();
    if (kind === "publisher")
      expect(
        within(dialog).getByText(/Previous publisher: Unsigned/),
      ).toBeVisible();
    else
      expect(within(dialog).getByText("Read your files (added)")).toBeVisible();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(f.installImport).toHaveBeenCalledExactlyOnceWith(
        "immutable-preview",
        ".",
      ),
    );
  },
);

it("keeps Later updates in the Plugins menu and cancellation leaves the plugin running", async () => {
  const f = fixture();
  f.freshCandidate.manifest = {
    ...f.plugin.manifest,
    host: { files: true },
  };
  f.mount();
  const later = await screen.findByRole("button", {
    name: "Later",
  });
  fireEvent.click(later);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Update and reload" }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Plugins/ }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Update Notes" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Update" }),
    ).toBeEnabled(),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it("can cancel while a fresh preview loads, then discards the late preview", async () => {
  const f = fixture();
  let resolve!: (preview: ImportPreview) => void;
  f.imports.git.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.imports.git).toHaveBeenCalledOnce());
  try {
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    await act(async () => {
      resolve(f.fresh);
    });
  }
  await waitFor(() =>
    expect(f.imports.discard).toHaveBeenCalledWith("immutable-preview"),
  );
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it("shows an install failure in the review and permits a retry", async () => {
  const f = fixture();
  f.installImport.mockResolvedValueOnce(false);
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent("Plugin installation wasn’t confirmed");
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Update" }),
  );
  await waitFor(() => expect(f.installImport).toHaveBeenCalledTimes(2));
});

it("offers activation retry and the existing rollback confirmation outside Settings", async () => {
  const f = fixture();
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
  await act(async () => {
    f.emit({
      activation: {
        "example.notes": {
          revision: "old",
          status: "failed",
          error: "Activation failed",
        },
      },
    });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry activation" }),
  );
  expect(f.manager.retryPlugin).toHaveBeenCalledWith("example.notes");
  fireEvent.click(
    screen.getByRole("button", { name: "Plugin recovery actions" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Roll back" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Roll back Notes?",
  });
  expect(f.manager.change).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(f.manager.change).not.toHaveBeenCalled();
});

it.each([true, false])(
  "preserves the managed pin and refuses a mismatched preview (matches: %s)",
  async (matches) => {
    const f = fixture();
    const configuration = f.state().configuration;
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    f.emit({
      configuration: {
        ...configuration,
        managed: {
          status: "ready",
          path: "policy",
          source: "Example",
          problems: [],
          plugins: [
            {
              id: f.plugin.manifest.id,
              ...f.source,
              commit: "a".repeat(40),
              state: "outdated",
            },
          ],
        },
      },
    });
    if (!matches) f.fresh.commit = "b".repeat(40);
    f.mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Update and reload" }),
    );
    await waitFor(() =>
      expect(f.imports.git).toHaveBeenCalledWith(
        f.source.repository,
        "main",
        undefined,
        "a".repeat(40),
      ),
    );
    if (matches)
      await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
    else {
      expect(
        await screen.findByText(/not at the commit that was requested/),
      ).toBeVisible();
      expect(f.installImport).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    }
  },
);

it("retires a pending preview when the saved source changes", async () => {
  const f = fixture();
  let resolve!: (preview: ImportPreview) => void;
  f.imports.git.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.imports.git).toHaveBeenCalledOnce());
  try {
    const configuration = f.state().configuration;
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    act(() =>
      f.emit({
        configuration: {
          ...configuration,
          catalog: {
            ...configuration.catalog,
            plugins: [
              {
                ...f.plugin,
                updateSource: { ...f.source, reference: "other" },
              },
            ],
          },
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    await act(async () => {
      resolve(f.fresh);
    });
  }
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.imports.discard).toHaveBeenCalledWith("immutable-preview");
});

it("requires review when a fresh update removes a process artifact constraint", async () => {
  const f = fixture();
  const process = { id: "worker", program: "worker", args: [] };
  f.plugin.manifest = {
    ...f.plugin.manifest,
    host: {
      processes: [
        {
          ...process,
          artifact: { path: "bin/worker", sha256: "a".repeat(64) },
        },
      ],
    },
  };
  f.candidate.manifest = f.plugin.manifest;
  f.freshCandidate.manifest = {
    ...f.plugin.manifest,
    host: { processes: [process] },
  };
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
  const confirm = await within(dialog).findByRole("button", { name: "Update" });
  await waitFor(() => expect(confirm).toBeEnabled());
  expect(f.installImport).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: /Start worker/ }));
  await waitFor(() =>
    expect(within(dialog).getByText("bin/worker")).toBeVisible(),
  );
  fireEvent.click(confirm);
  await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
});

const OFFLINE =
  "Git could not read this repository: fatal: unable to access 'https://example.com/plugins.git/': Could not resolve host: example.com";
const noticeTitle = (name: string) => `Couldn’t check ${name} for updates`;

it("keeps a background check’s failure on its plugin’s row, with Git’s text behind Details", async () => {
  const f = fixture();
  f.imports.checkGit.mockRejectedValue(OFFLINE);
  f.mount();
  const status = await screen.findByText("Couldn’t check for updates.");
  await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledOnce());
  // Nothing interrupts: no notice, and the Plugins menu has no entry for it.
  expect(screen.queryByText(noticeTitle("Notes"))).toBeNull();
  expect(screen.queryByText(/Cannot check/)).toBeNull();
  const row = status.parentElement?.parentElement;
  if (!row) throw new Error("Expected the row status");
  const details = row.querySelector("details");
  expect(details).not.toHaveAttribute("open");
  fireEvent.click(within(row).getByText("Details"));
  expect(details).toHaveAttribute("open");
  expect(details).toHaveTextContent(OFFLINE);
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  expect(
    await screen.findByRole("menuitem", { name: "Plugins" }),
  ).not.toHaveAttribute("aria-haspopup");
});

function holdCheck(f: ReturnType<typeof fixture>) {
  let settle!: {
    finish(preview: ImportPreview): void;
    fail(error: string): void;
  };
  f.imports.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        settle = { finish: resolve, fail: reject };
      }),
  );
  return () => settle;
}

it("clears the row while Check again runs, and returns a failure to the row without a notice", async () => {
  const f = fixture();
  f.imports.checkGit.mockRejectedValueOnce(OFFLINE);
  const held = holdCheck(f);
  f.mount();
  const again = await screen.findByRole("button", { name: "Check again" });
  again.focus();
  fireEvent.click(again);
  // The failure leaves at once; the row reads as it does during any check.
  expect(screen.queryByText("Couldn’t check for updates.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "View Notes details" }),
  ).toHaveFocus();
  await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(2));
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  await act(async () => held().fail(OFFLINE));
  const status = await screen.findByRole("alert");
  expect(status).toHaveTextContent("Couldn’t check for updates.");
  expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
  expect(screen.getByText("Details").closest("details")).toHaveTextContent(
    OFFLINE,
  );
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(screen.queryByText(noticeTitle("Notes"))).toBeNull();
  expect(screen.queryByText(/Check your connection/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(f.installImport).not.toHaveBeenCalled();
});

it("keeps the row clear and focus on the plugin when Check again succeeds", async () => {
  const f = fixture();
  f.candidate.revision = f.plugin.revision;
  f.imports.checkGit.mockRejectedValueOnce(OFFLINE);
  const held = holdCheck(f);
  f.mount();
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(2));
  await act(async () => held().finish(f.discovered));
  await waitFor(() =>
    expect(document.querySelector('[aria-busy="true"]')).toBeNull(),
  );
  expect(screen.queryByText("Couldn’t check for updates.")).toBeNull();
  expect(
    screen.getByRole("button", { name: "View Notes details" }),
  ).toHaveFocus();
  expect(screen.queryByText(noticeTitle("Notes"))).toBeNull();
});

it("doesn’t announce the hourly check’s failure after Check again succeeded", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const f = fixture();
  f.candidate.revision = f.plugin.revision;
  f.imports.checkGit.mockRejectedValueOnce(OFFLINE);
  const held = holdCheck(f);
  const view = f.mount();
  try {
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(2);
    await act(async () => held().finish(f.discovered));
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByText("Couldn’t check for updates.")).toBeNull();
    f.imports.checkGit.mockRejectedValueOnce(OFFLINE);
    await act(() => vi.advanceTimersByTimeAsync(3_600_000));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Couldn’t check for updates.")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    view.unmount();
    visibility.mockRestore();
  }
});

it.each([
  [
    "Git could not read this repository: remote: Repository not found.\nfatal: repository 'https://example.com/plugins.git/' not found",
    "Git couldn’t find this plugin’s repository. It may have moved, been removed, or need access you don’t have.",
  ],
  [
    "Git could not read this repository: fatal: could not read Username for 'https://example.com': terminal prompts disabled",
    "Git needs a sign-in for this repository that Buzz couldn’t provide.",
  ],
])(
  "adds a hint for a Git cause Buzz recognizes and keeps Check again, since access can return (%#)",
  async (error, cause) => {
    const f = fixture();
    f.candidate.revision = f.plugin.revision;
    f.imports.checkGit.mockRejectedValueOnce(OFFLINE);
    f.imports.checkGit.mockRejectedValueOnce(error);
    f.mount();
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    expect(
      await screen.findByText(`Couldn’t check for updates. ${cause}`),
    ).toBeVisible();
    expect(screen.getAllByText(cause, { exact: false })).toHaveLength(1);
    expect(screen.queryByText(noticeTitle("Notes"))).toBeNull();
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("Details").closest("details")).toHaveTextContent(
      error.replace(/\s+/g, " "),
    );
    // Access restored, Check again clears the hint.
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.queryByText(/Couldn’t check for updates/)).toBeNull(),
    );
  },
);

it("keeps Check again and the generic sentence when an authorized HTTPS check is refused, as for an expired token", async () => {
  const f = fixture();
  const refused =
    "Git could not read this repository: remote: Invalid username or token.\nfatal: Authentication failed for 'https://example.com/plugins.git/'";
  f.imports.checkGit.mockRejectedValueOnce(OFFLINE);
  f.imports.checkGit.mockRejectedValue(refused);
  f.mount();
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(2));
  expect(
    await screen.findByRole("button", { name: "Check again" }),
  ).toBeVisible();
  expect(screen.getByText("Couldn’t check for updates.")).toBeVisible();
  expect(screen.getByText("Details").closest("details")).toHaveTextContent(
    "Authentication failed",
  );
  expect(screen.queryByText(noticeTitle("Notes"))).toBeNull();
  expect(screen.queryByText(/Git needs a sign-in/)).toBeNull();
});

it("doesn’t check in the background while offline, and checks when the connection returns", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  try {
    const f = fixture();
    f.mount();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(f.imports.checkGit).not.toHaveBeenCalled();
    expect(screen.queryByText("Couldn’t check for updates.")).toBeNull();
    online.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(f.imports.checkGit).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: "Update and reload" }),
    ).toBeVisible();
  } finally {
    online.mockRestore();
  }
});

it("checks once when the connection returns to a launch that was offline and Git still fails", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  try {
    const f = fixture();
    f.imports.checkGit.mockRejectedValue(OFFLINE);
    f.mount();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(f.imports.checkGit).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(
      await screen.findByText("Couldn’t check for updates."),
    ).toBeVisible();
    // The connection's return started this check, so its failure doesn't
    // force another; the row waits for the next trigger.
    expect(f.imports.checkGit).toHaveBeenCalledOnce();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(2));
  } finally {
    online.mockRestore();
  }
});

it("checks again when the connection returns after it dropped during a check", async () => {
  const f = fixture();
  f.candidate.revision = f.plugin.revision;
  f.imports.checkGit.mockRejectedValueOnce(OFFLINE);
  f.mount();
  expect(await screen.findByText("Couldn’t check for updates.")).toBeVisible();
  // Within the hour, other triggers stay throttled.
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(f.imports.checkGit).toHaveBeenCalledOnce();
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.queryByText("Couldn’t check for updates.")).toBeNull(),
  );
  expect(screen.queryByText(noticeTitle("Notes"))).toBeNull();
  // With nothing failed, the connection's return is throttled too.
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  expect(f.imports.checkGit).toHaveBeenCalledTimes(2);
});

it("checks again when the connection returns before the check it dropped has failed", async () => {
  const f = fixture();
  f.candidate.revision = f.plugin.revision;
  const held = holdCheck(f);
  f.mount();
  await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledOnce());
  // Nothing has failed yet, so the connection's return has nothing to force.
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  expect(f.imports.checkGit).toHaveBeenCalledOnce();
  await act(async () => held().fail(OFFLINE));
  await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.queryByText("Couldn’t check for updates.")).toBeNull(),
  );
  // The intent was spent on that check.
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(f.imports.checkGit).toHaveBeenCalledTimes(2);
});

it("keeps the connection's return for a hidden window, and checks again once it is shown", async () => {
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  try {
    const f = fixture();
    f.candidate.revision = f.plugin.revision;
    f.imports.checkGit.mockRejectedValueOnce(OFFLINE);
    f.mount();
    expect(
      await screen.findByText("Couldn’t check for updates."),
    ).toBeVisible();
    visibility.mockReturnValue("hidden");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(f.imports.checkGit).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Couldn’t check for updates.")).toBeNull(),
    );
  } finally {
    visibility.mockRestore();
  }
});
