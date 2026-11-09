// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelDetailsEditor } from "./ChannelDetailsEditor";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";
import type {
  ChannelDetailsCapability,
  DetailsAttempt,
} from "../../features/relay/channel-details";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";
import { createRelaySession } from "../../features/relay/session";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
const channel = {
  id: "alpha",
  name: "Alpha",
  description: "Existing description",
  visibility: "public" as const,
  channelType: "stream" as const,
};
const base: ChannelDetails = {
  channelId: channel.id,
  version: "v1",
  name: channel.name,
  description: channel.description,
  visibility: "public",
  canEdit: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  let attempt: DetailsAttempt | undefined;
  const listeners = new Set<() => void>();
  const load = vi.fn(async () => base);
  const save = vi.fn(async () => {});
  const check = vi.fn(async () => {});
  const capability: ChannelDetailsCapability = {
    available: true,
    load,
    save,
    check,
    snapshot: () => attempt,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const setAttempt = (next: DetailsAttempt | undefined) => {
    attempt = next;
    for (const listener of listeners) listener();
  };
  return { capability, load, save, check, setAttempt };
}
it("edits deliberately, cancels every field, and sends all fields only on Save", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  expect(screen.getByRole("textbox", { name: "Name" })).not.toHaveAttribute(
    "autocomplete",
  );
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Renamed");
  await user.clear(screen.getByRole("textbox", { name: "Description" }));
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  expect(h.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Edit details" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Alpha");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    channel.description,
  );
  expect(screen.getByRole("radio", { name: "Ongoing" })).toBeChecked();
  await user.clear(screen.getByRole("textbox", { name: "Description" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, description: "" },
    expect.any(AbortSignal),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus(),
  );
});
it("retains rejected edits and preserves them through an explicit authority reload", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.save.mockRejectedValueOnce(new Error("Permission changed"));
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    " draft",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Permission changed",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    `${channel.description} draft`,
  );
  h.load.mockResolvedValueOnce({ ...base, canEdit: false });
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled(),
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    `${channel.description} draft`,
  );
});
it("reloads authoritative privacy after a conflict and saves retained text edits", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.save.mockRejectedValueOnce(new Error("Channel details changed"));
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "My renamed channel" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
    target: { value: "My retained description" },
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Channel details changed",
  );
  const privateBase = {
    ...base,
    version: "v2",
    visibility: "private" as const,
  };
  h.load.mockResolvedValue(privateBase);
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled(),
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "My renamed channel",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "My retained description",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenLastCalledWith(
    privateBase,
    {
      ...base,
      name: "My renamed channel",
      description: "My retained description",
      visibility: "private",
    },
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("keeps Edit details disabled and loading for a save that outlives the editor", async () => {
  const h = harness();
  const user = userEvent.setup();
  const draft = { ...base, name: "Pending name" };
  h.setAttempt({ draft, status: "saving" });
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  const edit = await screen.findByRole("button", { name: "Edit details" });
  expect(edit).toBeDisabled();
  expect(edit).toHaveAttribute("aria-busy", "true");
  expect(edit.querySelector(".buzz-button-spinner")).toBeInTheDocument();
  await user.click(edit);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  act(() => h.setAttempt({ draft, status: "unconfirmed" }));
  expect(edit).toBeEnabled();
  expect(edit).not.toHaveAttribute("aria-busy", "true");
  expect(edit.querySelector(".buzz-button-spinner")).not.toBeInTheDocument();
  await user.click(edit);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(draft.name);
  expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Check save status" }),
  ).toBeEnabled();
  expect(h.save).not.toHaveBeenCalled();
});
it("unknown outcomes survive remount and checking never invokes Save", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.setAttempt({
    draft: { ...base, name: "Pending name" },
    status: "unconfirmed",
  });
  const first = render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  expect(screen.getByRole("radio", { name: "Temporary" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  expect(screen.getByRole("radio", { name: "Ongoing" })).toBeChecked();
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus();
  first.unmount();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Check save status" }),
    ).toBeEnabled(),
  );
  h.check.mockRejectedValueOnce(new Error("Not yet confirmed"));
  await user.click(screen.getByRole("button", { name: "Check save status" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Not yet confirmed",
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Pending name",
  );
  expect(h.save).not.toHaveBeenCalled();
});
it.each(["channel", "session"])(
  "drops drafts and late reads when the %s changes",
  async (change) => {
    const h = harness(),
      next = harness();
    const user = userEvent.setup();
    const { rerender } = render(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={h.capability}
        channel={channel}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      " private draft",
    );
    const gate = deferred<ChannelDetails>();
    next.load.mockImplementationOnce(() => gate.promise);
    const changedChannel =
      change === "channel" ? { ...channel, id: "beta", name: "Beta" } : channel;
    rerender(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={next.capability}
        channel={changedChannel}
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: "Name" }),
    ).not.toBeInTheDocument();
    rerender(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={h.capability}
        channel={channel}
      />,
    );
    await act(async () => {
      gate.resolve({ ...base, name: "Wrong late name" });
    });
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Alpha");
  },
);
it("keeps details readable without editing authority or host support", async () => {
  const h = harness();
  const loaded = deferred<ChannelDetails>();
  h.load.mockReturnValueOnce(loaded.promise);
  const { rerender } = render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={channel}
      details={h.capability}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(screen.getByText(channel.description)).toBeVisible();
  expect(screen.queryByText("Who can read")).not.toBeInTheDocument();
  const editor = screen.getByRole("complementary", {
    name: "Channel settings",
    hidden: true,
  });
  expect(editor).toHaveAttribute("aria-busy", "true");
  await act(async () => loaded.resolve({ ...base, canEdit: false }));
  expect(editor).toHaveAttribute("aria-busy", "false");
  expect(
    screen.queryByRole("region", { name: "Edit channel details" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Only current channel owners/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Edit / }),
  ).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{ ...channel, readOnly: true }}
      details={h.capability}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(screen.getByText(channel.description)).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Edit channel details" }),
  ).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={channel}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(
    screen.getByText("Editing is unavailable on this connection."),
  ).toBeVisible();
});

