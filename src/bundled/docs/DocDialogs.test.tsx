// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, workspaceFixture, gate } from "./ui-testing";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DocHistoryMenu, DocSharing } from "./DocDialogs";
import { formatPublicKey } from "../../shared/identity/public-key";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";

function renderHistoryMenu(props: ComponentProps<typeof DocHistoryMenu>) {
  render(
    <MenuRoot>
      <MenuTrigger>Actions</MenuTrigger>
      <MenuPopup>
        <DocHistoryMenu {...props} />
      </MenuPopup>
    </MenuRoot>,
  );
}

it("retries history, pages the open submenu, and selects with the retained offset", async () => {
  const fixture = await workspaceFixture();
  const { workspace } = fixture;
  const doc = fixture.seed("Plan", "Original");
  const firstRead = gate();
  const history = vi
    .spyOn(workspace, "history")
    .mockImplementationOnce(async () => {
      await firstRead.promise;
      throw new Error("Offline");
    })
    .mockImplementation(async (_doc, offset) => ({
      revisions: [{ ...doc, title: offset ? "Older plan" : "Current plan" }],
      more: !offset,
      limited: !!offset,
    }));
  const onSelect = vi.fn();
  renderHistoryMenu({ doc, workspace, onSelect });
  expect(history).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Actions" }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Revision history" }),
  );
  try {
    const submenu = await screen.findByRole("menu", {
      name: "Revision history",
    });
    expect(submenu).toHaveAttribute("aria-busy", "true");
    expect(submenu).toHaveTextContent(/^$/);
    expect(within(submenu).queryByRole("menuitem")).not.toBeInTheDocument();
  } finally {
    firstRead.release();
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Retry history" }),
  );
  await screen.findByRole("menuitem", { name: /Current plan/ });
  expect(history).toHaveBeenCalledTimes(2);
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Load older revisions" }),
  );
  await screen.findByRole("menuitem", { name: /Older plan/ });
  expect(
    screen.getByRole("menu", { name: "Revision history" }),
  ).toHaveTextContent("page limit");
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Newer revisions" }),
  );
  await screen.findByRole("menuitem", { name: /Current plan/ });
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Load older revisions" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: /Older plan/ }),
  );
  expect(onSelect).toHaveBeenCalledWith(doc.revision, 100);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

it("shows each revision signer in history, with a key fallback for a missing profile", async () => {
  const f = await workspaceFixture();
  const doc = f.seed("Plan", "Original");
  await f.edit(f.carl, doc, { title: "Agent edit", markdown: "By the agent" });
  const storage = f.channels.get(doc.channel);
  if (!storage) throw new Error("Missing doc storage");
  storage.roles[f.sam.pubkey] = "member";
  f.profiles.splice(
    f.profiles.findIndex((profile) => profile.pubkey === f.sam.pubkey),
    1,
  );
  await f.edit(f.sam, doc, { title: "Unknown edit", markdown: "No profile" });
  const current = await f.workspace.open(doc);
  vi.spyOn(Date, "now").mockReturnValue(
    (current.event.created_at + 120) * 1000,
  );
  renderHistoryMenu({
    doc: current,
    workspace: f.workspace,
    onSelect: () => {},
  });
  await userEvent.click(screen.getByRole("button", { name: "Actions" }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Revision history" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: /^Plan/ }),
  ).toHaveTextContent("You ·");
  expect(
    await screen.findByRole("menuitem", { name: /^Agent edit/ }),
  ).toHaveTextContent("Carl ·");
  expect(
    screen.getByRole("menuitem", { name: /^Unknown edit/ }),
  ).toHaveTextContent(formatPublicKey(f.sam.pubkey) ?? "missing key");
  for (const [title, shape] of [
    ["Plan", "circle"],
    ["Agent edit", "squircle"],
    ["Unknown edit", "circle"],
  ]) {
    const row = screen.getByRole("menuitem", { name: new RegExp(`^${title}`) });
    expect(row.querySelector("[data-avatar-shape]")).toHaveAttribute(
      "data-avatar-shape",
      shape,
    );
    const time = row.querySelector("time");
    expect(time).toHaveTextContent(/ago$/);
    expect(time).toHaveAttribute("datetime");
    expect(time?.title).not.toBe("");
  }
});

it("uses the channel member picker while guarding a pending explicit invitation", async () => {
  const fixture = await workspaceFixture();
  const { workspace } = fixture;
  const doc = fixture.seed("Plan", "Original");
  const onClose = vi.fn();
  const pending = gate();
  const original = workspace.setMember;
  const member = vi
    .spyOn(workspace, "setMember")
    .mockImplementation(async (...args) => {
      await pending.promise;
      return original(...args);
    });
  const props = { doc, workspace, onClose, trigger: { current: null } };
  const view = render(<DocSharing {...props} />);
  await screen.findByRole("searchbox", { name: "Search people and agents" });
  expect(
    screen.queryByRole("checkbox", {
      name: "Share with my agents automatically",
    }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "General access" }),
    ).toBeEnabled(),
  );
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search people and agents" }),
    { target: { value: "Sam" } },
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /^Add Sam \([^)]+\)$/ }),
  );
  await waitFor(() => expect(member).toHaveBeenCalledOnce());
  // The document refreshes its Doc object after membership updates.
  view.rerender(<DocSharing {...props} doc={{ ...doc }} />);
  try {
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    pending.release();
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled(),
  );
});

it("confirms community reading of all retained revisions and offers only private or view-only access", async () => {
  const fixture = await workspaceFixture();
  const { workspace } = fixture;
  const doc = fixture.seed("Plan", "Original");
  render(
    <DocSharing
      doc={doc}
      workspace={workspace}
      onClose={vi.fn()}
      trigger={{ current: null }}
    />,
  );
  const control = await screen.findByRole("combobox", {
    name: "General access",
  });
  await waitFor(() => expect(control).toBeEnabled());
  await userEvent.click(control);
  expect(
    screen.queryByRole("option", { name: "Public" }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    await screen.findByRole("option", { name: "View only" }),
  );
  const confirm = await screen.findByRole("alertdialog", {
    name: "Change general access?",
  });
  expect(confirm).toHaveTextContent("all retained revisions");
  await userEvent.click(
    within(confirm).getByRole("button", { name: "Cancel" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  expect(fixture.channels.get(doc.channel)?.visibility).not.toBe("public");
  await userEvent.click(control);
  await userEvent.click(
    await screen.findByRole("option", { name: "View only" }),
  );
  await userEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Change access",
    }),
  );
  await waitFor(() =>
    expect(fixture.channels.get(doc.channel)?.visibility).toBe("public"),
  );
  expect(fixture.channels.get(doc.channel)?.joinRole).toBe("guest");
  await waitFor(() => expect(control).toHaveTextContent("View only"));
});
