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
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SECTIONS } from "../agent-harness/sections";
import { SECTION_TEXT_BYTES } from "../agent-harness/sections/choices";
import type { ComposerInputElement } from "../messages/composer-dom";
import { BaseInstructions } from "./BaseInstructions";
import {
  defaultHash,
  ownerChoices,
  ownerSections,
  PROMPT_SECTIONS_KEY,
} from "./prompt-sections";
import { fileStore } from "./state";
import { type AgentStore, localStore } from "./store";

afterEach(cleanup);

const memory = (global?: unknown) => {
  const values = new Map<string, string>();
  if (global !== undefined)
    values.set(
      PROMPT_SECTIONS_KEY,
      typeof global === "string"
        ? global
        : JSON.stringify({ version: 1, global }),
    );
  return localStore({
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  });
};
const defaultOf = (id: string) =>
  String(SECTIONS.find((section) => section.id === id)?.text).trim();
const sectionActions = (title: string) =>
  screen.getByRole("button", { name: `Options for ${title}` });
const chooseSectionAction = async (
  user: ReturnType<typeof userEvent.setup>,
  title: string,
  action: string,
) => {
  await user.click(sectionActions(title));
  await user.click(await screen.findByRole("menuitem", { name: action }));
};
const saveButton = () => screen.getByRole("button", { name: "Save" });
const notice = /^Older Codex conversations on this device may start over once/;
const sectionRow = (title: string) =>
  screen.getByRole("button", { name: title });
const showAll = (count = SECTIONS.length) => sectionRow(`Show all (${count})`);
const openSection = async (
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) => {
  if (!screen.queryByRole("button", { name: title })) {
    await user.click(showAll());
  }
  if (!screen.queryByRole("region", { name: title })) {
    await user.click(sectionRow(title));
  }
};
const disableSection = async (
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) => {
  await openSection(user, title);
  await chooseSectionAction(user, title, "Disable");
};
const editor = (title: string) =>
  screen.getByRole<ComposerInputElement>("textbox", {
    name: `Your text for ${title}`,
  });
const editText = (title: string, text: string) => {
  act(() => {
    editor(title).value = text;
  });
};

it("discloses the sections in prompt order and preserves an edit across collapse and section changes", async () => {
  const user = userEvent.setup();
  const store = memory();
  render(<BaseInstructions store={store} />);
  const group = screen.getByRole("region", { name: "Base instructions" });
  const titles = SECTIONS.map((section) => section.title ?? "Opening lines");
  const collapsedRows = () =>
    within(group)
      .getAllByRole("button", { expanded: false })
      .flatMap((row) => row.getAttribute("aria-label") ?? []);
  expect(collapsedRows()).toEqual(titles.slice(0, 4));
  expect(
    screen.queryByRole("button", { name: "Customize" }),
  ).not.toBeInTheDocument();

  const first = sectionRow("Opening lines");
  first.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("region", { name: "Opening lines" })).toBeVisible();
  expect(first).toHaveFocus();
  expect(sectionRow("Show less")).toBeVisible();
  await user.keyboard("{Enter}");
  expect(collapsedRows()).toEqual(titles);

  sectionRow("Progress").focus();
  await user.keyboard("{Enter}");
  const panel = screen.getByRole("region", { name: "Progress" });
  expect(within(panel).getByRole("list")).toBeVisible();
  expect(within(panel).getByText("Work in the open.").tagName).toBe("STRONG");
  expect(sectionRow("Progress")).toHaveFocus();

  await openSection(user, "Progress");
  expect(within(editor("Progress")).getByRole("list")).toBeVisible();
  editText("Progress", "Report milestones.");
  expect(sectionRow("Progress")).not.toHaveTextContent("(Modified)");
  expect(within(sectionRow("Progress")).getByText("Edit")).toBeVisible();
  await user.click(sectionRow("Progress"));
  expect(screen.queryByRole("region", { name: "Progress" })).toBeNull();
  await openSection(user, "Trust");
  await openSection(user, "Progress");
  expect(sectionRow("Trust")).toHaveAttribute("aria-expanded", "false");
  expect(editor("Progress")).toHaveTextContent("Report milestones.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(sectionRow("Progress")).toHaveTextContent("Progress (Modified)");
  expect(sectionRow("Progress")).toHaveAccessibleDescription("Modified");
  expect(sectionRow("Progress")).toHaveAttribute("aria-expanded", "false");
  await openSection(user, "Progress");
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  await disableSection(user, "Progress");
  const offRow = sectionRow("Progress");
  expect(offRow).toHaveAccessibleDescription("Disabled");
  expect(offRow).toHaveTextContent("Progress (Disabled)");
  const offTitle = within(offRow).getByText("Progress");
  expect(offTitle).toHaveClass("opacity-60");
  expect(offTitle).not.toHaveClass("line-through");
  expect(within(offRow).getByText("Edit")).toBeVisible();
  expect(offRow).toHaveAttribute("aria-expanded", "false");
  await openSection(user, "Progress");
  const disabled = screen.getByRole("region", { name: "Progress" });
  expect(within(disabled).getByRole("list")).toBeVisible();
  expect(within(disabled).queryByRole("textbox")).not.toBeInTheDocument();
  expect(disabled).not.toHaveTextContent("Report milestones.");
  expect(screen.queryByRole("button", { name: "Customize" })).toBeNull();
  expect(ownerChoices(store)).toEqual({ progress: { mode: "off" } });
  await chooseSectionAction(user, "Progress", "Enable");
  await openSection(user, "Progress");
  expect(ownerChoices(store)).toEqual({
    progress: { mode: "custom", text: "Report milestones." },
  });
});

