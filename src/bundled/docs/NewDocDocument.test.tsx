// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, workspaceFixture, advance, gate } from "./ui-testing";
import { act, fireEvent, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { docKey } from "./model";
import { NewDocDocument, type NewDraft } from "./NewDocDocument";

async function fixture(initial: Partial<NewDraft> = {}) {
  const f = await workspaceFixture();
  const { workspace } = f;
  const realCreate = workspace.create;
  const create = vi.spyOn(workspace, "create");
  const onCreated = vi.fn();
  const onDraftChange = vi.fn();
  const props = {
    workspace,
    active: true,
    initial: {
      id: crypto.randomUUID(),
      title: "",
      markdown: "",
      ...initial,
    },
    onCreated,
    onDraftChange,
  };
  vi.useFakeTimers();
  const view = render(
    <StrictMode>
      <NewDocDocument {...props} />
    </StrictMode>,
  );
  return {
    ...f,
    workspace,
    create,
    realCreate,
    onCreated,
    onDraftChange,
    async finishCreate() {
      await act(async () => {
        await create.mock.results.at(-1)?.value;
      });
    },
    props,
    view,
    title: screen.getByRole("textbox", { name: "Title" }),
  };
}

it("opens a fresh editor without allocating storage, then auto-saves after idle", async () => {
  const f = await fixture();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Share doc" })).toBeNull();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await advance(16);
  expect(f.title).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Doc body" })).toBeVisible();
  await advance(15_000);
  expect(f.create).not.toHaveBeenCalled();
  fireEvent.change(f.title, { target: { value: "Final plan" } });
  await advance(1499);
  expect(f.create).not.toHaveBeenCalled();
  await advance(1);
  await f.finishCreate();
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({
    title: "Final plan",
    id: f.props.initial.id,
  });
  expect(f.onCreated).toHaveBeenCalledOnce();
  expect(f.onDraftChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Final plan" }),
  );
});

it("auto-saves body-only docs with an untitled fallback", async () => {
  const f = await fixture({ markdown: "First thought" });
  fireEvent.click(screen.getByRole("button", { name: "Doc actions" }));
  await advance(0);
  expect(
    screen.getByRole("menuitem", { name: "Markdown source" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("menuitem", { name: "Revision history" }),
  ).toBeNull();
  expect(f.create).not.toHaveBeenCalled();
  await advance(1500);
  await f.finishCreate();
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({
    title: "Untitled doc",
    markdown: "First thought",
  });
});

it.each(["typing", "composition"])(
  "defers first-save handoff through %s and retains selection",
  async (input) => {
    const f = await fixture({ title: "First title" });
    const pending = gate();
    f.create.mockImplementationOnce(async (...args) => {
      await pending.promise;
      return f.realCreate(...args);
    });
    try {
      await advance(1500);
      expect(f.create).toHaveBeenCalledOnce();
      if (input === "composition") fireEvent.compositionStart(f.title);
      fireEvent.change(f.title, { target: { value: "Newer title" } });
      f.title.focus();
      if (!(f.title instanceof HTMLTextAreaElement))
        throw new Error("Missing title field");
      f.title.setSelectionRange(2, 5);
      expect(f.title).toBeEnabled();
      pending.release();
      await f.finishCreate();
      expect(f.onCreated).not.toHaveBeenCalled();
      if (input === "composition") {
        await advance(15_000);
        expect(f.onCreated).not.toHaveBeenCalled();
        fireEvent.compositionEnd(f.title);
      }
      await advance(1000);
      fireEvent.change(f.title, { target: { value: "Still typing" } });
      f.title.setSelectionRange(2, 5);
      await advance(1499);
      expect(f.onCreated).not.toHaveBeenCalled();
      expect(f.title).toHaveFocus();
      await advance(1);
      expect(f.onCreated).toHaveBeenCalledOnce();
      const created = f.onCreated.mock.calls[0]?.[0];
      if (!created) throw new Error("Missing first-save handoff");
      const { doc, focus } = created;
      expect(f.workspace.drafts.get(docKey(doc))?.title).toBe("Still typing");
      expect(focus).toMatchObject({ target: "title", start: 2, end: 5 });
    } finally {
      pending.release();
    }
  },
);

it("pauses on an uncertain receipt and retries the original identity and payload", async () => {
  const f = await fixture({ title: "First title" });
  f.loseNextReceipt();
  await advance(1500);
  await act(async () => {
    await f.create.mock.results[0]?.value.catch(() => {});
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Doc creation was not confirmed",
  );
  fireEvent.change(f.title, { target: { value: "Edited after failure" } });
  await advance(15_000);
  expect(f.create).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await f.finishCreate();
  expect(f.create.mock.calls[1]?.[0]).toEqual(f.create.mock.calls[0]?.[0]);
  const doc = f.onCreated.mock.calls[0]?.[0]?.doc;
  expect(f.workspace.drafts.get(docKey(doc))?.title).toBe(
    "Edited after failure",
  );
  expect(f.heads.size).toBe(1);
});

it("retries a locally rejected first draft with corrected text and the same ID", async () => {
  const f = await fixture({ title: "x".repeat(513) });
  await advance(1500);
  await act(async () => {
    await f.create.mock.results[0]?.value.catch(() => {});
  });
  expect(screen.getByRole("alert")).toBeVisible();
  expect(f.channels.size).toBe(0);
  fireEvent.change(f.title, { target: { value: "Shorter title" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await f.finishCreate();
  expect(f.onCreated.mock.calls[0]?.[0]?.doc).toMatchObject({
    id: f.props.initial.id,
    title: "Shorter title",
  });
});

it("defers first save while a draft is hidden or the user is still typing", async () => {
  const f = await fixture();
  fireEvent.change(f.title, { target: { value: "Hidden draft" } });
  f.view.rerender(
    <StrictMode>
      <NewDocDocument {...f.props} active={false} />
    </StrictMode>,
  );
  await advance(15_000);
  expect(f.create).not.toHaveBeenCalled();
  f.view.rerender(
    <StrictMode>
      <NewDocDocument {...f.props} active />
    </StrictMode>,
  );
  const title = screen.getByRole("textbox", { name: "Title" });
  for (let index = 0; index < 12; index++) {
    fireEvent.change(title, { target: { value: `Plan ${index}` } });
    await advance(1000);
    expect(f.create).not.toHaveBeenCalled();
  }
  await advance(499);
  expect(f.create).not.toHaveBeenCalled();
  await advance(1);
  await f.finishCreate();
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.create.mock.calls[0]?.[0].title).toBe("Plan 11");
});

it("cancels first-save authority when the creation surface unmounts", async () => {
  const f = await fixture({ title: "Scoped draft" });
  const pending = gate();
  f.create.mockImplementationOnce(async (input, signal) => {
    await pending.promise;
    signal?.throwIfAborted();
    return f.realCreate(input, signal);
  });
  try {
    await advance(1500);
    expect(f.create).toHaveBeenCalledOnce();
    f.view.unmount();
    expect(f.create.mock.calls[0]?.[1]?.aborted).toBe(true);
    pending.release();
    await act(async () => {
      await f.create.mock.results[0]?.value.catch(() => {});
    });
    expect(f.heads.size).toBe(0);
    expect(f.onCreated).not.toHaveBeenCalled();
  } finally {
    pending.release();
  }
});
