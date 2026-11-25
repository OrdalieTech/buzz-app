// Settings → Agent setup → Base instructions: the owner's choice for each
// section of the base prompt they can configure, and every section's text
// to read. Choices apply to all the owner's agents on this device.
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import remarkGfm from "remark-gfm";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { useScrollEdges } from "../../shared/design-system/ui/useScrollEdges";
import { SECTIONS, type Section } from "../agent-harness/sections";
import {
  SECTION_TEXT_BYTES,
  textProblem,
} from "../agent-harness/sections/choices";
import {
  MarkdownDocument,
  MarkdownSource,
  sharedComponents,
} from "../markdown/MarkdownDocument";
import type { MarkdownProfile } from "../markdown/profiles";
import { DocumentEditor } from "../messages/DocumentEditor";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import {
  committedOwnerSections,
  defaultHash,
  ownerSections,
  type SavedChoice,
  saveOwnerSections,
} from "./prompt-sections";
import type { AgentStore } from "./store";
import styles from "./BaseInstructions.module.css";

type Mode = "default" | "off" | "custom";
type SectionEdit = { text: string } | "default";
const PREVIEW_SECTION_COUNT = 4;
/** A section's default text; the one of a thread session in the agent's own
 * workspace where Buzz picks it. */
const defaultText = (section: Section) =>
  (typeof section.text === "string"
    ? section.text
    : section.text({ scope: "thread" })
  ).trim();
const bytes = (text: string) => new TextEncoder().encode(text.trim()).length;

const firstChoiceNotice =
  "Older Codex conversations on this device may start over once on their next turn.";

const PROFILE: MarkdownProfile = {
  syntax: [remarkGfm],
  transforms: [],
  html: "literal",
};

const InstructionText = memo(function InstructionText({
  text,
}: {
  text: string;
}) {
  const className = "min-w-0 select-text break-words text-message text-subtle";
  if (text.length > MAX_MARKDOWN_LENGTH || scanMarkdown(text).tooDeep)
    return <MarkdownSource content={text} className={className} />;
  return (
    <MarkdownDocument
      content={text}
      profile={PROFILE}
      components={sharedComponents}
      scale="inherit"
      className={`${className} ${styles.markdown}`}
    />
  );
});

function InstructionReadingArea({ children }: { children: ReactNode }) {
  const scrollRef = useScrollEdges("block");
  return (
    <div
      ref={scrollRef}
      className={styles.readingArea}
      data-instruction-reading-area=""
      data-scroll-fade="scrolled"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Plain text needs a keyboard scroll target.
      tabIndex={0}
    >
      <div>{children}</div>
    </div>
  );
}

const names = new Intl.ListFormat("en", { type: "conjunction" });
const canReplace = (plugins: readonly string[]) =>
  `${names.format(plugins)} can replace this in chats ${plugins.length > 1 ? "they manage" : "it manages"}.`;
const sectionTitle = (section: Section) => section.title ?? "Opening lines";
const instructionStatus = (mode: Mode | undefined) =>
  mode === "custom" ? "Modified" : mode === "off" ? "Disabled" : undefined;

function InstructionTitle({
  title,
  mode,
  changed,
}: {
  title: string;
  mode?: Mode | undefined;
  changed?: boolean | undefined;
}) {
  const status = instructionStatus(mode);
  return (
    <>
      <span className={mode === "off" ? "opacity-60" : undefined}>{title}</span>
      {status && (
        <span
          className={
            mode === "off"
              ? "text-body-sm text-subtle"
              : "text-caption text-subtle"
          }
        >
          {` (${status})`}
        </span>
      )}
      {changed && (
        <span className="text-caption text-subtle">{" · Default changed"}</span>
      )}
    </>
  );
}

