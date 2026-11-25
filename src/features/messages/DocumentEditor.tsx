import {
  AnimatePresence,
  motion,
  useIsPresent,
  usePresenceData,
  useReducedMotion,
} from "motion/react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { EditableInput } from "./EditableInput";
import { ComposerFormattingTools } from "./ComposerFormattingTools";
import { ComposerLinkDialog } from "./ComposerLinkDialog";
import type {
  ComposerFormat,
  ComposerInputElement,
  ComposerLinkEdit,
} from "./composer-dom";
import { useScrollEdges } from "../../shared/design-system/ui/useScrollEdges";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  documentEditorDraft,
  documentEditorMarkdown,
} from "./document-editor-markdown";
import { MAX_MARKDOWN_LENGTH } from "../relay/message-content";
import markdownStyles from "../markdown/Markdown.module.css";
import styles from "./DocumentEditor.module.css";

const noDecorations = () => [];

const scrollReservations = new WeakMap<
  HTMLElement,
  { editors: number; restore(): void }
>();

function* documentScrollContainers(editor: HTMLElement) {
  const root = editor.ownerDocument.scrollingElement;
  for (
    let pane = editor.parentElement;
    pane && pane !== root;
    pane = pane.parentElement
  ) {
    if (
      ["auto", "scroll", "overlay"].includes(getComputedStyle(pane).overflowY)
    )
      yield pane;
  }
  if (root instanceof HTMLElement) yield root;
}

function documentScroller(editor: HTMLElement) {
  let nearest: HTMLElement | null = null;
  for (const pane of documentScrollContainers(editor)) {
    nearest ??= pane;
    // Horizontal clipping can compute to overflow-y: auto on a wrapper
    // that grows with its content and never scrolls vertically.
    if (pane.clientHeight > 0 && pane.scrollHeight > pane.clientHeight)
      return pane;
  }
  return nearest;
}

function reserveToolbarScrollSpace(editor: HTMLElement, scroller: HTMLElement) {
  let reservation = scrollReservations.get(scroller);
  if (!reservation) {
    const { style } = scroller;
    const property = "scroll-padding-block-end";
    const previous = style.getPropertyValue(property);
    const priority = style.getPropertyPriority(property);
    const padding = getComputedStyle(scroller).scrollPaddingBlockEnd;
    const clearance = getComputedStyle(editor).getPropertyValue(
      "--document-toolbar-space",
    );
    // Native caret scrolling uses the pane's padding, including any larger
    // clearance already set by the plugin.
    style.setProperty(
      property,
      `max(${padding && padding !== "auto" ? padding : "0px"}, ${clearance})`,
      priority,
    );
    const applied = style.getPropertyValue(property);
    reservation = {
      editors: 0,
      restore() {
        if (
          style.getPropertyValue(property) === applied &&
          style.getPropertyPriority(property) === priority
        )
          style.setProperty(property, previous, priority);
      },
    };
    scrollReservations.set(scroller, reservation);
  }

  reservation.editors++;
  const current = reservation;
  return () => {
    if (--current.editors === 0) {
      current.restore();
      scrollReservations.delete(scroller);
    }
  };
}

export type DocumentEditorSelection = {
  start: number;
  end: number;
  source: boolean;
};
export type DocumentEditorHandle = {
  focusEnd(): void;
  selection(): DocumentEditorSelection | undefined;
  focusSelection(
    selection: DocumentEditorSelection,
    options?: FocusOptions,
  ): void;
};

export type DocumentEditorProps = {
  ref?: Ref<DocumentEditorHandle>;
  value: string;
  editing: boolean;
  children?: ReactNode;
  onChange(value: string): void;
  disabled?: boolean;
  variant?: "field";
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean;
  destinations?: readonly { label: string; href: string }[];
  label?: string;
  placeholder?: string;
  maxLength: number;
  linkOpen?: boolean;
  onLinkOpenChange?(open: boolean): void;
  onSave?(): void;
  toolbarTarget?: HTMLElement | null;
  source?: boolean;
  onSourceChange?(source: boolean): void;
};

function DocumentFormattingToolbar({
  surfaceRef,
  children,
}: {
  surfaceRef: Ref<HTMLFieldSetElement>;
  children: ReactNode;
}) {
  const present = useIsPresent();
  const instant: boolean = usePresenceData();
  const hidden = { opacity: 0, y: instant ? "0rem" : "0.75rem" };
  return (
    <div className={styles.toolbarAnchor}>
      <motion.fieldset
        ref={surfaceRef}
        className={styles.editorToolbar}
        aria-label="Document formatting"
        aria-hidden={!present || undefined}
        inert={!present}
        initial={hidden}
        animate={{ opacity: 1, y: "0rem" }}
        exit={hidden}
        transition={{
          duration: instant ? 0 : 0.22,
          ease: [0.645, 0.045, 0.355, 1],
        }}
      >
        {children}
      </motion.fieldset>
    </div>
  );
}

function documentContent(value: string, field: boolean) {
  const draft = documentEditorDraft(value);
  return { draft, literal: field && documentEditorMarkdown(draft) !== value };
}