it("reveals the remaining rows with Show all and returns to the preview with Show less", async () => {
  const user = userEvent.setup();
  render(<BaseInstructions store={memory()} />);
  const toggle = showAll();
  const firstRevealedTitle = SECTIONS[4]?.title ?? "Opening lines";
  expect(screen.queryByRole("button", { name: firstRevealedTitle })).toBeNull();
  toggle.focus();
  await user.keyboard("{Enter}");
  const firstRevealed = sectionRow(firstRevealedTitle);
  expect(firstRevealed).toHaveFocus();
  expect(firstRevealed).toHaveAttribute("aria-expanded", "false");
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("region", { name: firstRevealedTitle }),
  ).toBeVisible();
  const showLess = sectionRow("Show less");
  showLess.focus();
  await user.keyboard("{Enter}");
  expect(showAll()).toHaveFocus();
  expect(firstRevealed).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(sectionRow(firstRevealedTitle)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("opens an editor with a disabled Save for each section the owner can configure", async () => {
  const user = userEvent.setup();
  render(<BaseInstructions store={memory()} />);
  for (const title of [
    "Publishing",
    "Progress",
    "Etiquette",
    "Agent Memory",
    "Commit identity",
    "Autonomy",
  ]) {
    await openSection(user, title);
    expect(editor(title)).toBeVisible();
    if (["Publishing", "Progress", "Etiquette", "Agent Memory"].includes(title))
      expect(within(editor(title)).getByRole("list")).toBeVisible();
    expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  }
  await openSection(user, "Trust");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(
    screen.getByText(
      "Applies to each agent from its next turn. A session that is running a turn changes when the turn ends. Agents in the standalone agent host get a change when it next starts. Mesh agents do not get the base instructions.",
    ),
  ).toBeInTheDocument();
});

it("saves each section independently and keeps other drafts", async () => {
  const user = userEvent.setup();
  const store = memory();
  render(<BaseInstructions store={store} />);
  await openSection(user, "Etiquette");
  expect(editor("Etiquette")).toHaveTextContent("Address people by the");
  expect(sectionRow("Etiquette")).toHaveFocus();
  editText("Etiquette", "Be brief.");
  expect(screen.getByText("This instruction can be changed.")).toBeVisible();
  expect(editor("Etiquette")).toHaveAccessibleDescription(
    "This instruction can be changed.",
  );
  expect(screen.queryByText(/of 4,096 bytes/)).toBeNull();
  expect(screen.queryByText(notice)).toBeNull();
  expect(ownerChoices(store)).toEqual({});
  await disableSection(user, "Progress");
  expect(ownerChoices(store)).toEqual({ progress: { mode: "off" } });
  expect(sectionRow("Progress")).toHaveAccessibleDescription("Disabled");
  expect(sectionRow("Progress")).toHaveAttribute("aria-expanded", "false");
  expect(sectionRow("Progress")).toHaveFocus();
  await openSection(user, "Etiquette");
  expect(editor("Etiquette")).toHaveTextContent("Be brief.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerChoices(store)).toEqual({
    progress: { mode: "off" },
    etiquette: { mode: "custom", text: "Be brief." },
  });
  expect(sectionRow("Etiquette")).toHaveFocus();
  await openSection(user, "Etiquette");
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("Be brief.")).toBeVisible();
  expect(screen.queryByText(notice)).toBeNull();
});

