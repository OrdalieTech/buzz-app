// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, workspaceFixture, advance, gate } from "./ui-testing";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { expect, it, vi, type MockInstance } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { docKey, docTemplate, docUrl } from "./model";
import type { RelaySession } from "../../features/relay/session";
import { ReadError } from "../../features/relay/errors";
import { eventDto } from "../../features/relay/events";
import { docTools } from "./tools";
import type { DocsWorkspace } from "./workspace";
import { DocDocument } from "./DocDocument";
import { DocMarkdown } from "./DocMarkdown";

composerDOMFixture();

it.each([false, true])(
  "keeps controls in place while loading a doc (cached draft: %s)",
  async (cachedDraft) => {
    const f = await workspaceFixture();
    const doc = f.seed("Plan", "Body");
    if (cachedDraft) {
      f.workspace.drafts.set(docKey(doc), {
        base: doc,
        title: doc.title,
        markdown: "Unsaved draft",
      });
    }
    const read = gate();
    const open = f.workspace.open;
    vi.spyOn(f.workspace, "open").mockImplementation(async (...args) => {
      await read.promise;
      return open(...args);
    });
    render(
      <DocDocument address={doc} workspace={f.workspace} onOpen={vi.fn()} />,
    );
    try {
      const article = screen.getByRole("article", { name: "Loading doc" });
      expect(within(article).queryByRole("heading")).not.toBeInTheDocument();
      const mode = screen.getByRole("combobox", { name: "Doc mode" });
      expect(mode).toBeDisabled();
      expect(mode).toHaveTextContent(/^$/);
      expect(screen.queryByRole("button", { name: "Refresh doc" })).toBeNull();
      for (const name of ["Share doc", "Doc actions"]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
    } finally {
      read.release();
    }
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Doc actions" })).toBeEnabled(),
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Plan");
    expect(screen.getByRole("status")).toHaveTextContent(
      cachedDraft ? "Unsaved changes" : /^Saved /,
    );
  },
);

it("continues editing a just-created doc while its first refresh is pending", async () => {
  const f = await workspaceFixture();
  const doc = f.seed("Plan", "Saved body");
  f.workspace.drafts.set(docKey(doc), {
    base: doc,
    title: doc.title,
    markdown: "Newer draft",
  });
  const read = gate();
  const open = f.workspace.open;
  vi.spyOn(f.workspace, "open").mockImplementation(async (...args) => {
    await read.promise;
    return open(...args);
  });
  render(
    <DocDocument
      address={doc}
      created={{ doc, focus: undefined, source: false }}
      workspace={f.workspace}
      onOpen={vi.fn()}
    />,
  );
  try {
    const title = screen.getByRole("textbox", { name: "Title" });
    expect(title).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Doc mode" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Doc body" })).toHaveTextContent(
      "Newer draft",
    );
    fireEvent.change(title, {
      target: { value: "Typing through first refresh" },
    });
    expect(title).toHaveValue("Typing through first refresh");
  } finally {
    await act(async () => read.release());
  }
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
    "Typing through first refresh",
  );
});

async function fixture() {
  const followers = new Set<
    Parameters<RelaySession["artifacts"]["follow"]>[1]
  >();
  let revoke: (() => void) | undefined;
  const f = await workspaceFixture({ live: true }, (session) => ({
    ...session,
    artifacts: {
      ...session.artifacts,
      follow(ids, listener, revoked) {
        followers.add(listener);
        revoke = () => revoked?.(ids);
        const stop = session.artifacts.follow(ids, listener, revoked);
        return () => {
          followers.delete(listener);
          stop();
        };
      },
    },
  }));
  const { workspace } = f;
  const doc = f.seed("Plan", "Original body");
  const realSave = workspace.save;
  const save = vi.spyOn(workspace, "save");
  const onChange = vi.fn();
  const view = render(
    <StrictMode>
      <DocDocument
        address={doc}
        workspace={workspace}
        onOpen={vi.fn()}
        onChange={onChange}
      />
    </StrictMode>,
  );
  const title = await screen.findByRole("textbox", { name: "Title" });
  await waitFor(() => {
    expect(title).toHaveValue("Plan");
    expect(title).toBeEnabled();
  });
  vi.useFakeTimers();
  const change = (value: string) =>
    fireEvent.change(title, { target: { value } });
  return {
    ...f,
    workspace,
    doc,
    save,
    realSave,
    view,
    title,
    change,
    onChange,
    revoke: () => revoke?.(),
    echo(event: unknown) {
      for (const listener of followers) listener([eventDto(event)]);
    },
  };
}
async function saved(save: MockInstance<DocsWorkspace["save"]>) {
  await act(async () => {
    await Promise.allSettled([save.mock.results.at(-1)?.value]);
  });
}

