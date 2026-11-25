import { useEffect, useMemo, useRef, useState } from "react";
import { docKey, type Doc } from "./model";
import { DocCreationUnconfirmed, type DocsWorkspace } from "./workspace";
import { DotsThreeIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { DocEditor, type DocEditorHandle } from "./DocEditor";
import type { CreatedDoc, DocFocus } from "./DocDocument";
import { DocSaveAction } from "./DocSaveAction";
import { DocTitle } from "./DocTitle";
import readerStyles from "./DocsPage.module.css";
import styles from "./WorkingDocs.module.css";

const AUTO_SAVE_IDLE_MS = 1500;

export type NewDraft = {
  id: string;
  title: string;
  markdown: string;
};

/** Creation uses the document editor; storage is allocated only after typing. */
export function NewDocDocument({
  workspace,
  initial,
  active,
  onDraftChange,
  onCreated,
}: {
  workspace: DocsWorkspace;
  initial: NewDraft;
  active: boolean;
  onDraftChange(draft: NewDraft): void;
  onCreated(created: CreatedDoc): void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [markdown, setMarkdown] = useState(initial.markdown);
  const [source, setSource] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState<{
    doc: Doc;
    editAtStart: number;
  }>();
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const handedOff = useRef(false);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState("");
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const editor = useRef<DocEditorHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  const blankPress = useRef(false);
  const lastEditAt = useRef(-Infinity);
  const attempt = useRef<NewDraft | undefined>(undefined);
  const draft = useMemo(
    () => ({ id: initial.id, title, markdown }),
    [initial.id, title, markdown],
  );
  const latest = useRef(draft);
  latest.current = draft;
  const callbacks = useRef({ onDraftChange, onCreated });
  callbacks.current = { onDraftChange, onCreated };
  const dirty = !!(title.trim() || markdown.trim());
  const saved =
    accepted?.doc.title === (title.trim() || "Untitled doc") &&
    accepted.doc.markdown === markdown;
  useEffect(() => {
    callbacks.current.onDraftChange(draft);
  }, [draft]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => titleInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => {
    if (!accepted || composing || actionsOpen || linkOpen || handedOff.current)
      return;
    const { doc, editAtStart } = accepted;
    const handOff = () => {
      handedOff.current = true;
      const nextTitle = title.trim() ? title : "Untitled doc";
      if (nextTitle !== doc.title || markdown !== doc.markdown)
        workspace.drafts.set(docKey(doc), {
          base: doc,
          title: nextTitle,
          markdown,
        });
      const selection = editor.current?.selection();
      const focus: DocFocus | undefined =
        document.activeElement === titleInput.current
          ? {
              target: "title",
              start: titleInput.current?.selectionStart ?? 0,
              end: titleInput.current?.selectionEnd ?? 0,
              source,
            }
          : selection
            ? { target: "body", ...selection }
            : undefined;
      callbacks.current.onCreated({ doc, focus, source });
    };
    // Creation replaces this editor. Wait again if typing resumed in flight.
    const remaining = AUTO_SAVE_IDLE_MS - (Date.now() - lastEditAt.current);
    if (lastEditAt.current === editAtStart || remaining <= 0) return handOff();
    const timer = window.setTimeout(handOff, remaining);
    return () => window.clearTimeout(timer);
  }, [
    accepted,
    actionsOpen,
    composing,
    linkOpen,
    title,
    markdown,
    source,
    workspace,
  ]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const save = async () => {
    if (
      pending.current ||
      accepted ||
      (!dirty && !attempt.current) ||
      composing
    )
      return;
    const controller = new AbortController();
    const editAtStart = lastEditAt.current;
    request.current = controller;
    pending.current = true;
    setBusy(true);
    setError("");
    const proposed = attempt.current ?? {
      ...latest.current,
      title: latest.current.title.trim() || "Untitled doc",
    };
    try {
      const doc = await workspace.create(proposed, controller.signal);
      controller.signal.throwIfAborted();
      setAccepted({ doc, editAtStart });
    } catch (error) {
      if (controller.signal.aborted) return;
      // Keep the original payload only while its receipt is uncertain.
      if (error instanceof DocCreationUnconfirmed) attempt.current = proposed;
      setError(
        error instanceof Error ? error.message : "The doc could not be saved.",
      );
    } finally {
      request.current = null;
      pending.current = false;
      setBusy(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (
      !active ||
      !(title.trim() || markdown.trim()) ||
      accepted ||
      error ||
      composing ||
      linkOpen ||
      busy
    )
      return;
    const timer = window.setTimeout(
      () => void saveRef.current(),
      AUTO_SAVE_IDLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [active, accepted, error, composing, linkOpen, busy, title, markdown]);
  return (
    <article className={styles.documentPane} aria-label="New doc">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: blank-space clicks extend the existing textbox hit area; keyboard users reach that textbox with Tab. */}
      <section
        className={readerStyles.document}
        aria-label="Doc contents"
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => {
          lastEditAt.current = Date.now();
          setComposing(false);
        }}
        onPointerDown={(event) => {
          blankPress.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          const blank = blankPress.current;
          blankPress.current = false;
          if (
            blank &&
            event.target === event.currentTarget &&
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            body.current &&
            event.clientY >= body.current.getBoundingClientRect().bottom
          )
            editor.current?.focusEnd();
        }}
      >
        <DocTitle
          ref={titleInput}
          placeholder="Untitled doc"
          value={title}
          onValueChange={(next) => {
            lastEditAt.current = Date.now();
            setTitle(next);
          }}
        />
        {(busy || dirty) && (
          <p className={`${readerStyles.byline} text-caption text-secondary`}>
            <span role="status">
              {busy
                ? "Saving…"
                : error
                  ? "Save paused"
                  : saved
                    ? "Saved"
                    : "Unsaved changes"}
            </span>
          </p>
        )}
        <div className={styles.actions}>
          <Select
            label="Doc mode"
            variant="compact"
            appearance="subtle"
            size="sm"
            value="editing"
            onValueChange={() => {}}
            disabled
            groups={[
              {
                label: "Doc mode",
                options: [{ value: "editing", label: "Editing" }],
              },
            ]}
          />
          <DocSaveAction
            shown={!!error}
            loading={busy}
            onClick={() => void save()}
          >
            Retry save
          </DocSaveAction>
          <MenuRoot open={actionsOpen} onOpenChange={setActionsOpen}>
            <MenuTrigger
              render={
                <IconButton
                  aria-label="Doc actions"
                  title="Doc actions"
                  icon={<DotsThreeIcon size={16} />}
                />
              }
            />
            <MenuPopup>
              <MenuItem onClick={() => setSource(!source)}>
                {source ? "Formatted text" : "Markdown source"}
              </MenuItem>
            </MenuPopup>
          </MenuRoot>
        </div>
        {error && (
          <p role="alert">Auto-save is paused. Your draft is kept. {error}</p>
        )}
        <div ref={body} className={source ? styles.sourceBody : styles.stack}>
          <DocEditor
            ref={editor}
            value={markdown}
            editing
            disabled={false}
            onChange={(next) => {
              lastEditAt.current = Date.now();
              setMarkdown(next);
            }}
            linkOpen={active && linkOpen}
            onLinkOpenChange={setLinkOpen}
            onSave={() => {
              if (error) void save();
            }}
            toolbarTarget={toolbarTarget}
            source={source}
            onSourceChange={setSource}
          >
            {null}
          </DocEditor>
        </div>
      </section>
      <div ref={setToolbarTarget} className={styles.editorDock} />
    </article>
  );
}