it("preserves Markdown when editing formatted text", async () => {
  const user = userEvent.setup();
  const source =
    "## Heading\n\n- **One**\n- `Two`\n\n<rules>Keep `this` literal.</rules>";
  const store = memory({
    progress: {
      mode: "custom",
      text: source,
      basedOn: ownerSectionsHash("progress"),
    },
  });
  render(<BaseInstructions store={store} />);
  await openSection(user, "Progress");
  const input = editor("Progress");
  const position = input.value.indexOf("One") + 1;
  expect(within(input).getByRole("list")).toBeVisible();
  expect(within(input).getByText("One").tagName).toBe("STRONG");
  expect(within(input).getByText("Two").tagName).toBe("CODE");
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  act(() => {
    input.insertText(
      "w",
      undefined,
      { start: position, end: position },
      undefined,
      false,
    );
  });
  await user.click(saveButton());
  expect(ownerChoices(store)).toEqual({
    progress: { mode: "custom", text: source.replace("One", "Owne") },
  });
});

it("preserves noncanonical Markdown when editing source or cancelling a reset", async () => {
  const user = userEvent.setup();
  const source =
    "**outer __inner__ text**\nKeep this line break.\n\n* First\n* Second";
  const store = memory({
    etiquette: {
      mode: "custom",
      text: source,
      basedOn: ownerSectionsHash("etiquette"),
    },
  });
  render(<BaseInstructions store={store} />);
  await openSection(user, "Etiquette");
  expect(editor("Etiquette")).toHaveValue(source);
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  await chooseSectionAction(user, "Etiquette", "Set to default instruction");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await openSection(user, "Etiquette");
  expect(editor("Etiquette")).toHaveValue(source);
  expect(store.get(PROMPT_SECTIONS_KEY)).toContain(JSON.stringify(source));
  const changed = source.replace("Keep", "Preserve");
  fireEvent.change(editor("Etiquette"), { target: { value: changed } });
  await user.click(saveButton());
  expect(ownerChoices(store)).toEqual({
    etiquette: { mode: "custom", text: changed },
  });
});

it("keeps a text that cannot be used out of the store", async () => {
  const user = userEvent.setup();
  const store = memory();
  render(<BaseInstructions store={store} />);
  await openSection(user, "Etiquette");
  editText("Etiquette", "");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter the instructions.",
  );
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  editText("Etiquette", "x".repeat(3686));
  expect(screen.queryByText(/of 4,096 bytes/)).toBeNull();
  editText("Etiquette", "x".repeat(3687));
  expect(screen.getByText("3,687 of 4,096 bytes")).toBeVisible();
  expect(editor("Etiquette")).toHaveAccessibleDescription(
    "This instruction can be changed. 3,687 of 4,096 bytes",
  );
  editText("Etiquette", "é".repeat(SECTION_TEXT_BYTES / 2 + 1));
  // The count stays in view when the text is too long.
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Keep the instructions within 4 KiB. 4,098 of 4,096 bytes.",
  );
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  editText("Etiquette", "Short.");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(ownerChoices(store)).toEqual({});
});