it("auto-saves after idle and skips unchanged content", async () => {
  const f = await fixture();
  await advance(10_000);
  expect(f.save).not.toHaveBeenCalled();
  f.change("Final plan");
  expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  expect(
    screen.queryByRole("button", { name: "Discard changes" }),
  ).not.toBeInTheDocument();
  await advance(1499);
  expect(f.save).not.toHaveBeenCalled();
  await advance(1);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.title).toHaveValue("Final plan");
  expect(f.title).not.toHaveAttribute("readonly");
  expect(screen.getByRole("status")).toHaveTextContent("Saved");
  expect(
    screen.queryByRole("button", { name: /^Save$/ }),
  ).not.toBeInTheDocument();
  expect(f.workspace.drafts.size).toBe(0);
  f.change("Final plan");
  await advance(10_000);
  expect(f.save).toHaveBeenCalledOnce();
});

it("waits for idle throughout continuous typing and composition", async () => {
  const f = await fixture();
  for (let index = 0; index < 12; index++) {
    f.change(`Plan ${index}`);
    await advance(1000);
    expect(f.save).not.toHaveBeenCalled();
  }
  fireEvent.compositionStart(f.title);
  f.change("Composing");
  await advance(15_000);
  expect(f.save).not.toHaveBeenCalled();
  fireEvent.compositionEnd(f.title);
  await advance(1499);
  expect(f.save).not.toHaveBeenCalled();
  await advance(1);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.save.mock.calls[0]?.[1].title).toBe("Composing");
});

it("saves a trimmed title once while preserving the text in the active field", async () => {
  const f = await fixture();
  f.change("New plan ");
  await advance(1500);
  await saved(f.save);
  expect((await f.workspace.open(f.doc)).title).toBe("New plan");
  expect(f.title).toHaveValue("New plan ");
  expect(screen.getByRole("status")).toHaveTextContent(/^Saved/);
  await advance(15_000);
  expect(f.save).toHaveBeenCalledOnce();
});

