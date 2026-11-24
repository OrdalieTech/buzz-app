// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSaveState } from "../../features/agents/AgentSaveButton";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { awaitingRestart } from "./agent-env";
import { AgentEnvironment } from "./AgentEnvironment";
import { AgentTabs } from "./AgentTabs";

const AGENT = "ab".repeat(32);

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => native.invoke(...args),
}));

let names: string[];
const restartAgent = vi.fn(async () => {});
beforeEach(() => {
  awaitingRestart.clear();
  names = ["SAVED_KEY"];
  restartAgent.mockReset().mockResolvedValue(undefined);
  native.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "agent_env_status") return { names };
    if (command === "agent_env_set") {
      const rows = (args as { rows: { name: string }[] }).rows;
      if (rows.some((row) => row.name === "GOOSE_MODEL"))
        throw "GOOSE_MODEL chooses a model, provider or endpoint.";
      names = rows.map((row) => row.name);
    }
    return undefined;
  });
});
afterEach(cleanup);

const calls = (command: string) =>
  native.invoke.mock.calls.filter(([name]) => name === command);
const button = (name: string) => screen.getByRole("button", { name });

async function replaceSaved(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "SAVED_KEY actions" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Replace" }));
}

async function saveOnce(user: ReturnType<typeof userEvent.setup>) {
  await replaceSaved(user);
  await user.type(screen.getByLabelText("Value of SAVED_KEY"), "new");
  await user.click(button("Save"));
  return screen.findByRole("button", { name: "Restart agent" });
}

it("adding a variable keeps the hidden saved values", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(await screen.findByRole("button", { name: "Add variable" }));
  await user.type(screen.getByLabelText("Variable name"), "FOO");
  await user.type(screen.getByLabelText("Value of FOO"), "bar");
  await user.click(button("Save"));
  expect(calls("agent_env_status")[0]?.[1]).toEqual({ agent: AGENT });
  expect(calls("agent_env_set")[0]?.[1]).toEqual({
    agent: AGENT,
    rows: [
      { name: "SAVED_KEY", value: null },
      { name: "FOO", value: "bar" },
    ],
  });
  expect(await screen.findByText("FOO")).toBeInTheDocument();
  expect(screen.queryByLabelText("Value of FOO")).toBeNull();
  expect(screen.getAllByText("Saved")).toHaveLength(2);
});

it("replacing a value sends only that row's value", async () => {
  names = ["SAVED_KEY", "OTHER"];
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await saveOnce(user);
  expect(calls("agent_env_set")[0]?.[1]).toEqual({
    agent: AGENT,
    rows: [
      { name: "SAVED_KEY", value: "new" },
      { name: "OTHER", value: null },
    ],
  });
});

it("removing a variable deletes only it", async () => {
  names = ["SAVED_KEY", "OTHER"];
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(
    await screen.findByRole("button", { name: "SAVED_KEY actions" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  await waitFor(() =>
    expect(calls("agent_env_set")[0]?.[1]).toEqual({
      agent: AGENT,
      rows: [{ name: "OTHER", value: null }],
    }),
  );
  await waitFor(() => expect(screen.queryByText("SAVED_KEY")).toBeNull());
});

it("cancel closes the row without saving", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(await screen.findByRole("button", { name: "Add variable" }));
  await user.type(screen.getByLabelText("Variable name"), "FOO");
  await user.click(button("Cancel"));
  expect(screen.queryByLabelText("Variable name")).toBeNull();
  expect(calls("agent_env_set")).toHaveLength(0);
});

it("shows the empty state with no variables", async () => {
  names = [];
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  expect(await screen.findByText("No variables yet")).toBeInTheDocument();
  expect(button("Add variable")).toBeEnabled();
});

it("a rejected save shows why and keeps the row open", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(await screen.findByRole("button", { name: "Add variable" }));
  await user.type(screen.getByLabelText("Variable name"), "GOOSE_MODEL");
  await user.click(button("Save"));
  expect(await screen.findByRole("alert")).toHaveTextContent("GOOSE_MODEL");
  expect(screen.getByLabelText("Variable name")).toHaveValue("GOOSE_MODEL");
  expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull();
});

it("offers a restart only after a save, asks first, then stops only its processes", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await screen.findByText("SAVED_KEY");
  expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull();
  const restart = await saveOnce(user);
  expect(
    screen.getByText("Changes saved. Restart the agent to apply them."),
  ).toBeInTheDocument();
  await user.click(restart);
  await user.click(button("Cancel"));
  expect(restartAgent).not.toHaveBeenCalled();
  await user.click(button("Restart agent"));
  await user.click(button("Restart"));
  await waitFor(() => expect(restartAgent).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull(),
  );
});