it("orders metadata before actions and dismisses each edit layer with Escape", async () => {
  const h = harness();
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={channel}
      details={h.capability}
      setupTools={<button type="button">Leave channel</button>}
      close={close}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  const edit = await screen.findByRole("button", { name: "Edit description" });
  const leave = screen.getByRole("button", { name: "Leave channel" });
  expect(
    screen.getByText(channel.description).compareDocumentPosition(leave) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Channel settings" })).toHaveFocus();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Close Channel settings tab" }),
  ).toHaveFocus();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Edit channel name" }),
  ).toHaveFocus();
  await user.tab();
  expect(edit).toHaveFocus();
  await user.tab();

  expect(screen.getByRole("button", { name: "Copy channel id" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Leave channel" })).toHaveFocus();
  await user.click(edit);
  expect(
    screen.getByRole("dialog", { name: "Edit channel details" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Edit description" }),
  ).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
});
it.each([
  ["an editor", true],
  ["a member", false],
])(
  "links the description for %s without the editor taking its clicks",
  async (_, canEdit) => {
    const h = harness();
    h.load.mockResolvedValue({ ...base, canEdit });
    const user = userEvent.setup();
    const owned = createRelaySession(null);
    const ops = { id: "ops", name: "ops", channelType: "stream" as const };
    const session = {
      ...owned.session,
      channels: {
        ...owned.session.channels,
        list: () => ({ status: "ready" as const, channels: [channel, ops] }),
      },
    };
    const open = vi.fn(() => true);
    const panel = (description: string | undefined) => (
      <ChannelSettingsPanel
        scope="community:viewer"
        channel={{ ...channel, description }}
        details={h.capability}
        session={session}
        onOpenLink={open}
        close={() => {}}
      >
        Diagnostics
      </ChannelSettingsPanel>
    );
    const { rerender } = render(
      panel("R2 runbook: https://example.com/r2-runbook · see #ops"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "Channel settings" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    const edit = screen.queryByRole("button", { name: "Edit description" });
    expect(!!edit).toBe(canEdit);
    const description = screen.getAllByRole("definition")[0];
    if (!description) throw new Error("Missing description");
    await user.click(
      within(description).getByRole("link", {
        name: "https://example.com/r2-runbook",
      }),
    );
    expect(open).toHaveBeenLastCalledWith("https://example.com/r2-runbook");
    await user.click(within(description).getByRole("link", { name: "#ops" }));
    expect(open).toHaveBeenLastCalledWith("buzz://channel/ops");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (edit) {
      // The rendered value follows; its Markdown source would read twice.
      expect(edit).not.toHaveAccessibleDescription();
      await user.click(edit);
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", { name: "Description" }),
        ).toHaveFocus(),
      );
      await user.keyboard("{Escape}");
    }
    for (const [value, shown] of [
      ["", "No description"],
      [undefined, "Not available"],
    ] as const) {
      rerender(panel(value));
      expect(screen.getAllByRole("definition")[0]).toHaveTextContent(shown);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    }
  },
);
it("only enables Save for normalized, changed, valid fields with connected errors", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  const name = screen.getByRole("textbox", { name: "Name" });
  const description = screen.getByRole("textbox", { name: "Description" });
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toBeDisabled();
  fireEvent.change(name, { target: { value: " ## Alpha " } });
  expect(save).toBeDisabled();
  fireEvent.change(name, { target: { value: "### " } });
  expect(name).toHaveAccessibleDescription(/Enter a channel name/);
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(save).toBeDisabled();
  fireEvent.change(name, { target: { value: "😀".repeat(121) } });
  expect(name).toHaveValue("😀".repeat(120));
  fireEvent.change(name, { target: { value: "😀".repeat(120) } });
  expect(save).toBeEnabled();
  expect(name).toHaveAccessibleDescription("120 of 120 characters");
  fireEvent.change(description, { target: { value: "😀".repeat(1001) } });
  expect(description).toHaveValue("😀".repeat(1000));
  expect(description).toHaveAccessibleDescription("1,000 of 1,000 characters");
  expect(save).toBeEnabled();
  fireEvent.change(name, { target: { value: " ## Renamed " } });
  await user.click(save);
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, name: "Renamed", description: "😀".repeat(1000) },
    expect.any(AbortSignal),
  );
});
it.each(["save", "check"] as const)(
  "blocks every dismissal while %s is pending, then restores focus",
  async (operation) => {
    const h = harness();
    const user = userEvent.setup();
    const close = vi.fn();
    const gate = deferred<void>();
    const draft = { ...base, name: "Pending name" };
    if (operation === "check") h.setAttempt({ draft, status: "unconfirmed" });
    h[operation].mockImplementationOnce(async () => {
      if (operation === "save") h.setAttempt({ draft, status: "saving" });
      await gate.promise;
      h.setAttempt(undefined);
    });
    render(
      <ChannelSettingsPanel
        scope="community:viewer"
        channel={channel}
        details={h.capability}
        close={close}
      >
        Diagnostics
      </ChannelSettingsPanel>,
    );
    const edit = await screen.findByRole("button", {
      name: "Edit description",
    });
    expect(edit).toBeEnabled();
    expect(edit).not.toHaveAttribute("aria-busy", "true");
    await user.click(edit);
    const action = await screen.findByRole("button", {
      name: operation === "check" ? "Check save status" : "Save changes",
    });
    await waitFor(() => expect(h.load).toHaveBeenCalledOnce());
    if (operation === "save")
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: draft.name },
      });
    await waitFor(() => expect(action).toBeEnabled());
    await user.click(action);
    try {
      expect(h[operation]).toHaveBeenCalledOnce();
      expect(edit).toHaveAccessibleName("Edit description");
      expect(edit).toBeDisabled();
      expect(edit).toHaveAttribute("aria-busy", "true");
      expect(
        edit.querySelector(".motion-safe\\:animate-spin"),
      ).toBeInTheDocument();
      expect(action).toHaveAttribute("aria-busy", "true");
      expect(
        screen.queryByText(/Saving channel details/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Checking channel permissions/),
      ).not.toBeInTheDocument();
      if (operation === "save")
        expect(
          screen.getByRole("dialog").querySelector("form"),
        ).not.toHaveAttribute("aria-describedby");
      expect(
        screen.getByRole("button", { name: "Close edit channel details" }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Close" }));
      await user.click(
        document.querySelector(".buzz-dialog-backdrop") as Element,
      );
      await user.keyboard("{Escape}");
      await user.click(
        document.querySelector(".buzz-dialog-backdrop") as Element,
      );
      expect(screen.getByRole("dialog")).toHaveAccessibleName(
        "Edit channel details",
      );
      expect(close).not.toHaveBeenCalled();
    } finally {
      await act(async () => gate.resolve());
    }
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(edit).toHaveFocus();
    expect(edit).toBeEnabled();
    expect(edit).not.toHaveAttribute("aria-busy", "true");
    expect(
      edit.querySelector(".motion-safe\\:animate-spin"),
    ).not.toBeInTheDocument();
    expect(h[operation]).toHaveBeenCalledOnce();
    if (operation === "check") expect(h.save).not.toHaveBeenCalled();
  },
);
it("a save that becomes uncertain reopens through a settings row in check-only recovery", async () => {
  const h = harness();
  const user = userEvent.setup();
  const draft = { ...base, name: "Pending name" };
  h.save.mockImplementationOnce(async () => {
    h.setAttempt({ draft, status: "unconfirmed" });
    throw new Error("The change may have been saved.");
  });
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={channel}
      details={h.capability}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Edit description" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: draft.name },
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The change may have been saved.",
  );
  await user.click(
    screen.getByRole("button", { name: "Close edit channel details" }),
  );
  await user.click(screen.getByRole("button", { name: "Edit description" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(draft.name);
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Check save status" }),
  ).toBeEnabled();
  expect(h.save).toHaveBeenCalledOnce();
});
it("failed reload never turns a stale public text draft into intent to reopen", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.save.mockRejectedValueOnce(new Error("Channel details changed"));
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), " edited");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  h.load.mockRejectedValueOnce(new Error("Offline"));
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  const reloaded = { ...base, version: "v2", visibility: "private" as const };
  h.load.mockResolvedValue(reloaded);
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled(),
  );

  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenLastCalledWith(
    reloaded,
    { ...base, name: "Alpha edited", visibility: "private" },
    expect.any(AbortSignal),
  );
});