function InstructionRowTitle({
  title,
  position,
  mode,
  changed,
  retired,
}: {
  title: string;
  position: number;
  mode?: Mode | undefined;
  changed?: boolean;
  retired?: boolean;
}) {
  return (
    <span className="flex items-center gap-4 text-left text-body-sm">
      <span
        aria-hidden="true"
        className="w-5 shrink-0 whitespace-nowrap text-center text-secondary tabular-nums"
      >
        {position}
      </span>
      <span aria-hidden="true" className={`min-w-0 grow ${styles.rowTitle}`}>
        <InstructionTitle title={title} mode={mode} changed={changed} />
      </span>
      {mode && <span className="shrink-0 text-caption text-subtle">Edit</span>}
      {retired && <span className="text-secondary">No longer used</span>}
    </span>
  );
}
const defaultChanged = (section: Section, choice: SavedChoice | undefined) =>
  !!choice?.basedOn && choice.basedOn !== defaultHash(section);

export function BaseInstructions({
  store,
  replacedBy,
  mayRestart = false,
}: {
  store: AgentStore;
  mayRestart?: boolean;
  /** The names of the plugins that can replace a section's text in the
   * chats they manage. */
  replacedBy?: ((section: string) => readonly string[]) | undefined;
}) {
  const notify = useToastNotification();
  const savedTrigger = useRef<HTMLButtonElement | null>(null);
  const [start] = useState(() => committedOwnerSections(store));
  const [saved, setSaved] = useState(start.sections);
  const [resumingSave, setResumingSave] = useState(!!start.writing);
  const [edits, setEdits] = useState<Record<string, SectionEdit>>({});
  const [editorRevisions, setEditorRevisions] = useState<
    Record<string, number>
  >({});
  const [write, setWrite] = useState<{
    id: string;
    enabledChanged: boolean;
  } | null>(null);
  const saving = write?.id ?? null;
  const [error, setError] = useState<{ id?: string; message: string }>();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const busy = saving !== null || resumingSave;
  const noticeId = useId();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const focusRevealedRow = useRef(false);
  const openSectionActions = () =>
    listRef.current?.querySelector<HTMLElement>(
      ".buzz-accordion-item[data-open] [data-instruction-actions]",
    );
  useEffect(() => {
    if (!start.writing) return;
    let live = true;
    // The previous panel can still be writing to the optimistic store.
    const settled = (failure?: { message: string }) => {
      if (!live) return;
      setSaved(ownerSections(store));
      setError(failure);
      setResumingSave(false);
    };
    void start.writing.then(
      () => settled(),
      (reason: unknown) =>
        settled({
          message: reason instanceof Error ? reason.message : String(reason),
        }),
    );
    return () => {
      live = false;
    };
  }, [start, store]);
  useLayoutEffect(() => {
    if (focusRevealedRow.current) {
      focusRevealedRow.current = false;
      const rows = listRef.current?.querySelectorAll<HTMLButtonElement>(
        ".buzz-accordion-trigger",
      );
      rows?.[PREVIEW_SECTION_COUNT]?.focus();
    }
  });
  const resetEditor = (id: string) => {
    setEditorRevisions((current) => ({
      ...current,
      [id]: (current[id] ?? 0) + 1,
    }));
  };
  const closeEdit = (id: string) => {
    setEdits(({ [id]: _, ...remaining }) => remaining);
    resetEditor(id);
    setError((current) => (current?.id === id ? undefined : current));
  };
  const saveSection = async (
    id: string,
    choice: SavedChoice | undefined,
    from?: HTMLElement,
    successMessage?: string,
  ) => {
    if (busy) return false;
    const choices = { ...ownerSections(store).choices };
    const hadChoice = !!choices[id];
    const enabledChanged =
      (choices[id]?.mode === "off") !== (choice?.mode === "off");
    if (choice) choices[id] = choice;
    else delete choices[id];
    savedTrigger.current = null;
    const initialFocus = document.activeElement;
    setWrite({ id, enabledChanged });
    setError(undefined);
    try {
      if (choice || hadChoice) await saveOwnerSections(store, choices);
      setSaved(ownerSections(store));
      if (successMessage) {
        const item = from?.closest(".buzz-accordion-item");
        const active = document.activeElement;
        if (
          item &&
          (active === document.body ||
            item.querySelector(".buzz-accordion-panel")?.contains(active) ||
            (enabledChanged && active === initialFocus))
        ) {
          const trigger = item.querySelector<HTMLButtonElement>(
            ".buzz-accordion-trigger",
          );
          savedTrigger.current = trigger;
          trigger?.focus();
        }
        setOpenRow((current) => (current === id ? null : current));
        notify(successMessage, "success");
      }
      if (enabledChanged) resetEditor(id);
      else closeEdit(id);
      return true;
    } catch (reason) {
      setError({
        id,
        message: reason instanceof Error ? reason.message : String(reason),
      });
      return false;
    } finally {
      setWrite(null);
    }
  };
  /** The names of the plugins that can replace `section`. */
  const plugins = (section: Section) =>
    section.plugin ? (replacedBy?.(section.id) ?? []) : [];
  const unused = Object.entries(saved.unused);
  const visibleSections = showAll
    ? SECTIONS
    : SECTIONS.slice(0, PREVIEW_SECTION_COUNT);
  const toggleRow = (id: string, value: string[]) => {
    const opening = value.length > 0;
    if (opening) setShowAll(true);
    setOpenRow(opening ? id : null);
  };

  const renderEditor = (section: Section, defaultHasChanged: boolean) => {
    const { id } = section;
    const title = sectionTitle(section);
    const choice = saved.choices[id];
    const savedMode = choice?.mode ?? "default";
    const content = edits[id];
    const resetting = content === "default";
    const enabled = savedMode !== "off";
    const mode = enabled && resetting ? "default" : savedMode;
    const textEdit = resetting ? undefined : content;
    const defaultSource = defaultText(section);
    const savedSource = choice?.mode === "custom" ? choice.text : defaultSource;
    const initialText = resetting ? defaultSource : savedSource;
    const source = textEdit?.text ?? initialText;
    const text = source.trim();
    const usesDefault = text === defaultSource;
    const dirty = enabled && (mode !== savedMode || text !== savedSource);
    const defaultSaved = savedMode === "default" && !dirty;
    const defaultHint = defaultSaved
      ? "Already set"
      : enabled
        ? undefined
        : "Enable to edit";
    const savingText = saving === id && !write?.enabledChanged;
    const problem =
      dirty && mode !== "off" && !usesDefault ? textProblem(source) : undefined;
    const byteCount = bytes(source);
    const showCount = byteCount >= SECTION_TEXT_BYTES * 0.9;
    const count = `${byteCount.toLocaleString("en")} of ${SECTION_TEXT_BYTES.toLocaleString("en")} bytes`;
    const changed = !dirty && defaultHasChanged;
    const basedOn = defaultHash(section);
    const notice = `${noticeId}-${id}-default-changed`;
    const details = `${noticeId}-${id}-editor-details`;
    const able = plugins(section);
    const pluginNote = !able.length
      ? undefined
      : mode === "default" && !dirty
        ? canReplace(able)
        : `Your choice also applies in chats that ${names.format(able)} ${able.length > 1 ? "manage" : "manages"}.`;
    const pluginNoteId = `${noticeId}-${id}-plugin-note`;
    const restartNoteId = `${noticeId}-${id}-restart-note`;
    const restartNote = mayRestart && enabled ? restartNoteId : undefined;
    const actionDescription =
      [pluginNote && pluginNoteId, changed && notice, restartNote]
        .filter(Boolean)
        .join(" ") || undefined;
    const updateEdit = (next: SectionEdit) => {
      if (next === "default") resetEditor(id);
      setEdits((current) => ({ ...current, [id]: next }));
      setError((current) => (current?.id === id ? undefined : current));
    };
    const defaultItem = (
      <MenuItem disabled={!!defaultHint} onClick={() => updateEdit("default")}>
        Set to default instruction
      </MenuItem>
    );
    return (
      <div className="grid gap-1">
        <h4 className="m-0 min-w-0 break-words py-0.5 text-body-lg font-medium">
          <InstructionTitle title={title} mode={mode} changed={changed} />
        </h4>
        <div className={`grid gap-3 ${styles.editor}`}>
          {enabled ? (
            <DocumentEditor
              key={editorRevisions[id]}
              variant="field"
              editing
              label={`Your text for ${title}`}
              aria-describedby={details}
              aria-invalid={!!problem}
              value={source}
              placeholder=""
              maxLength={MAX_MARKDOWN_LENGTH}
              disabled={saving === id || resumingSave}
              onChange={(text) => updateEdit({ text })}
            />
          ) : (
            <InstructionReadingArea>
              <InstructionText text={defaultSource} />
            </InstructionReadingArea>
          )}
          {changed && choice && (
            <div className="grid gap-2">
              <p id={notice} className="m-0 text-body-sm text-secondary">
                The default text changed after you made this choice.
                {mode === "custom" && " The default is now:"}
              </p>
              {mode === "custom" && (
                <InstructionReadingArea>
                  <InstructionText text={defaultSource} />
                </InstructionReadingArea>
              )}
            </div>
          )}
        </div>
        {pluginNote && (
          <p id={pluginNoteId} className="m-0 text-caption text-subtle">
            {pluginNote}
          </p>
        )}
        {restartNote && (
          <p id={restartNoteId} className="m-0 text-caption text-subtle">
            {firstChoiceNotice}
          </p>
        )}
        <footer className="mt-1 flex flex-wrap items-center gap-2">
          {mode !== "off" && (
            <div
              id={details}
              className="mr-auto grid gap-1 text-caption text-subtle"
            >
              <p className="m-0">This instruction can be changed.</p>
              {problem ? (
                <p role="alert" className="m-0 text-danger">
                  {byteCount > SECTION_TEXT_BYTES
                    ? `${problem} ${count}.`
                    : source.trim()
                      ? problem
                      : "Enter the instructions."}
                </p>
              ) : (
                showCount && <p className="m-0 tabular-nums">{count}</p>
              )}
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <MenuRoot>
              <MenuTrigger
                disabled={busy}
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Options for ${title}`}
                    aria-describedby={actionDescription}
                    data-instruction-actions=""
                    loading={saving === id && !!write?.enabledChanged}
                    focusableWhenDisabled
                  >
                    Options
                  </Button>
                }
              />
              <MenuPopup
                align="end"
                size="compact"
                finalFocus={() => {
                  const trigger = savedTrigger.current;
                  return trigger && openRow === null ? trigger : true;
                }}
              >
                <MenuItem
                  onClick={() =>
                    void saveSection(
                      id,
                      enabled
                        ? { ...choice, mode: "off", basedOn }
                        : choice?.mode === "off" && choice.text
                          ? {
                              mode: "custom",
                              text: choice.text,
                              basedOn: choice.basedOn,
                            }
                          : undefined,
                      openSectionActions() ?? undefined,
                      enabled
                        ? "Instruction disabled."
                        : "Instruction enabled.",
                    )
                  }
                >
                  {mode === "off" ? "Enable" : "Disable"}
                </MenuItem>
                {defaultHint ? (
                  <Tooltip content={defaultHint} disableHoverablePopup>
                    {defaultItem}
                  </Tooltip>
                ) : (
                  defaultItem
                )}
                {changed && choice && (
                  <MenuItem
                    onClick={() => void saveSection(id, { ...choice, basedOn })}
                  >
                    Keep mine
                  </MenuItem>
                )}
              </MenuPopup>
            </MenuRoot>
            <Button
              size="sm"
              variant="subtle"
              onClick={(event) => {
                if (saving !== id) closeEdit(id);
                event.currentTarget
                  .closest(".buzz-accordion-item")
                  ?.querySelector<HTMLButtonElement>(".buzz-accordion-trigger")
                  ?.focus();
                setOpenRow(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="prominent"
              aria-describedby={restartNote}
              loading={savingText}
              disabled={!dirty || !!problem || (busy && !savingText)}
              focusableWhenDisabled
              onClick={(event) => {
                if (!dirty || problem) return;
                const next: SavedChoice | undefined = usesDefault
                  ? undefined
                  : { mode: "custom", text, basedOn };
                void saveSection(
                  id,
                  next,
                  event.currentTarget,
                  "Instruction saved.",
                );
              }}
            >
              Save
            </Button>
          </div>
        </footer>
        {error?.id === id && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error.message}
          </p>
        )}
      </div>
    );
  };

  return (
    <section className="mt-section-gap" aria-labelledby={`${noticeId}-title`}>
      <InlineHeader
        id={`${noticeId}-title`}
        title="Base instructions"
        subtitle="What Buzz tells every agent on this device before its own instructions. You can turn some sections off or replace them with your own text."
      />
      {saved.unreadable && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          Your saved choices could not be read, so every section uses its
          default text. Saving replaces them.
        </p>
      )}
      {error && error.id !== openRow && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error.message}
        </p>
      )}
      <div className="grid gap-4">
        <div>
          <div
            id={listId}
            ref={listRef}
            className={showAll ? undefined : styles.sectionPreview}
          >
            <SettingsGroup>
              {visibleSections.map((section, index) => {
                const title = sectionTitle(section);
                const choice = saved.choices[section.id];
                const replacements = section.owner ? [] : plugins(section);
                const mode =
                  choice?.mode ?? (section.owner ? "default" : undefined);
                const changed = defaultChanged(section, choice);
                const status = instructionStatus(mode);
                return (
                  <Accordion
                    key={section.id}
                    variant="popout"
                    value={openRow === section.id ? [title] : []}
                    onValueChange={(value) => toggleRow(section.id, value)}
                    items={[
                      {
                        value: title,
                        triggerLabel: title,
                        triggerDescription: changed
                          ? `${status}. Default changed.`
                          : status,
                        title: (
                          <InstructionRowTitle
                            title={title}
                            position={index + 1}
                            mode={mode}
                            changed={changed}
                          />
                        ),
                        content: section.owner ? (
                          renderEditor(section, changed)
                        ) : (
                          <div className="grid gap-1">
                            <h4 className="m-0 min-w-0 break-words py-0.5 text-body-lg font-medium">
                              {title}
                            </h4>
                            <InstructionReadingArea>
                              {replacements.length > 0 && (
                                <p className="m-0 mb-2 text-body-sm text-secondary">
                                  {canReplace(replacements)}
                                </p>
                              )}
                              <InstructionText text={defaultText(section)} />
                            </InstructionReadingArea>
                          </div>
                        ),
                      },
                    ]}
                  />
                );
              })}
              {showAll &&
                unused.map(([id, choice], index) => (
                  <Accordion
                    key={`unused/${id}`}
                    variant="popout"
                    value={
                      openRow === `unused/${id}`
                        ? [`${id}, no longer used`]
                        : []
                    }
                    onValueChange={(value) => toggleRow(`unused/${id}`, value)}
                    items={[
                      {
                        value: `${id}, no longer used`,
                        triggerLabel: `${id}, no longer used`,
                        title: (
                          <InstructionRowTitle
                            title={id}
                            position={SECTIONS.length + index + 1}
                            retired
                          />
                        ),
                        content: (
                          <div className="grid gap-1">
                            <h4 className="m-0 min-w-0 break-words py-0.5 text-body-lg font-medium">
                              {id}
                            </h4>
                            <InstructionReadingArea>
                              <InstructionText
                                text={
                                  choice.mode === "custom"
                                    ? choice.text
                                    : "You turned this section off. Buzz no longer has it."
                                }
                              />
                            </InstructionReadingArea>
                          </div>
                        ),
                      },
                    ]}
                  />
                ))}
            </SettingsGroup>
          </div>
          <div className="mt-2 flex justify-center">
            <Button
              size="sm"
              aria-controls={listId}
              aria-expanded={showAll}
              data-highlight-expanded="false"
              onClick={() => {
                if (showAll) {
                  setOpenRow(null);
                } else {
                  focusRevealedRow.current = true;
                }
                setShowAll(!showAll);
              }}
            >
              {showAll
                ? "Show less"
                : `Show all (${SECTIONS.length + unused.length})`}
            </Button>
          </div>
        </div>
        <p className="m-0 text-caption text-secondary">
          Applies to each agent from its next turn. A session that is running a
          turn changes when the turn ends. Agents in the standalone agent host
          get a change when it next starts. Mesh agents do not get the base
          instructions.
        </p>
      </div>
    </section>
  );
}