it("shows why a restart was refused, and keeps the banner", async () => {
  restartAgent.mockRejectedValueOnce(
    new Error("Echo is answering; restart it when it finishes"),
  );
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(await saveOnce(user));
  await user.click(button("Restart"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Echo is answering; restart it when it finishes",
  );
  expect(button("Restart agent")).toBeInTheDocument();
});

it("locks the list until a restart finishes", async () => {
  const user = userEvent.setup();
  let finish = () => {};
  restartAgent.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(await saveOnce(user));
  await user.click(button("Restart"));
  try {
    expect(button("Add variable")).toBeDisabled();
    expect(button("SAVED_KEY actions")).toBeDisabled();
  } finally {
    finish();
  }
  await waitFor(() => expect(button("SAVED_KEY actions")).toBeEnabled());
});

it("locks the list while a save runs", async () => {
  const user = userEvent.setup();
  let finish = () => {};
  native.invoke.mockImplementation(async (command) => {
    if (command === "agent_env_status") return { names };
    if (command === "agent_env_set")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return undefined;
  });
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await replaceSaved(user);
  await user.type(screen.getByLabelText("Value of SAVED_KEY"), "new");
  await user.click(button("Save"));
  expect(screen.getByLabelText("Value of SAVED_KEY")).toBeDisabled();
  expect(button("Add variable")).toBeDisabled();
  expect(button("Cancel")).toBeDisabled();
  finish();
  expect(
    await screen.findByRole("button", { name: "Restart agent" }),
  ).toBeEnabled();
  expect(button("Add variable")).toBeEnabled();
});

it("keeps Restart agent off while a row is open", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  const restart = await saveOnce(user);
  expect(restart).not.toHaveAttribute("aria-disabled", "true");
  await user.click(button("Add variable"));
  expect(restart).toHaveAttribute("aria-disabled", "true");
  await user.click(restart);
  expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
});

it("keeps Restart agent off while a save runs", async () => {
  const user = userEvent.setup();
  names = ["SAVED_KEY", "OTHER"];
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  const restart = await saveOnce(user);
  let finish = () => {};
  native.invoke.mockImplementation(async (command) => {
    if (command === "agent_env_status") return { names };
    if (command === "agent_env_set")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return undefined;
  });
  await user.click(button("OTHER actions"));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  expect(restart).toHaveAttribute("aria-disabled", "true");
  await user.click(restart);
  expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  finish();
  await waitFor(() =>
    expect(restart).not.toHaveAttribute("aria-disabled", "true"),
  );
});