it.each([
  { field: "Name", threshold: 108, limit: 120, limitLabel: "120" },
  { field: "Description", threshold: 900, limit: 1000, limitLabel: "1,000" },
])(
  "reveals $field length feedback near the limit and caps typing and paste",
  async ({ field, threshold, limit, limitLabel }) => {
    const h = harness();
    const user = userEvent.setup();
    render(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={h.capability}
        channel={channel}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    const input = screen.getByRole("textbox", { name: field });
    expect(
      screen.getByRole("textbox", { name: "Name" }),
    ).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("textbox", { name: "Description" }),
    ).not.toHaveAccessibleDescription();
    fireEvent.change(input, { target: { value: "😀".repeat(threshold - 1) } });
    expect(input).not.toHaveAccessibleDescription();
    await user.type(input, "x");
    const counter = screen.getByText(`${threshold}/${limitLabel}`);
    expect(counter).toHaveAttribute("aria-hidden", "true");
    expect(counter.closest("label")).toHaveTextContent(field);
    expect(input).toHaveAccessibleName(field);
    expect(input).toHaveAccessibleDescription(
      `${threshold} of ${limitLabel} characters`,
    );
    await user.keyboard("{Backspace}");
    expect(
      screen.queryByText(`${threshold}/${limitLabel}`),
    ).not.toBeInTheDocument();
    expect(input).not.toHaveAccessibleDescription();
    await user.clear(input);
    await user.paste("😀".repeat(limit));
    expect(input).toHaveAccessibleDescription(
      `${limitLabel} of ${limitLabel} characters`,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await user.paste("x");
    expect(input).toHaveValue("😀".repeat(limit));
    await user.type(input, "x");
    expect(input).toHaveValue("😀".repeat(limit));
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      `${limitLabel} of ${limitLabel} characters`,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(
      screen.queryByText(`${limit + 1} of ${limitLabel} characters`),
    ).not.toBeInTheDocument();
    await user.clear(input);
    await user.paste("😀".repeat(limit + 20));
    expect(input).toHaveValue("😀".repeat(limit));
    // Inserting at capacity must not silently delete the existing tail.
    const control = input as HTMLInputElement | HTMLTextAreaElement;
    control.setSelectionRange(2, 2);
    await user.paste("overflow");
    expect(input).toHaveValue("😀".repeat(limit));
    control.setSelectionRange(2, 2);
    await user.paste("😀x");
    expect(input).toHaveValue("😀".repeat(limit));
    control.setSelectionRange(2, 6);
    await user.paste("abcdef");
    expect(input).toHaveValue(`😀ab${"😀".repeat(limit - 3)}`);
    expect(control.selectionStart).toBe(4);
    await user.clear(input);
    await user.paste("Short again");
    expect(input).not.toHaveAccessibleDescription();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
  },
);

it.each([
  { field: "Name", key: "name", limit: 120 },
  { field: "Description", key: "description", limit: 1000 },
] as const)(
  "preserves existing over-limit $field text during reductions and replacements",
  async ({ field, key, limit }) => {
    const h = harness();
    const user = userEvent.setup();
    const original = `AB${"😀".repeat(limit + 1)}YZ`;
    h.load.mockResolvedValue({ ...base, [key]: original });
    render(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={h.capability}
        channel={channel}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    const input = screen.getByRole("textbox", { name: field }) as
      | HTMLInputElement
      | HTMLTextAreaElement;
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(input).toHaveValue(original);
    expect(save).toBeDisabled();
    await user.click(input);
    input.setSelectionRange(original.length, original.length);
    await user.keyboard("{Backspace}");
    const reduced = original.slice(0, -1);
    expect(input).toHaveValue(reduced);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();
    input.setSelectionRange(1, 1);
    await user.keyboard("{Delete}");
    const middleDeleted = `A${reduced.slice(2)}`;
    expect(input).toHaveValue(middleDeleted);
    input.setSelectionRange(1, 5);
    await user.paste("x");
    const replaced = `Ax${middleDeleted.slice(5)}`;
    expect(input).toHaveValue(replaced);
    expect(save).toBeDisabled();
    input.setSelectionRange(1, 1);
    await user.paste("no growth");
    expect(input).toHaveValue(replaced);
    input.setSelectionRange(1, 2);
    await user.paste("xyz");
    expect(input).toHaveValue(replaced);
    input.setSelectionRange(2, 6);
    await user.keyboard("{Backspace}");
    expect(input).toHaveValue(`Ax${replaced.slice(6)}`);
    expect([...input.value]).toHaveLength(limit);
    expect(save).toBeEnabled();
    await user.paste("cannot grow now either");
    expect(input).toHaveValue(`Ax${replaced.slice(6)}`);
  },
);

it.each([
  ["\u0085# \u0085#Renamed\u0085", "Renamed"],
  ["\ufeffRenamed\ufeff", "\ufeffRenamed\ufeff"],
])("submits %j with the relay's canonical name", async (input, expected) => {
  const h = harness();
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: input },
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, name: expected },
    expect.any(AbortSignal),
  );
});