/** A document body using the composer's editing engine, without chat behavior. */
export function DocumentEditor({
  ref,
  value,
  editing,
  children,
  onChange,
  disabled = false,
  variant,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  destinations,
  label = "Document body",
  placeholder = "Write…",
  maxLength,
  linkOpen: controlledLinkOpen,
  onLinkOpenChange: setControlledLinkOpen,
  onSave,
  toolbarTarget = null,
  source: sourceMode = false,
  onSourceChange,
}: DocumentEditorProps) {
  const field = variant === "field";
  const [content, setContent] = useState(() => documentContent(value, field));
  const { draft, literal } = content;
  const source = sourceMode || literal;
  const [localLinkOpen, setLocalLinkOpen] = useState(false);
  const linkOpen = controlledLinkOpen ?? localLinkOpen;
  const onLinkOpenChange = setControlledLinkOpen ?? setLocalLinkOpen;
  const stack = useRef<HTMLDivElement>(null);
  const updateEditorScroller = useRef<() => HTMLElement | null>(null);
  const toolbarSurface = useRef<HTMLFieldSetElement>(null);
  const input = useRef<ComposerInputElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useScrollEdges("block");
  useLayoutEffect(() => {
    scrollRef(
      field && editing ? (source ? sourceInput.current : input.current) : null,
    );
  }, [editing, field, scrollRef, source]);
  useImperativeHandle(
    ref,
    () => ({
      selection() {
        const field = source ? sourceInput.current : input.current;
        if (!field?.contains(document.activeElement)) return;
        return { start: field.selectionStart, end: field.selectionEnd, source };
      },
      focusSelection(selection, options) {
        if (!editing || disabled) return;
        const field = source ? sourceInput.current : input.current;
        if (!field) return;
        // Set the caret first when preserving scroll so focus cannot reveal its old position.
        if (!options?.preventScroll) field.focus();
        field.setSelectionRange(selection.start, selection.end);
        if (options?.preventScroll) field.focus(options);
      },
      focusEnd() {
        if (!editing || disabled) return;
        const field = source ? sourceInput.current : input.current;
        if (!field) return;
        const end = field.value.length;
        field.focus();
        field.setSelectionRange(end, end);
      },
    }),
    [editing, disabled, source],
  );
  const [formats, setFormats] = useState<readonly ComposerFormat[]>([]);
  const [link, setLink] = useState<ComposerLinkEdit>();
  const emitted = useRef(value);
  const syncing = useRef(false);
  const accepted = useRef<
    | {
        value: string;
        draft: typeof draft;
        restore(): void;
      }
    | undefined
  >(undefined);
  const rememberAccepted = () => {
    if (
      !source &&
      !syncing.current &&
      emitted.current === value &&
      input.current
    )
      accepted.current = { value, draft, restore: input.current.checkpoint() };
  };
  // A rich edit renders even when its onChange is declined. Reconcile every
  // committed render so only accepted content survives, before the next paint.
  useLayoutEffect(() => {
    syncing.current = false;
    if (sourceMode) return;
    if (value === emitted.current) {
      rememberAccepted();
      return;
    }
    emitted.current = value;
    syncing.current = true;
    const previous = accepted.current;
    if (previous?.value === value) {
      // Restore the accepted document, selection and undo state without an edit
      // transaction that could normalize Markdown or notify the plugin again.
      previous.restore();
      setContent({ draft: previous.draft, literal: false });
    } else setContent(documentContent(value, field));
  });
  useLayoutEffect(() => {
    // The engine emits native select events even when formatting is unchanged.
    const field = input.current;
    field?.addEventListener("select", rememberAccepted);
    return () => field?.removeEventListener("select", rememberAccepted);
  });
  useEffect(() => {
    if (!linkOpen) {
      setLink(undefined);
      return;
    }
    if (sourceMode) onSourceChange?.(false);
    setLink((old) => old ?? input.current?.editLink() ?? undefined);
  }, [linkOpen, sourceMode, onSourceChange]);
  const editLink = (edit?: ComposerLinkEdit) => {
    const next = edit ?? input.current?.editLink();
    if (!next) return;
    setLink(next);
    onLinkOpenChange(true);
  };
  const showFormatting = editing && !source && !field;
  useLayoutEffect(() => {
    const editor = stack.current;
    if (!showFormatting || !editor) return;
    let scroller: HTMLElement | null = null;
    let release: (() => void) | undefined;
    const update = () => {
      const next = documentScroller(editor);
      if (next !== scroller) {
        release?.();
        scroller = next;
        release = next ? reserveToolbarScrollSpace(editor, next) : undefined;
      }
      return scroller;
    };
    updateEditorScroller.current = update;
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(editor);
    if (observer)
      for (const pane of documentScrollContainers(editor))
        observer.observe(pane);
    return () => {
      observer?.disconnect();
      updateEditorScroller.current = null;
      release?.();
    };
  }, [showFormatting]);
  const revealAboveToolbar = (bottom: number) => {
    const toolbar = toolbarSurface.current;
    if (!toolbar) return;
    const overlap = bottom - toolbar.getBoundingClientRect().top;
    if (overlap <= 0) return;
    const scroller = updateEditorScroller.current?.();
    if (scroller) scroller.scrollTop += Math.ceil(overlap);
  };
  const reduceMotion = useReducedMotion();
  const instant =
    !!reduceMotion ||
    (typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-keyboard-navigation"));
  const toolbar = (
    <AnimatePresence custom={instant}>
      {showFormatting && (
        <DocumentFormattingToolbar surfaceRef={toolbarSurface}>
          <ComposerFormattingTools
            persistent
            markdownMode="document"
            disabled={disabled}
            activeFormats={formats}
            toggleFormat={(format) => input.current?.toggleFormat(format)}
            editLink={() => editLink()}
          >
            {null}
          </ComposerFormattingTools>
        </DocumentFormattingToolbar>
      )}
    </AnimatePresence>
  );
  return (
    <div
      ref={stack}
      className={`${styles.stack} ${field ? styles.field : ""} ${editing && source ? styles.sourceEditor : ""}`}
      data-formatting={showFormatting || undefined}
      data-disabled={(field && disabled) || undefined}
    >
      <section
        className={`${styles.editorBody} text-message`}
        aria-label="Document content"
      >
        <div hidden={!editing}>
          {source ? (
            <Textarea
              ref={sourceInput}
              aria-label={field ? label : "Markdown"}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={value}
              rows={4}
              maxLength={maxLength}
              variant={field ? "text" : "code"}
              appearance={field ? "outlined" : "field"}
              disabled={disabled || !editing}
              onKeyDown={(event) => {
                if (disabled || !editing) return;
                if (
                  onSave &&
                  (event.metaKey || event.ctrlKey) &&
                  event.key === "Enter"
                ) {
                  event.preventDefault();
                  onSave();
                }
              }}
              onChange={(event) => {
                if (literal) emitted.current = event.target.value;
                onChange(event.target.value);
              }}
            />
          ) : (
            <div className={field ? undefined : markdownStyles.documentScale}>
              <EditableInput
                ref={input}
                draft={draft}
                value={draft.text}
                disabled={disabled || !editing}
                placeholder={placeholder}
                aria-label={label}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                maxLength={Math.min(maxLength, MAX_MARKDOWN_LENGTH)}
                markdownMode="document"
                preservePlainTextLineBreaks={field}
                decorationsFor={noDecorations}
                onDraftChange={(next) => {
                  if (syncing.current) return;
                  setContent({ draft: next, literal: false });
                  const markdown = documentEditorMarkdown(next);
                  if (markdown !== value) {
                    emitted.current = markdown;
                    onChange(markdown);
                  }
                }}
                onFormatsChange={setFormats}
                onScrollCaret={revealAboveToolbar}
                onEditLink={editLink}
                onKeyDown={(event) => {
                  if (disabled || !editing) return;
                  if (
                    event.shiftKey &&
                    !event.defaultPrevented &&
                    ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(
                      event.key,
                    )
                  ) {
                    const field = event.currentTarget;
                    const owner = field.ownerDocument;
                    // Native range extension can move into the obscured area
                    // before reaching the browser's scroll threshold.
                    owner.defaultView?.requestAnimationFrame(() => {
                      if (
                        input.current !== field ||
                        owner.activeElement !== field
                      )
                        return;
                      const selection = owner.getSelection();
                      if (
                        selection?.isCollapsed !== false ||
                        !selection.focusNode ||
                        !field.contains(selection.focusNode)
                      )
                        return;
                      const head = owner.createRange();
                      head.setStart(selection.focusNode, selection.focusOffset);
                      revealAboveToolbar(head.getBoundingClientRect().bottom);
                    });
                  }
                  if (
                    !event.defaultPrevented &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.altKey &&
                    !event.shiftKey &&
                    event.key.toLowerCase() === "k"
                  ) {
                    event.preventDefault();
                    editLink();
                  }

                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (event.metaKey || event.ctrlKey) onSave?.();
                    else
                      input.current?.insertLineBreak(
                        event.shiftKey ? "hard" : "paragraph",
                      );
                  }
                  if (
                    destinations?.length &&
                    event.key === "[" &&
                    input.current?.value[input.current.selectionStart - 1] ===
                      "["
                  ) {
                    event.preventDefault();
                    const start = input.current.selectionStart - 1;
                    input.current.setSelectionRange(
                      start,
                      input.current.selectionEnd,
                    );
                    const next = input.current.editLink();
                    if (next) editLink({ ...next, text: "" });
                  }
                }}
              />
            </div>
          )}
        </div>
        {!editing && children}
      </section>
      {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar}
      {editing && linkOpen && link && (
        <ComposerLinkDialog
          edit={link}
          input={input}
          disabled={disabled || !editing}
          destinations={destinations}
          limitLabel="document"
          close={() => onLinkOpenChange(false)}
        />
      )}
    </div>
  );
}