it("offers Retry for a list it cannot read, never an empty one", async () => {
  const user = userEvent.setup();
  let readable = false;
  native.invoke.mockImplementation(async (command) => {
    if (command !== "agent_env_status") return undefined;
    if (!readable) throw "The credential store is locked";
    return { names };
  });
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The credential store is locked",
  );
  expect(screen.queryByRole("button", { name: "Add variable" })).toBeNull();
  expect(screen.queryByText("No variables yet")).toBeNull();
  readable = true;
  await user.click(button("Retry"));
  expect(await screen.findByText("SAVED_KEY")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("tells the agent's page about an open row, through the save and its reload", async () => {
  const user = userEvent.setup();
  const reports: { dirty: boolean; saving: boolean }[] = [];
  let finishSave = () => {};
  let finishReload = () => {};
  let reloads = 0;
  native.invoke.mockImplementation(async (command) => {
    if (command === "agent_env_status") {
      if (reloads++ > 0)
        await new Promise<void>((resolve) => {
          finishReload = resolve;
        });
      return { names };
    }
    if (command === "agent_env_set")
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
    return undefined;
  });
  render(
    <AgentSaveState value={(state) => state && reports.push(state)}>
      <AgentEnvironment agent={AGENT} restartAgent={restartAgent} />
    </AgentSaveState>,
  );
  const last = () => reports.at(-1);
  await replaceSaved(user);
  expect(last()).toEqual({ dirty: true, saving: false });
  await user.type(screen.getByLabelText("Value of SAVED_KEY"), "new");
  await user.click(button("Save"));
  expect(last()).toEqual({ dirty: true, saving: true });
  finishSave();
  await waitFor(() => expect(reloads).toBe(2));
  expect(last()?.saving).toBe(true);
  finishReload();
  await waitFor(() => expect(last()).toEqual({ dirty: false, saving: false }));
});

function renderInTabs() {
  const agent = {
    key: AGENT,
    pubkey: AGENT,
    name: "Ada",
    place: "here",
    type: "test",
    owner: "c".repeat(64),
    relay: "wss://example.com",
    config: {},
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  } satisfies Agent;
  const type = {
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: ({ settingsContent }: { settingsContent?: unknown }) => (
          <>{settingsContent}</>
        ),
      },
    ],
  } as unknown as RegisteredAgentType;
  const agents = {
    subscribe: () => () => {},
    classifier: () => "unavailable",
    memberships: () => [],
    configHistory: () => undefined,
    addedTabs: () => [],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  return render(
    <AgentTabs
      agents={agents}
      agent={agent}
      type={type}
      channels={[]}
      settingsHost={{}}
      memories={undefined}
      settingsContent={
        <AgentEnvironment agent={AGENT} restartAgent={restartAgent} />
      }
    />,
  );
}

it("blocks leaving Settings while the environment variables have unsaved edits", async () => {
  native.invoke
    .mockReset()
    .mockImplementation(async (command) =>
      command === "agent_env_status" ? { names: [] } : undefined,
    );
  const user = userEvent.setup();
  renderInTabs();
  await user.click(await screen.findByRole("button", { name: "Add variable" }));
  await user.type(screen.getByLabelText("Variable name"), "FOO");
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Variable name")).toHaveValue("FOO");
  expect(native.invoke).not.toHaveBeenCalledWith(
    "agent_env_set",
    expect.anything(),
  );
});

it("keeps the agent's tabs until a restart settles, so its error stays", async () => {
  let fail = (_: Error) => {};
  restartAgent.mockImplementation(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  const user = userEvent.setup();
  renderInTabs();
  await user.click(await saveOnce(user));
  await user.click(screen.getByRole("button", { name: "Restart" }));
  try {
    const memory = screen.getByRole("tab", { name: "Memory" });
    expect(memory).toHaveAttribute("aria-disabled", "true");
    await user.click(memory);
    expect(memory).toHaveAttribute("aria-selected", "false");
    expect(
      screen.getByRole("button", { name: "Restart agent" }),
    ).toBeInTheDocument();
  } finally {
    fail(new Error("Echo is answering; restart it when it finishes"));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Echo is answering",
  );
  const restart = screen.getByRole("button", { name: "Restart agent" });
  await waitFor(() =>
    expect(restart).not.toHaveAttribute("aria-disabled", "true"),
  );
});

it("keeps the restart offer across leaving and coming back until a restart succeeds", async () => {
  restartAgent.mockRejectedValueOnce(new Error("Echo is answering"));
  const user = userEvent.setup();
  const view = () =>
    render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  const first = view();
  await saveOnce(user);
  first.unmount();
  const second = view();
  await user.click(
    await screen.findByRole("button", { name: "Restart agent" }),
  );
  await user.click(button("Restart"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Echo is answering",
  );
  second.unmount();
  const third = view();
  await user.click(
    await screen.findByRole("button", { name: "Restart agent" }),
  );
  await user.click(button("Restart"));
  await waitFor(() => expect(restartAgent).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull(),
  );
  third.unmount();
  view();
  await screen.findByText("SAVED_KEY");
  expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull();
});

it("edits the device list when no agent is named", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment />);
  await replaceSaved(user);
  await user.type(screen.getByLabelText("Value of SAVED_KEY"), "new");
  await user.click(button("Save"));
  expect(calls("agent_env_status")[0]?.[1]).toEqual({ agent: undefined });
  expect(calls("agent_env_set")[0]?.[1]).toEqual({
    agent: undefined,
    rows: [{ name: "SAVED_KEY", value: "new" }],
  });
  expect(
    screen.getByText("Variables every local agent on this device starts with."),
  ).toBeInTheDocument();
});

it("restarting every agent asks first, then reloads Buzz", async () => {
  const user = userEvent.setup();
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  native.invoke.mockImplementation(async (command) =>
    command === "agent_env_status" ? { names, saved: true } : undefined,
  );
  try {
    render(<AgentEnvironment />);
    expect(
      await screen.findByText("Changes saved. Restart agents to apply them."),
    ).toBeInTheDocument();
    await user.click(button("Restart agents"));
    expect(screen.getByText(/ends calls and turns in progress/)).toBeVisible();
    expect(reload).not.toHaveBeenCalled();
    await user.click(button("Restart"));
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("marks an agent's variables that override the device list", async () => {
  names = ["SAVED_KEY", "OWN"];
  native.invoke.mockImplementation(async (command, args) =>
    command === "agent_env_status"
      ? { names: (args as { agent?: string }).agent ? names : ["SAVED_KEY"] }
      : undefined,
  );
  const openSettings = vi.fn();
  const user = userEvent.setup();
  render(
    <AgentEnvironment
      agent={AGENT}
      restartAgent={restartAgent}
      openSettings={openSettings}
    />,
  );
  expect(
    await screen.findByText("Overrides the device-wide value"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Overrides the device-wide value")).toHaveLength(
    1,
  );
  await user.click(button("device-wide variables"));
  expect(openSettings).toHaveBeenCalledWith("agents");
});

it("a restarted agent's banner stays gone though native still says saved", async () => {
  native.invoke.mockImplementation(async (command) =>
    command === "agent_env_status" ? { names, saved: true } : undefined,
  );
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await screen.findByText("SAVED_KEY");
  expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull();
});

it("an agent's override note follows a device save made over its page", async () => {
  let device: string[] = [];
  native.invoke.mockImplementation(async (command, args) => {
    const { agent, rows } = args as {
      agent?: string;
      rows?: { name: string }[];
    };
    if (command === "agent_env_status")
      return { names: agent ? ["OWN"] : device };
    if (command === "agent_env_set" && !agent)
      device = (rows ?? []).map((row) => row.name);
    return undefined;
  });
  const user = userEvent.setup();
  const page = render(
    <AgentEnvironment agent={AGENT} restartAgent={restartAgent} />,
  );
  await within(page.container).findByText("OWN");
  expect(screen.queryByText("Overrides the device-wide value")).toBeNull();
  const settings = render(<AgentEnvironment />);
  const inSettings = within(settings.container);
  await user.click(
    await inSettings.findByRole("button", { name: "Add variable" }),
  );
  await user.type(inSettings.getByLabelText("Variable name"), "OWN");
  await user.type(inSettings.getByLabelText("Value of OWN"), "device");
  await user.click(inSettings.getByRole("button", { name: "Save" }));
  expect(
    await within(page.container).findByText("Overrides the device-wide value"),
  ).toBeInTheDocument();
});

it("says a device save that fails after Settings closes", async () => {
  const user = userEvent.setup();
  let reject!: (reason: unknown) => void;
  native.invoke.mockImplementation(async (command) => {
    if (command === "agent_env_status") return { names };
    if (command === "agent_env_set")
      return new Promise((_, no) => (reject = no));
    return undefined;
  });
  const view = (open: boolean) => (
    <ToastProvider>{open && <AgentEnvironment />}</ToastProvider>
  );
  const { rerender } = render(view(true));
  await replaceSaved(user);
  await user.type(screen.getByLabelText("Value of SAVED_KEY"), "secret-value");
  await user.click(button("Save"));
  await waitFor(() => expect(calls("agent_env_set")).toHaveLength(1));
  // Settings closes while the store is still writing.
  rerender(view(false));
  reject("store denied SAVED_KEY");
  expect(
    await screen.findByText("Couldn't save environment variables"),
  ).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("SAVED_KEY");
  expect(document.body).not.toHaveTextContent("secret-value");
});
