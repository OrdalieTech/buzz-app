// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ReadError } from "../../features/relay/errors";
import { eventDto } from "../../features/relay/events";
import { advance, gate, render, workspaceFixture } from "./ui-testing";
import { WorkingDocsCommunity } from "./WorkingDocsPage";

it.each([false, true])(
  "keeps New doc available while loading the collection (slow: %s)",
  async (slow) => {
    const f = await workspaceFixture();
    f.seed("Research plan", "Body");
    const read = gate();
    const list = f.workspace.list;
    const request = vi.spyOn(f.workspace, "list");
    request.mockImplementationOnce(async (...args) => {
      await read.promise;
      return list(...args);
    });
    vi.useFakeTimers();
    render(<WorkingDocsCommunity workspace={f.workspace} />);
    const create = screen.getByRole("button", { name: "New doc" });
    const region = create.closest('[aria-busy="true"]');
    try {
      expect(request).toHaveBeenCalledOnce();
      expect(region).not.toBeNull();
      expect(create).toBeEnabled();
      expect(screen.queryByText("No docs yet")).not.toBeInTheDocument();
      await act(() => create.focus());
      await advance(999);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      if (slow) {
        await advance(1);
        expect(screen.getByRole("status")).toHaveTextContent("Loading docs…");
      }
    } finally {
      await act(async () => {
        read.release();
        await request.mock.results[0]?.value;
      });
    }
    expect(region).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(create).toHaveFocus();
    expect(screen.getByRole("link", { name: "Research plan" })).toBeVisible();
  },
);

it("recovers from a cancelled read and offers an inline retry after a failure", async () => {
  const f = await workspaceFixture();
  f.seed("Research plan", "Body");
  const request = vi
    .spyOn(f.workspace, "list")
    .mockRejectedValueOnce(
      new DOMException("Relay read cancelled", "AbortError"),
    )
    .mockRejectedValueOnce(new Error("Relay unavailable"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.useFakeTimers();
  render(<WorkingDocsCommunity workspace={f.workspace} />);

  await advance(499);
  expect(request).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await advance(1);
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("alert")).toHaveTextContent("Relay unavailable");
  expect(screen.queryByText("No docs yet")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await act(async () => {
    await request.mock.results.at(-1)?.value;
  });
  expect(request).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Research plan" })).toBeVisible();
});

it("quietly offers refresh when a live doc update cannot be read", async () => {
  const f = await workspaceFixture({ live: true });
  const doc = f.seed("Research plan", "Original body");
  render(<WorkingDocsCommunity workspace={f.workspace} />);
  await screen.findByRole("link", { name: "Research plan" });
  const refresh = () => screen.queryByRole("button", { name: "Refresh docs" });
  expect(refresh()).toBeNull();
  const update = await f.edit(f.carl, doc, {
    title: "Revised plan",
    markdown: "Updated body",
  });
  vi.spyOn(f.workspace, "reconcile").mockRejectedValueOnce(
    new ReadError("unavailable", "Relay read failed (503)", 503),
  );
  await act(async () => f.deliver(eventDto(update)));
  expect(screen.getByRole("link", { name: "Research plan" })).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  const load = vi
    .spyOn(f.workspace, "list")
    .mockRejectedValueOnce(
      new ReadError("unavailable", "Relay read failed (503)", 503),
    );
  fireEvent.click(await screen.findByRole("button", { name: "Refresh docs" }));
  await act(async () => {
    await Promise.allSettled([load.mock.results.at(-1)?.value]);
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("link", { name: "Research plan" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refresh docs" }));
  await screen.findByRole("link", { name: "Revised plan" });
  expect(refresh()).toBeNull();
});

it("lists all readable docs together with last-editor attribution and searches across creators", async () => {
  const f = await workspaceFixture();
  const mine = f.seed("My plan", "Updated by my agent");
  await f.edit(f.carl, mine, { title: mine.title, markdown: mine.markdown });
  const agent = f.seed("Agent outline", "Updated by a human");
  const other = f.seed("Research plan", "A shared document");
  const privateDoc = f.seed("Private plan", "Private content");
  const agentStorage = f.channels.get(agent.channel);
  const sharedStorage = f.channels.get(other.channel);
  const privateStorage = f.channels.get(privateDoc.channel);
  if (!agentStorage || !sharedStorage || !privateStorage)
    throw new Error("Missing fixture storage");
  agentStorage.creator = f.carl.pubkey;
  sharedStorage.creator = f.sam.pubkey;
  sharedStorage.roles = { [f.sam.pubkey]: "owner", [f.viewer.pubkey]: "guest" };
  privateStorage.creator = f.carl.pubkey;
  privateStorage.roles = { [f.carl.pubkey]: "owner" };

  render(<WorkingDocsCommunity workspace={f.workspace} />);
  const list = within(await screen.findByRole("list", { name: "Docs" }));
  expect(list.getAllByRole("listitem")[0]).toContainElement(
    list.getByRole("button", { name: "New doc" }),
  );
  await within(await list.findByRole("link", { name: mine.title })).findByTitle(
    "Last edited by Carl",
  );
  expect(list.getByRole("link", { name: agent.title })).toBeVisible();
  expect(list.getByRole("link", { name: other.title })).toBeVisible();
  expect(list.queryByRole("link", { name: privateDoc.title })).toBeNull();

  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "plan" },
  });
  expect(list.getByRole("link", { name: mine.title })).toBeVisible();
  expect(list.getByRole("link", { name: other.title })).toBeVisible();
  expect(list.queryByRole("link", { name: agent.title })).toBeNull();

  fireEvent.click(list.getByRole("link", { name: other.title }));
  const article = await screen.findByRole("article", { name: other.title });
  const mode = await within(article).findByRole("combobox", {
    name: "Doc mode",
  });
  expect(mode).toBeDisabled();
  expect(mode).toHaveTextContent("Viewing");
  fireEvent.click(screen.getByRole("button", { name: "Back to docs" }));
  expect(screen.getByRole("searchbox")).toHaveValue("plan");
});