it("pauses after a failed save, retains the draft, and retries only on request", async () => {
  const f = await fixture();
  f.failNextArtifact();
  f.change("Unsaved plan");
  await advance(1500);
  await saved(f.save);
  expect(screen.getByRole("alert")).toHaveTextContent("Auto-save is paused");
  expect(f.workspace.drafts.get(docKey(f.doc))?.title).toBe("Unsaved plan");
  await advance(30_000);
  expect(f.save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps typing through a pending receipt and reconciles its live echo against the accepted base", async () => {
  const f = await fixture();
  const receipt = gate();
  const accepted = gate();
  f.save.mockImplementationOnce(async (...args) => {
    const next = await f.realSave(...args);
    accepted.release();
    await receipt.promise;
    return next;
  });
  f.change("First revision");
  await advance(1500);
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  const mode = screen.getByRole("combobox", { name: "Doc mode" });
  expect(mode).toBeEnabled();
  await act(async () => {
    await accepted.promise;
  });
  const event = f.heads.get(f.doc.id);
  if (!event) throw new Error("Missing accepted head");
  expect(f.title).toBeEnabled();
  f.change("Newer draft");
  expect(f.title).toHaveValue("Newer draft");
  await advance(15_000);
  expect(f.save).toHaveBeenCalledOnce();
  const refresh = gate();
  const open = f.workspace.open;
  const read = vi
    .spyOn(f.workspace, "open")
    .mockImplementationOnce(async (...args) => {
      await refresh.promise;
      return open(...args);
    });
  await act(async () => f.echo(event));
  expect(read).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  try {
    f.title.focus();
    receipt.release();
    await saved(f.save);
    expect(read).toHaveBeenCalledOnce();
    expect(f.title).toBeEnabled();
    expect(f.title).toHaveFocus();
    expect(mode).toBeEnabled();
    expect(
      screen.getByRole("textbox", { name: "Doc body" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    f.change("Typing during reconciliation");
  } finally {
    receipt.release();
    await act(async () => {
      refresh.release();
      await read.mock.results[0]?.value;
    });
  }
  expect(f.title).toHaveValue("Typing during reconciliation");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await advance(1500);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.save.mock.calls[1]?.[0].revision).toBe(event.id);
  expect(f.save.mock.calls[1]?.[1].title).toBe("Typing during reconciliation");
  expect(f.workspace.drafts.size).toBe(0);
});

it("accepts a remote revision while clean and editing, then preserves a dirty draft on a later remote edit", async () => {
  const f = await fixture();
  const markdown = "## Risks\n- First item\n- Second item\n";
  const next = await f.edit(f.carl, f.doc, {
    title: "Remote title",
    markdown,
  });
  await act(async () => {
    f.echo(next);
  });
  expect(f.title).toHaveValue("Remote title");
  expect(screen.getByRole("textbox", { name: "Doc body" })).toHaveTextContent(
    "First item",
  );
  await advance(10_000);
  expect(f.save).not.toHaveBeenCalled();
  expect((await f.workspace.open(f.doc)).markdown).toBe(markdown);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  f.change("My newer draft");
  const later = await f.edit(f.carl, f.doc, {
    title: "Later remote title",
    markdown: "Later body",
  });
  await act(async () => {
    f.echo(later);
  });
  expect(f.title).toHaveValue("My newer draft");
  expect(
    screen.getByRole("dialog", { name: "This doc has a newer revision" }),
  ).toBeVisible();
  await advance(15_000);
  expect(f.save).not.toHaveBeenCalled();
});

it("offers a quiet refresh after a transient update error and hides it after recovery", async () => {
  const f = await fixture();
  vi.useRealTimers();
  const refresh = () => screen.queryByRole("button", { name: "Refresh doc" });
  expect(refresh()).toBeNull();
  const next = await f.edit(f.carl, f.doc, {
    title: "Remote plan",
    markdown: "Another edit",
  });
  vi.spyOn(f.workspace, "open").mockRejectedValueOnce(
    new ReadError("unavailable", "Relay read failed (503)", 503),
  );
  await act(async () => f.echo(next));
  expect(f.title).toHaveValue("Plan");
  expect(f.title).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh doc" }));
  await waitFor(() => {
    expect(f.title).toHaveValue("Remote plan");
    expect(refresh()).toBeNull();
  });
});

it("shows refresh during a live update interruption", async () => {
  let status: ReturnType<RelaySession["live"]["snapshot"]>["status"] =
    "connected";
  let notify = () => {};
  const f = await workspaceFixture({ live: true }, (session) => ({
    ...session,
    live: {
      ...session.live,
      snapshot: () => ({ ...session.live.snapshot(), status }),
      subscribe(listener) {
        notify = listener;
        return session.live.subscribe(listener);
      },
    },
  }));
  const doc = f.seed("Plan", "Body");
  render(
    <DocDocument address={doc} workspace={f.workspace} onOpen={vi.fn()} />,
  );
  await screen.findByRole("article", { name: "Plan" });
  const refresh = () => screen.queryByRole("button", { name: "Refresh doc" });
  expect(refresh()).toBeNull();
  act(() => {
    status = "retrying";
    notify();
  });
  expect(refresh()).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => {
    status = "connected";
    notify();
  });
  expect(refresh()).toBeNull();
});

it("preserves a concurrent draft and does not overwrite until the user resolves the conflict", async () => {
  const f = await fixture();
  f.change("My draft");
  await f.edit(f.carl, f.doc, {
    title: "Agent plan",
    markdown: "# Latest plan\n\n- Another edit",
  });
  await advance(1500);
  await saved(f.save);
  const conflict = within(
    screen.getByRole("dialog", { name: "This doc has a newer revision" }),
  );
  const preview = within(
    conflict.getByRole("region", { name: "Latest revision" }),
  );
  expect(preview.getByRole("heading", { name: "Latest plan" })).toBeVisible();
  expect(preview.getByRole("listitem")).toHaveTextContent("Another edit");
  expect(f.title).toHaveValue("My draft");
  await advance(30_000);
  expect(f.save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
  await advance(1500);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.title).toHaveValue("My draft");
  expect(f.save.mock.calls[1]?.[0].title).toBe("Agent plan");
});

it("copies a pending draft before opening the remotely trashed version", async () => {
  const f = await fixture();
  userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const copy = vi.spyOn(navigator.clipboard, "writeText");
  f.change("Pending title");
  const event = await f
    .client(f.ned)
    .publish(docTemplate(f.doc, { title: "", markdown: "" }, f.doc, "delete"));
  await act(async () => f.echo(event));
  const dialog = screen.getByRole("dialog", {
    name: "This doc was moved to Trash",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Copy draft" }));
  expect(copy).toHaveBeenCalledWith("Pending title\n\nOriginal body");
  expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Open in Trash" }),
  );
  expect(screen.getByText("This doc is in Trash.")).toBeVisible();
});

it("retains an undo made during a save when the tab closes and reopens", async () => {
  const f = await fixture();
  const receipt = gate();
  const accepted = gate();
  f.save.mockImplementationOnce(async (...args) => {
    const next = await f.realSave(...args);
    accepted.release();
    await receipt.promise;
    return next;
  });
  f.change("Published in flight");
  await advance(1500);
  await act(async () => accepted.promise);
  f.change("Plan");
  f.view.unmount();
  render(
    <DocDocument address={f.doc} workspace={f.workspace} onOpen={vi.fn()} />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  receipt.release();
  await saved(f.save);
  const dialog = screen.getByRole("dialog", {
    name: "This doc has a newer revision",
  });
  expect(dialog).toHaveTextContent("Published in flight");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Keep my draft" }),
  );
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Plan");
  await advance(1500);
  await saved(f.save);
  expect((await f.workspace.open(f.doc)).title).toBe("Plan");
});

it("cancels idle saves on unmount while retaining the workspace draft", async () => {
  const f = await fixture();
  f.change("Keep this draft");
  f.view.unmount();
  await advance(10_000);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.workspace.drafts.get(docKey(f.doc))?.title).toBe("Keep this draft");
});

async function historyFixture(deleted = false) {
  const f = await fixture();
  vi.useRealTimers();
  const current = await f.realSave(
    f.doc,
    { title: "New plan", markdown: deleted ? "" : "New body" },
    deleted ? "delete" : "update",
  );
  await act(async () => f.echo(current.event));
  if (deleted) await screen.findByRole("heading", { name: "Plan (in Trash)" });
  else await waitFor(() => expect(f.title).toHaveValue("New plan"));
  return { ...f, current };
}
async function previewOriginal() {
  fireEvent.click(screen.getByRole("button", { name: "Doc actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Revision history" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Plan/ }));
  const preview = await screen.findByRole("dialog", {
    name: "Revision preview",
  });
  await within(preview).findByRole("region", { name: "Selected revision" });
  return preview;
}
it("restores immediately as a new head and keeps history", async () => {
  const f = await historyFixture();
  const preview = await previewOriginal();
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(f.title).toHaveValue("Plan");
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.save.mock.calls[0]?.[0].revision).toBe(f.current.revision);
  expect(f.save.mock.calls[0]?.[2]).toBe("update");
  const history = await f.workspace.history(f.doc);
  expect(history.revisions.map((doc) => doc.markdown)).toEqual([
    "Original body",
    "New body",
    "Original body",
  ]);
  expect(history.revisions[0]?.revision).not.toBe(f.doc.revision);
  expect(f.workspace.drafts.size).toBe(0);
});
it("confirms pending edits, cancels without saving, and keeps the draft on restore failure", async () => {
  const f = await historyFixture();
  f.change("Keep my draft");
  const preview = await previewOriginal();
  vi.useFakeTimers();
  await advance(15_000);
  expect(f.save).not.toHaveBeenCalled();
  vi.useRealTimers();
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  const confirm = await screen.findByRole("alertdialog", {
    name: "Replace unsaved changes?",
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(f.title).toHaveValue("Keep my draft");
  expect(f.save).not.toHaveBeenCalled();
  f.failNextArtifact();
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Replace and restore" }),
  );
  await within(preview).findByRole("alert");
  expect(f.title).toHaveValue("Keep my draft");
  expect(f.workspace.drafts.get(docKey(f.doc))?.title).toBe("Keep my draft");
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Replace and restore" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(f.title).toHaveValue("Plan");
});
it("protects a pending restoration and reconciles its live echo", async () => {
  const f = await historyFixture();
  const pending = gate();
  const accepted = gate();
  f.save.mockImplementationOnce(async (...args) => {
    const next = await f.realSave(...args);
    accepted.release();
    await pending.promise;
    return next;
  });
  const preview = await previewOriginal();
  try {
    fireEvent.click(
      within(preview).getByRole("button", { name: "Restore this version" }),
    );
    await act(async () => {
      await accepted.promise;
    });
    expect(
      within(preview).getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
    expect(
      within(preview).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    fireEvent.click(within(preview).getByRole("button", { name: "Close" }));
    expect(preview).toBeInTheDocument();
    act(() => f.echo(f.heads.get(f.doc.id)));
  } finally {
    pending.release();
  }
  await saved(f.save);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(f.title).toHaveValue("Plan");
});
it("preserves a draft when another author wins before restore", async () => {
  const f = await historyFixture();
  f.change("My pending draft");
  const preview = await previewOriginal();
  await f.edit(f.carl, f.current, {
    title: "Remote winner",
    markdown: "Keep remote",
  });
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Replace and restore" }),
  );
  await screen.findByRole("dialog", { name: "This doc has a newer revision" });
  expect(f.title).toHaveValue("My pending draft");
  expect((await f.workspace.open(f.doc)).title).toBe("Remote winner");
});
it("keeps a deleted doc hidden and restores a selected revision after a failed write", async () => {
  const f = await historyFixture(true);
  expect(screen.getByRole("status")).toHaveTextContent("Moved to Trash");
  expect(screen.getByText("This doc is in Trash.")).toBeVisible();
  expect(screen.queryByText("Original body")).toBeNull();
  expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
  const preview = await previewOriginal();
  const restore = within(preview).getByRole("button", {
    name: "Restore this version",
  });
  f.save.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(restore);
  await within(preview).findByText("Offline");
  expect(within(preview).getByText("Original body")).toBeVisible();
  fireEvent.click(restore);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect((await f.workspace.open(f.doc)).markdown).toBe("Original body");
  expect(f.save.mock.calls[0]?.[2]).toBe("restore");
  expect(f.save.mock.calls[0]?.[1].restoreFrom?.revision).toBe(f.doc.revision);
});

it("shows the retained title to a reader and keeps the body in revision history", async () => {
  const f = await workspaceFixture();
  const doc = f.seed("Plan", "# Earlier draft\n\nOriginal **body**");
  const storage = f.channels.get(doc.channel);
  if (!storage) throw new Error("Missing doc storage");
  storage.creator = f.sam.pubkey;
  storage.roles = { [f.sam.pubkey]: "owner", [f.viewer.pubkey]: "guest" };
  await f
    .client(f.sam)
    .publish(
      docTemplate(doc, { title: doc.title, markdown: "" }, doc, "delete"),
    );
  render(
    <DocDocument address={doc} workspace={f.workspace} onOpen={vi.fn()} />,
  );
  await screen.findByRole("heading", { name: "Plan (in Trash)" });
  expect(screen.queryByRole("heading", { name: "Earlier draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  const preview = await previewOriginal();
  expect(
    within(preview).getByRole("heading", { name: "Earlier draft" }),
  ).toBeVisible();
  expect(
    within(preview).getByText("body", { selector: "strong" }),
  ).toBeVisible();
  expect(
    within(preview).queryByRole("button", { name: "Restore this version" }),
  ).toBeNull();
});

it("keeps formatted Buzz conversation links and Page navigation through the shared Markdown owner", async () => {
  const f = await workspaceFixture();
  const doc = f.seed("Target", "Body");
  const openPage = vi.fn();
  const openLink = vi.fn(() => true);
  const message = `buzz://message?channel=${doc.channel}&id=${"a".repeat(64)}`;
  const view = render(
    <DocMarkdown
      text={`[the **thread**](${message}) and [target page](<${docUrl(doc, f.origin)}>) and [unsafe](javascript:alert(1))\n\n| Item | Status |\n| --- | --- |\n| Plan | Ready |`}
      community={f.origin}
      session={f.session}
      onOpen={openPage}
      openLink={openLink}
    />,
  );
  try {
    expect(
      within(screen.getByRole("table")).getByRole("cell", { name: "Ready" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "the thread" }));
    expect(openLink).toHaveBeenCalledWith(message);
    fireEvent.click(screen.getByRole("link", { name: "target page" }));
    expect(openPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: doc.id, channel: doc.channel }),
    );
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
  } finally {
    view.unmount();
  }
});

it("does not let an older head replace a newer one after a slow authority read", async () => {
  const f = await fixture();
  const older = await f.edit(f.viewer, f.doc, {
    title: "Older head",
    markdown: "Original body",
  });
  const entered = gate();
  const delayed = gate();
  const authority = f.workspace.authority;
  vi.spyOn(f.workspace, "authority").mockImplementationOnce(async (id) => {
    entered.release();
    await delayed.promise;
    return authority(id);
  });
  try {
    act(() => f.echo(older));
    await act(async () => entered.promise);
    const newer = await f.edit(f.viewer, f.doc, {
      title: "Newer head",
      markdown: "Original body",
    });
    await act(async () => f.echo(newer));
    expect(f.title).toHaveValue("Newer head");
  } finally {
    await act(async () => delayed.release());
  }
  expect(f.title).toHaveValue("Newer head");
});

it("hides a draft immediately when access is revoked mid-save and remains hidden on a transient error", async () => {
  const f = await fixture();
  const receipt = gate();
  f.save.mockImplementationOnce(async (...args) => {
    await receipt.promise;
    return f.realSave(...args);
  });
  f.change("Unpublished title");
  await advance(1500);
  vi.spyOn(f.workspace, "open").mockRejectedValueOnce(
    new ReadError("unavailable", "Relay unavailable", 503),
  );
  try {
    act(f.revoke);
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Doc body" })).toBeNull();
  } finally {
    receipt.release();
  }
  await saved(f.save);
  expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("Relay unavailable");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh doc" }));
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
    "Unpublished title",
  );
});

it("reports access loss to the tab before its refresh finishes", async () => {
  let revoke: (() => void) | undefined;
  const f = await workspaceFixture({ live: true }, (session) => ({
    ...session,
    artifacts: {
      ...session.artifacts,
      follow(ids, listener, revoked) {
        revoke = () => revoked?.(ids);
        return session.artifacts.follow(ids, listener, revoked);
      },
    },
  }));
  const doc = f.seed("Live document", "Original body");
  const onUnavailable = vi.fn();
  render(
    <DocDocument
      address={doc}
      workspace={f.workspace}
      onOpen={vi.fn()}
      onUnavailable={onUnavailable}
    />,
  );
  await screen.findByRole("article", { name: "Live document" });
  const pending = gate();
  const refresh = vi
    .spyOn(f.workspace, "open")
    .mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("Access removed");
    });
  try {
    act(() => revoke?.());
    expect(refresh).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith(doc);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    pending.release();
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Access removed");
});

it("keeps only the mounted Page channel live and receives a tool save through its transport", async () => {
  const f = await workspaceFixture({ live: true });
  const { workspace } = f;
  const doc = f.seed("Live document", "Original body");
  const view = render(
    <DocDocument
      address={doc}
      workspace={workspace}
      onOpen={vi.fn()}
      onChange={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Live document",
    ),
  );
  expect(f.liveChannels()).toContain(doc.channel);
  const set = docTools(() => workspace).find((tool) => tool.name === "doc_set");
  if (!set) throw new Error("Missing doc_set");
  await act(async () => {
    await set.call(
      f.client(),
      {},
      {
        id: doc.id,
        channel: doc.channel,
        revision: doc.revision,
        title: doc.title,
        text: "Updated by the agent",
      },
    );
    const event = f.heads.get(doc.id);
    if (!event) throw new Error("Missing accepted revision");
    f.deliver(event);
  });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: /^Doc body$/ }),
    ).toHaveTextContent("Updated by the agent"),
  );
  view.unmount();
  expect(f.liveChannels()).not.toContain(doc.channel);
});