it("stages lifetime until Save, preserving access", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  expect(save).toBeEnabled();
  await user.click(screen.getByRole("radio", { name: "Ongoing" }));
  expect(save).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  expect(h.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, ttlSeconds: 604800 },
    expect.any(AbortSignal),
  );
});
it("preserves a custom temporary duration through text editing and deliberate lifetime reversal", async () => {
  const h = harness();
  const custom = { ...base, ttlSeconds: 3600 };
  h.load.mockResolvedValue(custom);
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  expect(screen.getByRole("radio", { name: "Temporary" })).toBeChecked();
  expect(
    screen.getByRole("radio", { name: "Temporary" }),
  ).toHaveAccessibleDescription("Archives after 1 hour without activity.");
  await user.click(screen.getByRole("radio", { name: "Ongoing" }));
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    " edited",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenLastCalledWith(
    custom,
    { ...custom, description: `${base.description} edited` },
    expect.any(AbortSignal),
  );
  await user.click(screen.getByRole("button", { name: "Edit details" }));
  await user.click(screen.getByRole("radio", { name: "Ongoing" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenLastCalledWith(
    custom,
    { ...custom, ttlSeconds: undefined },
    expect.any(AbortSignal),
  );
});
it.each([false, true])(
  "reload preserves edited lifetime but adopts untouched remote duration (edited=%s)",
  async (edited) => {
    const h = harness();
    const user = userEvent.setup();
    h.save.mockRejectedValueOnce(new Error("Channel details changed"));
    render(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={h.capability}
        channel={channel}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), " edited");
    if (edited)
      await user.click(screen.getByRole("radio", { name: "Temporary" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    const reloaded = { ...base, version: "v2", ttlSeconds: 3600 };
    h.load.mockResolvedValue(reloaded);
    await user.click(screen.getByRole("button", { name: "Reload details" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("radio", { name: "Temporary" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(h.save).toHaveBeenLastCalledWith(
      reloaded,
      { ...base, name: "Alpha edited", ttlSeconds: edited ? 604800 : 3600 },
      expect.any(AbortSignal),
    );
  },
);

it.each([
  [3600, 7200],
  [undefined, 7200],
  [3600, undefined],
] as const)(
  "adopts untouched remote duration after a failed reload (%s → %s)",
  async (originalTtl, remoteTtl) => {
    const h = harness();
    const user = userEvent.setup();
    const original = { ...base, ttlSeconds: originalTtl };
    h.load.mockResolvedValue(original);
    h.save.mockRejectedValueOnce(new Error("Channel details changed"));
    render(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={h.capability}
        channel={channel}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), " edited");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    h.load.mockRejectedValueOnce(new Error("Offline"));
    await user.click(screen.getByRole("button", { name: "Reload details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    const reloaded = { ...base, version: "v2", ttlSeconds: remoteTtl };
    const reload = deferred<ChannelDetails>();
    h.load.mockReturnValueOnce(reload.promise);
    await user.click(screen.getByRole("button", { name: "Reload details" }));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await act(async () => reload.resolve(reloaded));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Alpha edited",
    );
    expect(
      screen.getByRole("radio", {
        name: remoteTtl === undefined ? "Ongoing" : "Temporary",
      }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(h.save).toHaveBeenLastCalledWith(
      reloaded,
      { ...original, name: "Alpha edited", ttlSeconds: remoteTtl },
      expect.any(AbortSignal),
    );
  },
);

it("retains an explicit change to Ongoing through a failed conflict reload", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.load.mockResolvedValue({ ...base, ttlSeconds: 3600 });
  h.save.mockRejectedValueOnce(new Error("Channel details changed"));
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.click(screen.getByRole("radio", { name: "Ongoing" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  h.load.mockRejectedValueOnce(new Error("Offline"));
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Offline"),
  );
  const reloaded = { ...base, version: "v2", ttlSeconds: 7200 };
  h.load.mockResolvedValue(reloaded);
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled(),
  );
  expect(screen.getByRole("radio", { name: "Ongoing" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenLastCalledWith(
    reloaded,
    { ...base, ttlSeconds: undefined },
    expect.any(AbortSignal),
  );
});

it("renders status rows only when they have content, not an empty grid row beside Edit", async () => {
  const h = harness();
  const loading = deferred<ChannelDetails>();
  h.load.mockReturnValueOnce(loading.promise);
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  const editor = screen.getByRole("region", { name: "Edit channel details" });
  try {
    expect(editor).toBeEmptyDOMElement();
    expect(
      screen.queryByText(/Checking channel permissions/),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => loading.resolve(base));
  }
  const edit = await screen.findByRole("button", { name: "Edit details" });
  expect([...editor.children]).toEqual([edit]);
  await user.click(edit);
  const form = screen.getByRole("dialog").querySelector("form");
  expect(form).not.toHaveAttribute("aria-describedby");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect([...editor.children]).toEqual([edit]);
  act(() => h.setAttempt({ draft: base, status: "saving" }));
  expect([...editor.children]).toEqual([edit]);
  expect(edit).toBeDisabled();
  expect(edit).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByText(/Saving channel details/)).not.toBeInTheDocument();
  act(() => h.setAttempt({ draft: base, status: "unconfirmed" }));
  expect(within(editor).getByRole("status")).toHaveTextContent(
    "The change may have been saved",
  );
});

it("stages duration steps, preserves the choice across Ongoing, and discards it on Cancel", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  expect(
    screen.queryByRole("button", { name: "Increase duration" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  const shorter = screen.getByRole("button", { name: "Decrease duration" });
  const longer = screen.getByRole("button", { name: "Increase duration" });
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  await user.click(longer);
  await waitFor(() =>
    expect(
      screen.getByText("after 2 weeks", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(longer).toBeDisabled();
  await user.click(shorter);
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  await user.click(shorter);
  await waitFor(() =>
    expect(
      screen.getByText("after 1 day", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(shorter).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: "Ongoing" }));
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await waitFor(() =>
    expect(
      screen.getByText("after 1 day", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(h.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Edit details" }));
  expect(screen.getByRole("radio", { name: "Ongoing" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  await user.click(screen.getByRole("button", { name: "Increase duration" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenCalledExactlyOnceWith(
    base,
    { ...base, ttlSeconds: 1209600 },
    expect.any(AbortSignal),
  );
});

it.each([
  [3600, "1 hour", "Increase duration", 86400],
  [259200, "3 days", "Increase duration", 604800],
  [2592000, "30 days", "Decrease duration", 1209600],
] as const)(
  "preserves custom %s seconds until an explicit step",
  async (ttlSeconds, label, action, expected) => {
    const h = harness();
    const custom = { ...base, ttlSeconds };
    h.load.mockResolvedValue(custom);
    const user = userEvent.setup();
    render(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={h.capability}
        channel={channel}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(`after ${label}`, { selector: "strong" }),
      ).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: action }));
    expect(h.save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(h.save).toHaveBeenCalledExactlyOnceWith(
      custom,
      { ...custom, ttlSeconds: expected },
      expect.any(AbortSignal),
    );
  },
);

it("locks duration adjustment for uncertain saves", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.setAttempt({
    draft: { ...base, ttlSeconds: 604800 },
    status: "unconfirmed",
  });
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  expect(
    screen.getByRole("button", { name: "Decrease duration" }),
  ).toBeDisabled();
  const longer = screen.getByRole("button", { name: "Increase duration" });
  expect(longer).toBeDisabled();
  await user.click(longer);
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(h.save).not.toHaveBeenCalled();
});

it.each(["backdrop", "Escape", "Close"])(
  "guards dirty Edit dismissal via %s and returns intact from confirmation",
  async (dismissal) => {
    // jsdom does not read focus options. Base UI feature-detects preventScroll
    // after outside presses and otherwise suppresses eventual focus return.
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      void options?.preventScroll;
      focus.call(this, options);
    });
    const h = harness();
    const user = userEvent.setup();
    render(
      <ChannelDetailsEditor
        scope="community:viewer"
        capability={h.capability}
        channel={channel}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    const dismiss = async () => {
      if (dismissal === "backdrop")
        await user.click(
          document.querySelector(".buzz-dialog-backdrop") as Element,
        );
      else if (dismissal === "Escape") await user.keyboard("{Escape}");
      else
        await user.click(
          screen.getByRole("button", {
            name: "Close edit channel details",
          }),
        );
    };
    await dismiss();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    await user.type(
      screen.getByRole("textbox", { name: "Description" }),
      " draft",
    );
    const dialog = screen.getByRole("dialog");
    for (const back of ["Keep editing", "Escape", "backdrop", "Close"]) {
      await dismiss();
      expect(screen.getAllByRole("dialog")).toEqual([dialog]);
      expect(dialog).toHaveAccessibleName("Discard changes?");
      expect(
        screen.getByRole("button", { name: "Keep editing" }),
      ).toHaveFocus();
      if (back === "Escape") await user.keyboard("{Escape}");
      else if (back === "backdrop")
        await user.click(
          document.querySelector(".buzz-dialog-backdrop") as Element,
        );
      else
        await user.click(
          screen.getByRole("button", {
            name: back === "Close" ? "Back to edit channel details" : back,
          }),
        );
      expect(dialog).toHaveAccessibleName("Edit channel details");
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
      expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
        `${base.description} draft`,
      );
      expect(h.save).not.toHaveBeenCalled();
    }
    await dismiss();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit details" }),
      ).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      base.description,
    );
  },
);

it("closes reverted edits without confirmation, but guards raw text even when Save is a no-op", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), " draft");
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: base.name },
  });
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await user.click(screen.getByRole("radio", { name: "Ongoing" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Edit details" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: " ## Alpha " },
  });
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Discard changes?");
});

it("protects retained text after a failed authority reload", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.save.mockRejectedValueOnce(new Error("Conflict"));
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), " draft");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
  h.load.mockRejectedValueOnce(new Error("Offline"));
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Offline"),
  );
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Discard changes?");
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Alpha draft",
  );
});

it.each(["description", "channel name"])(
  "opens the full editor from the %s action and returns focus without saving",
  async (field) => {
    const h = harness();
    const user = userEvent.setup();
    render(
      <ChannelSettingsPanel
        scope="community:viewer"
        channel={channel}
        details={h.capability}
        close={() => {}}
      >
        Diagnostics
      </ChannelSettingsPanel>,
    );
    const row = await screen.findByRole("button", { name: `Edit ${field}` });
    expect(row).toHaveAttribute("aria-haspopup", "dialog");
    expect(row).not.toHaveTextContent("Edit");
    expect(row.querySelector("svg")?.parentElement).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(row.querySelector("svg")).toHaveAttribute(
      "width",
      field === "channel name" ? "1rem" : "0.875rem",
    );
    expect(
      screen.queryByRole("button", { name: "Edit details" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Channel type")).not.toBeInTheDocument();
    row.focus();
    await user.keyboard("{Enter}");
    const focusName = field === "description" ? "Description" : "Name";
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: focusName })).toHaveFocus(),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      channel.name,
    );
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      channel.description,
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), " draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(row).toHaveFocus());
    await user.keyboard(" ");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: focusName })).toHaveFocus(),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      channel.name,
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(row).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Edit channel name" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus(),
    );
    expect(h.save).not.toHaveBeenCalled();
  },
);

it.each([
  { readOnly: true as const },
  { cached: true as const },
  { archived: true as const },
  { channelType: "dm" as const },
  { channelType: "solo" as const },
])("omits inline edit actions for ineligible channels %j", (flags) => {
  const h = harness();
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{ ...channel, ...flags }}
      details={h.capability}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(
    screen.queryByRole("button", { name: /^Edit / }),
  ).not.toBeInTheDocument();
  expect(h.load).not.toHaveBeenCalled();
});

it("keeps invited-only Read access intact when editing details", async () => {
  const h = harness();
  const current = {
    ...base,
    visibility: "private" as const,
    joinRole: "guest" as const,
  };
  h.load.mockResolvedValue(current);
  const user = userEvent.setup();
  render(
    <ChannelDetailsEditor
      scope="community:viewer"
      capability={h.capability}
      channel={channel}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Private" }),
  ).not.toBeInTheDocument();
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    " updated",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.save).toHaveBeenCalledWith(
    current,
    { ...current, description: `${current.description} updated` },
    expect.any(AbortSignal),
  );
});