it("stages the default text until the user saves or cancels", async () => {
  const user = userEvent.setup();
  const store = memory({
    etiquette: {
      mode: "custom",
      text: "Be brief.",
      basedOn: ownerSectionsHash("etiquette"),
    },
  });
  render(<BaseInstructions store={store} />);
  await openSection(user, "Etiquette");
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  editText("Etiquette", "Be long.");
  await chooseSectionAction(user, "Etiquette", "Set to default instruction");
  expect(editor("Etiquette")).toHaveTextContent("Address people by the");
  expect(ownerChoices(store)).toEqual({
    etiquette: { mode: "custom", text: "Be brief." },
  });
  expect(saveButton()).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(sectionRow("Etiquette")).toHaveAttribute("aria-expanded", "false");
  expect(sectionRow("Etiquette")).toHaveFocus();
  await openSection(user, "Etiquette");
  expect(editor("Etiquette")).toHaveTextContent("Be brief.");
  await chooseSectionAction(user, "Etiquette", "Set to default instruction");
  await user.click(sectionActions("Etiquette"));
  expect(
    await screen.findByRole("menuitem", {
      name: "Set to default instruction",
    }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");
  await user.click(saveButton());
  expect(ownerChoices(store)).toEqual({});
  expect(sectionRow("Etiquette")).toHaveFocus();
  await openSection(user, "Etiquette");
  expect(editor("Etiquette")).toHaveTextContent("Address people by the");
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  await user.click(sectionActions("Etiquette"));
  await screen.findByRole("menuitem", { name: "Disable" });
  expect(
    screen.getByRole("menuitem", {
      name: "Set to default instruction",
    }),
  ).toHaveAttribute("aria-disabled", "true");
});

it("applies enable and disable immediately while preserving a text draft", async () => {
  const user = userEvent.setup();
  const otherChoices = { publishing: { mode: "off" } } as const;
  const store = memory({
    publishing: {
      ...otherChoices.publishing,
      basedOn: ownerSectionsHash("publishing"),
    },
    progress: { mode: "off", basedOn: ownerSectionsHash("progress") },
  });
  render(<BaseInstructions store={store} />);
  await openSection(user, "Progress");
  expect(sectionRow("Progress")).toHaveAccessibleDescription("Disabled");
  expect(screen.getByRole("region", { name: "Progress" })).toHaveTextContent(
    "Work in the open.",
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await user.click(sectionActions("Progress"));
  const enable = await screen.findByRole("menuitem", { name: "Enable" });
  expect(
    screen.getByRole("menuitem", {
      name: "Set to default instruction",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(enable);
  expect(sectionRow("Progress")).toHaveAttribute("aria-expanded", "false");
  await openSection(user, "Progress");
  expect(ownerChoices(store)).toEqual(otherChoices);
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  editText("Progress", "Report milestones.");
  await chooseSectionAction(user, "Progress", "Disable");
  await openSection(user, "Progress");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Progress" })).toHaveTextContent(
    "Work in the open.",
  );
  expect(ownerChoices(store)).toEqual({
    ...otherChoices,
    progress: { mode: "off" },
  });
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  await chooseSectionAction(user, "Progress", "Enable");
  await openSection(user, "Progress");
  expect(editor("Progress")).not.toHaveAttribute("aria-disabled");
  expect(editor("Progress")).toHaveTextContent("Report milestones.");
  expect(saveButton()).toBeEnabled();
  expect(ownerChoices(store)).toEqual(otherChoices);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await openSection(user, "Progress");
  expect(ownerChoices(store)).toEqual(otherChoices);
  expect(sectionRow("Progress")).not.toHaveAccessibleDescription();
  expect(editor("Progress")).not.toHaveAttribute("aria-disabled");
  expect(editor("Progress")).toHaveTextContent("Work in the open.");
});

it("says when a default changed after the owner's choice, until they keep theirs", async () => {
  const user = userEvent.setup();
  const store = memory({
    progress: { mode: "off", basedOn: "an-older-default" },
    etiquette: {
      mode: "custom",
      text: "Be brief.",
      basedOn: ownerSectionsHash("etiquette"),
    },
  });
  render(<BaseInstructions store={store} />);
  await openSection(user, "Etiquette");
  expect(sectionActions("Etiquette")).not.toHaveAccessibleDescription();
  await openSection(user, "Progress");
  expect(sectionRow("Progress")).toHaveTextContent("Default changed");
  expect(sectionRow("Etiquette")).toHaveTextContent("Etiquette (Modified)");
  expect(sectionActions("Progress")).toHaveAccessibleDescription(
    "The default text changed after you made this choice.",
  );
  const disabled = screen.getByRole("region", { name: "Progress" });
  expect(disabled).toHaveTextContent("Work in the open.");
  expect(within(disabled).queryByRole("textbox")).not.toBeInTheDocument();
  await chooseSectionAction(user, "Progress", "Keep mine");
  expect(sectionRow("Progress")).toHaveAccessibleDescription("Disabled");
  expect(sectionRow("Progress")).not.toHaveTextContent("Default changed");
  expect(sectionActions("Progress")).toHaveFocus();
  // The choice stays; it is now based on the current default.
  expect(ownerSections(store).choices.progress).toEqual({
    mode: "off",
    basedOn: ownerSectionsHash("progress"),
  });
});

it("keeps the owner's own text when they keep theirs", async () => {
  const user = userEvent.setup();
  const store = memory({
    etiquette: { mode: "custom", text: "Be brief.", basedOn: "an-older-one" },
  });
  render(<BaseInstructions store={store} />);
  await openSection(user, "Etiquette");
  await chooseSectionAction(user, "Etiquette", "Keep mine");
  expect(screen.getByText("Be brief.")).toBeVisible();
  expect(ownerSections(store).choices.etiquette).toEqual({
    mode: "custom",
    text: "Be brief.",
    basedOn: ownerSectionsHash("etiquette"),
  });
});

it("keeps the owner's text when a later default is the same text, until they reset it", async () => {
  const user = userEvent.setup();
  // A later Buzz version made the owner's text its default.
  const etiquette = {
    mode: "custom",
    text: defaultOf("etiquette"),
    basedOn: "an-older-one",
  };
  const store = memory({ etiquette });
  render(<BaseInstructions store={store} />);
  await openSection(user, "Etiquette");
  expect(sectionRow("Etiquette")).toHaveTextContent("Default changed");
  await chooseSectionAction(user, "Etiquette", "Keep mine");
  expect(ownerSections(store).choices.etiquette).toEqual({
    ...etiquette,
    basedOn: ownerSectionsHash("etiquette"),
  });
  // Saving another section keeps it too.
  await disableSection(user, "Progress");
  expect(ownerSections(store).choices.etiquette).toMatchObject({
    mode: "custom",
  });
  await openSection(user, "Etiquette");
  expect(saveButton()).toHaveAttribute("aria-disabled", "true");
  await chooseSectionAction(user, "Etiquette", "Set to default instruction");
  expect(ownerSections(store).choices.etiquette).toMatchObject({
    mode: "custom",
  });
  expect(saveButton()).toBeEnabled();
  await user.click(saveButton());
  expect(ownerSections(store).choices.etiquette).toBeUndefined();
});

it("lists every section's default text and shows plugin details inside the fixed section", async () => {
  const user = userEvent.setup();
  render(
    <BaseInstructions
      store={memory()}
      replacedBy={(id) => (id === "working-location" ? ["Example Plugin"] : [])}
    />,
  );
  await user.click(showAll());
  for (const title of [
    "Trust",
    "Opening lines",
    "Session Model",
    "Routing",
    "Working location",
  ]) {
    const index = SECTIONS.findIndex(
      (section) => (section.title ?? "Opening lines") === title,
    );
    expect(sectionRow(title)).toHaveTextContent(
      new RegExp(`^${index + 1}\\s*${title}$`),
    );
  }
  await user.click(
    within(sectionRow("Progress")).getByText("Edit", { exact: true }),
  );
  expect(editor("Progress")).toBeVisible();
  const pluginNote = "Example Plugin can replace this in chats it manages.";
  expect(screen.queryByText(pluginNote)).not.toBeInTheDocument();
  await user.click(sectionRow("Trust"));
  expect(
    await screen.findByText(defaultOf("trust").slice(0, 60), { exact: false }),
  ).toBeInTheDocument();
  await openSection(user, "Session Model");
  expect(
    screen.getByRole("region", { name: "Session Model" }),
  ).toHaveTextContent("You are one session of your agent identity");
  await openSection(user, "Working location");
  expect(
    within(screen.getByRole("region", { name: "Working location" })).getByText(
      pluginNote,
    ),
  ).toBeVisible();
});

it("warns that the owner's choice also applies in the chats a plugin manages", async () => {
  const user = userEvent.setup();
  render(
    <BaseInstructions
      store={memory()}
      replacedBy={(id) =>
        id === "progress" ? ["Example Plugin", "Other Plugin"] : []
      }
    />,
  );
  const warning =
    "Your choice also applies in chats that Example Plugin and Other Plugin manage.";
  await openSection(user, "Progress");
  // The default text yields to a plugin: the row names the plugins.
  expect(screen.queryByText(warning, { exact: false })).not.toBeInTheDocument();
  expect(sectionActions("Progress")).toHaveAccessibleDescription(
    "Example Plugin and Other Plugin can replace this in chats they manage.",
  );
  await disableSection(user, "Progress");
  await openSection(user, "Progress");
  expect(screen.getByText(warning, { exact: false })).toBeInTheDocument();
  expect(screen.queryByText(/can replace this/)).not.toBeInTheDocument();
  expect(sectionActions("Progress")).toHaveAccessibleDescription(
    expect.stringContaining(warning),
  );
  await user.click(sectionRow("Progress"));
  expect(screen.queryByText(warning)).not.toBeInTheDocument();
  await openSection(user, "Progress");
  expect(screen.getByText(warning)).toBeVisible();
});

it("says when the saved choices cannot be read, and shows choices that are no longer used", async () => {
  const user = userEvent.setup();
  const view = render(<BaseInstructions store={memory("{not json")} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your saved choices could not be read",
  );
  view.unmount();
  render(
    <BaseInstructions
      store={memory({
        "a-removed-section": { mode: "custom", text: "Mine.", basedOn: "x" },
      })}
    />,
  );
  await user.click(showAll(SECTIONS.length + 1));
  const row = screen.getByRole("button", {
    name: "a-removed-section, no longer used",
  });
  expect(row).toHaveTextContent("No longer used");
  await user.click(row);
  expect(await screen.findByText("Mine.")).toBeInTheDocument();
});

it("shows the restart warning inline for affected conversations", async () => {
  const user = userEvent.setup();
  const store = memory();
  render(<BaseInstructions store={store} mayRestart />);
  await openSection(user, "Progress");
  expect(sectionActions("Progress")).toHaveAccessibleDescription(notice);
  editText("Progress", "Report milestones.");
  expect(saveButton()).toHaveAccessibleDescription(notice);
  await user.click(saveButton());
  expect(ownerChoices(store)).toEqual({
    progress: { mode: "custom", text: "Report milestones." },
  });
});

it("keeps a failed edit available for retry", async () => {
  const user = userEvent.setup();
  const store = memory();
  const set = vi
    .fn(store.set)
    .mockRejectedValueOnce(new Error("The disk is full"));
  render(<BaseInstructions store={{ ...store, set }} />);
  await openSection(user, "Progress");
  editText("Progress", "Report milestones.");
  const save = saveButton();
  await user.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The disk is full",
  );
  expect(editor("Progress")).toHaveTextContent("Report milestones.");
  expect(ownerChoices(store)).toEqual({});
  expect(save).toBeEnabled();
  await user.click(save);
  expect(ownerChoices(store)).toEqual({
    progress: { mode: "custom", text: "Report milestones." },
  });
});

it("makes a new choice on the default as it is now", async () => {
  const user = userEvent.setup();
  const store = memory({
    progress: {
      mode: "custom",
      text: "An earlier edit.",
      basedOn: "an-older-default",
    },
  });
  render(<BaseInstructions store={store} />);
  await openSection(user, "Progress");
  editText("Progress", "");
  expect(
    screen.queryByText("The default text changed after you made this choice.", {
      exact: false,
    }),
  ).not.toBeInTheDocument();
  editText("Progress", "Say little.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerSections(store).choices.progress).toEqual({
    mode: "custom",
    text: "Say little.",
    basedOn: ownerSectionsHash("progress"),
  });
});

it.each([false, true])(
  "restores focus on save unless the user has moved to another row (%s)",
  async (moved) => {
    const user = userEvent.setup();
    const original = { publishing: { mode: "off" } };
    const store = memory({
      publishing: {
        ...original.publishing,
        basedOn: ownerSectionsHash("publishing"),
      },
    });
    let finish = () => {};
    const held: AgentStore = {
      ...store,
      set: vi.fn(async (key, value) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await store.set(key, value);
      }),
    };
    render(<BaseInstructions store={held} />);
    await openSection(user, "Progress");
    editText("Progress", "Report milestones.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    try {
      await waitFor(() => expect(held.set).toHaveBeenCalledOnce());
      expect(editor("Progress")).toHaveAttribute("aria-disabled", "true");
      const cancel = screen.getByRole("button", { name: "Cancel" });
      expect(cancel).toBeEnabled();
      if (moved) {
        await user.click(cancel);
        expect(sectionRow("Progress")).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        expect(sectionRow("Progress")).toHaveFocus();
        expect(ownerChoices(store)).toEqual(original);
        await openSection(user, "Etiquette");
        expect(sectionActions("Etiquette")).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await user.click(sectionActions("Etiquette"));
        expect(held.set).toHaveBeenCalledOnce();
        sectionRow("Etiquette").focus();
      } else {
        await user.tab({ shift: true });
        expect(cancel).toHaveFocus();
      }
    } finally {
      finish();
    }
    await waitFor(() => {
      expect(sectionRow("Progress")).toHaveAttribute("aria-expanded", "false");
      expect(sectionRow(moved ? "Etiquette" : "Progress")).toHaveFocus();
      expect(ownerChoices(store)).toEqual({
        ...original,
        progress: { mode: "custom", text: "Report milestones." },
      });
    });
  },
);

it.each(["succeeds", "fails"])(
  "reopens with the saved instructions until a pending write %s",
  async (result) => {
    const user = userEvent.setup();
    let finish = (_error?: Error) => {};
    const write = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = (error) => {
            if (error) reject(error);
            else resolve();
          };
        }),
    );
    const store = fileStore(new Map(), write);
    const first = render(<BaseInstructions store={store} />);
    await disableSection(user, "Progress");

    try {
      await waitFor(() => expect(write).toHaveBeenCalledOnce());
      first.unmount();
      render(<BaseInstructions store={store} />);
      await openSection(user, "Progress");
      expect(sectionRow("Progress")).not.toHaveAccessibleDescription();
      expect(sectionActions("Progress")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(editor("Progress")).toHaveAttribute("aria-disabled", "true");
    } finally {
      finish(result === "fails" ? new Error("The disk is full") : undefined);
    }

    await waitFor(() =>
      expect(sectionActions("Progress")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    if (result === "fails") {
      expect(screen.getByRole("alert")).toHaveTextContent("The disk is full");
      expect(sectionRow("Progress")).not.toHaveAccessibleDescription();
      expect(editor("Progress")).not.toHaveAttribute("aria-disabled", "true");
      expect(ownerChoices(store)).toEqual({});
    } else {
      expect(sectionRow("Progress")).toHaveAccessibleDescription("Disabled");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(ownerChoices(store)).toEqual({ progress: { mode: "off" } });
    }
  },
);

function ownerSectionsHash(id: string) {
  const section = SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(id);
  return defaultHash(section);
}
