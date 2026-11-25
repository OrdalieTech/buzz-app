import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DocConflict,
  docKey,
  docTag,
  type Doc,
  type DocAddress,
} from "./model";
import type { DocsWorkspace } from "./workspace";
import { useLiveUpdatesInterrupted } from "./live-updates";
import { useIdentityNames } from "../../features/identity-names/react";
import { isTransientFailure } from "../../features/relay/errors";
import { avatarMedia } from "../../shared/avatar-source";
import { writeClipboardText } from "../../shared/clipboard";
import { formatPublicKey } from "../../shared/identity/public-key";
import {
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  ShareIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  DocHistory,
  DocHistoryMenu,
  DocRevisionPreview,
  DocSharing,
} from "./DocDialogs";
import { DocEditor, type DocEditorHandle } from "./DocEditor";
import { DocSaveAction } from "./DocSaveAction";
import {
  DocByline,
  DocBylinePlaceholder,
  docDisplayTitle,
} from "./DocMetadata";
import { DocTitle } from "./DocTitle";
import readerStyles from "./DocsPage.module.css";
import { DocMarkdown } from "./DocMarkdown";
import styles from "./WorkingDocs.module.css";
import type { DocumentView } from "./working-route";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The doc could not be read.";
export type DocFocus = {
  target: "title" | "body";
  start: number;
  end: number;
  source: boolean;
};
export type CreatedDoc = {
  doc: Doc;
  focus: DocFocus | undefined;
  source: boolean;
};

const nothing = () => {};

function hasEdits(base: Doc, draft: Pick<Doc, "title" | "markdown">) {
  // Saved titles are trimmed. Keep the input intact while comparing with the relay.
  return (
    base.title.trim() !== draft.title.trim() || base.markdown !== draft.markdown
  );
}

export function DocDocument({
  address,
  workspace,
  onOpen,
  onOpenInDocs,
  onOpenLink,
  onChange = nothing,
  onDirty = nothing,
  onUnavailable = nothing,
  view,
  onViewChange,
  active = true,
  created,
}: {
  address: DocAddress;
  workspace: DocsWorkspace;
  onOpen(address: DocAddress): void;
  onOpenInDocs?: () => void;
  onOpenLink?: ((url: string) => boolean) | undefined;
  onChange?(doc: Doc): void;
  onDirty?(dirty: boolean): void;
  onUnavailable?(address: DocAddress): void;
  view?: DocumentView | undefined;
  onViewChange?: ((view: DocumentView) => void) | undefined;
  active?: boolean;
  created?: CreatedDoc | undefined;
}) {
  const notify = useToastNotification();
  const initialDoc = created?.doc;
  const cachedDraft = useRef(workspace.drafts.get(docKey(address))).current;
  const [doc, setDoc] = useState(cachedDraft?.base ?? initialDoc);
  const [title, setTitle] = useState(
    cachedDraft?.title ?? initialDoc?.title ?? "",
  );
  const [markdown, setMarkdown] = useState(
    cachedDraft?.markdown ?? initialDoc?.markdown ?? "",
  );
  const [localEditing, setLocalEditing] = useState(true);
  const [source, setSource] = useState(created?.source ?? false);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const pendingFocus = useRef(created?.focus);
  const needsFocus = useRef(true);
  useLayoutEffect(() => {
    if (active) needsFocus.current = true;
  }, [active]);
  const [canEdit, setCanEdit] = useState(!!initialDoc?.editable);
  const [blocking, setBlocking] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const liveInterrupted = useLiveUpdatesInterrupted(
    workspace.session.live,
    (channel) => channel === address.channel,
  );
  const busy = blocking || refreshing;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [composing, setComposing] = useState(false);
  const saveRequest = useRef<Promise<Doc> | null>(null);
  const refreshAfterSave = useRef(false);
  const refreshRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshRequest.current?.abort();
    };
  }, []);
  const [awaitingReceipt, setAwaitingReceipt] = useState(
    !!cachedDraft?.awaitingReceipt,
  );
  const initialSettlement = useRef(cachedDraft?.settlement);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const [historySelection, setHistorySelection] = useState<{
    revision: string;
    offset: number;
  }>();
  const shareTrigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const editor = useRef<DocEditorHandle>(null);
  const blankPress = useRef(false);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(!!cachedDraft && !initialDoc);
  const [retained, setRetained] = useState<Doc>();
  const [retainedReadFailed, setRetainedReadFailed] = useState(false);
  const [retainedAttempt, setRetainedAttempt] = useState(0);
  const [conflict, setConflict] = useState<Doc>();
  const [restoreFrom, setRestoreFrom] = useState<Doc | undefined>(
    cachedDraft?.restoreFrom,
  );
  const dirty =
    !!doc && (awaitingReceipt || hasEdits(doc, { title, markdown }));
  const wantsEditing = view ? (view.edit ?? true) : localEditing;
  const editing =
    wantsEditing && ((canEdit && !doc?.deleted) || dirty || !!restoreFrom);
  const [localDialog, setLocalDialog] = useState<
    "share" | "history" | "link" | "delete" | undefined
  >();
  const dialog = active ? (view ? view.dialog : localDialog) : undefined;
  useLayoutEffect(() => {
    if (dialog || !wantsEditing) {
      needsFocus.current = !wantsEditing;
      pendingFocus.current = undefined;
      return;
    }
    if (
      !active ||
      unavailable ||
      !doc ||
      !canEdit ||
      !editing ||
      !needsFocus.current
    )
      return;
    const focus = pendingFocus.current;
    if (!focus) {
      needsFocus.current = false;
      // Opening focus happens before interaction; preserve a selection already placed.
      if (
        !editor.current?.selection() &&
        document.activeElement !== titleInput.current
      )
        editor.current?.focusSelection(
          { start: 0, end: 0, source },
          { preventScroll: true },
        );
      return;
    }
    // First-save handoff waits for the shared editor to adopt the saved draft.
    const frame = requestAnimationFrame(() => {
      needsFocus.current = false;
      pendingFocus.current = undefined;
      if (focus.target === "body") editor.current?.focusSelection(focus);
      else {
        const field = titleInput.current;
        field?.focus();
        field?.setSelectionRange(focus.start, focus.end);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    active,
    unavailable,
    doc,
    canEdit,
    editing,
    dialog,
    wantsEditing,
    source,
  ]);
  const presentation = useRef({ view, onViewChange, editing });
  presentation.current = { view, onViewChange, editing };
  const setEditing = useCallback((edit: boolean) => {
    setLocalEditing(edit);
    const current = presentation.current;
    if (current.editing !== edit)
      current.onViewChange?.({ ...current.view, edit });
  }, []);
  const setDialog = useCallback((next: DocumentView["dialog"]) => {
    setLocalDialog(next);
    const current = presentation.current;
    if (current.view?.dialog !== next)
      current.onViewChange?.({
        edit: current.editing,
        ...(next ? { dialog: next } : {}),
      });
  }, []);
  const latest = useRef({
    doc,
    title,
    markdown,
    restoreFrom,
    busy,
    canEdit,
    conflict,
    unavailable,
    awaitingReceipt,
  });
  latest.current = {
    doc,
    title,
    markdown,
    restoreFrom,
    busy,
    canEdit,
    conflict,
    unavailable,
    awaitingReceipt,
  };
  const callbacks = useRef({ onChange, onDirty, onUnavailable });
  callbacks.current = { onChange, onDirty, onUnavailable };
  const community = workspace.session.scope.replace(/:[0-9a-f]{64}$/, "");
  useEffect(() => {
    const key = docKey(address);
    if (doc && dirty)
      workspace.drafts.set(key, {
        base: doc,
        title,
        markdown,
        ...(restoreFrom ? { restoreFrom } : {}),
        ...(awaitingReceipt ? { awaitingReceipt: true } : {}),
        ...(saving && saveRequest.current
          ? { settlement: saveRequest.current }
          : {}),
      });
    else workspace.drafts.delete(key);
  }, [
    workspace,
    address,
    doc,
    dirty,
    title,
    markdown,
    restoreFrom,
    awaitingReceipt,
    saving,
  ]);
  useEffect(() => {
    callbacks.current.onDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const adopt = useCallback((next: Doc) => {
    const previous = latest.current.doc;
    setRetained(
      next.deleted &&
        previous &&
        !previous.deleted &&
        previous.revision === docTag(next.event, "prev")
        ? previous
        : undefined,
    );
    setDoc(next);
    setTitle(next.title);
    setMarkdown(next.markdown);
    setConflict(undefined);
    setRestoreFrom(undefined);
    setAwaitingReceipt(false);
    setSaveError("");
    callbacks.current.onChange(next);
  }, []);
  const hideDocument = useCallback(() => {
    latest.current = { ...latest.current, unavailable: true, canEdit: false };
    setCanEdit(false);
    setUnavailable(true);
    setDialog(undefined);
    setConflict(undefined);
    callbacks.current.onUnavailable(address);
  }, [address, setDialog]);
  const refresh = useCallback(
    async ({ revoked = false } = {}) => {
      refreshRequest.current?.abort();
      if (revoked) {
        hideDocument();
        setNeedsRefresh(true);
      }
      // A local revision may echo before its save receipt. Reconcile after the
      // transaction settles so our own write cannot conflict with its draft.
      if (saveRequest.current) {
        refreshAfterSave.current = true;
        return;
      }
      const request = new AbortController();
      refreshRequest.current = request;
      const { signal } = request;
      setRefreshing(true);
      setError("");
      try {
        // A save started before closing the tab can still be in flight when it reopens.
        if (initialSettlement.current) {
          await initialSettlement.current.catch(() => {});
          initialSettlement.current = undefined;
        }
        signal.throwIfAborted();
        const current = await workspace.open(address, signal);
        const roles = await workspace.authority(current.channel, signal);
        signal.throwIfAborted();
        setNeedsRefresh(false);
        setUnavailable(false);
        setCanEdit(
          ["owner", "admin", "member", "bot"].includes(
            roles.roles[workspace.session.viewer ?? ""] ?? "",
          ) && current.editable,
        );
        const previous = latest.current;
        if (previous.doc?.revision !== current.revision) {
          if (
            previous.doc &&
            (previous.awaitingReceipt ||
              hasEdits(previous.doc, previous) ||
              previous.restoreFrom) &&
            (current.deleted || hasEdits(current, previous))
          )
            setConflict(current);
          else {
            adopt(current);
            return;
          }
        } else if (previous.awaitingReceipt) {
          setAwaitingReceipt(false);
          if (!hasEdits(current, previous)) setSaveError("");
        }
        callbacks.current.onChange(current);
      } catch (error) {
        if (signal.aborted) return;
        setNeedsRefresh(true);
        if (
          latest.current.doc &&
          !latest.current.unavailable &&
          isTransientFailure(error)
        )
          return;
        setError(errorText(error));
        if (!latest.current.unavailable) hideDocument();
      } finally {
        if (!signal.aborted) {
          refreshRequest.current = null;
          setRefreshing(false);
        }
      }
    },
    [workspace, address, adopt, hideDocument],
  );
  useEffect(() => {
    void refresh();
    return () => refreshRequest.current?.abort();
  }, [refresh]);
  useEffect(() => {
    const roster = () =>
      workspace.session.channels.get?.(address.channel)?.members?.join(":");
    let prior = roster();
    return workspace.session.channels.subscribeList(() => {
      const next = roster();
      if (next === prior) return;
      const known = prior !== undefined;
      prior = next;
      if (known) void refresh();
    });
  }, [workspace, address, refresh]);
  const deletedParent =
    !unavailable && doc?.deleted ? docTag(doc.event, "prev") : undefined;
  const retainedVersion =
    deletedParent && retained?.revision === deletedParent
      ? retained
      : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly retries the restore-source read.
  useEffect(() => {
    setRetainedReadFailed(false);
    if (!deletedParent || retainedVersion) return;
    const controller = new AbortController();
    void workspace
      .history(address, 0, controller.signal)
      .then(({ revisions }) => {
        controller.signal.throwIfAborted();
        setRetained(
          revisions.find(
            (revision) =>
              revision.revision === deletedParent && !revision.deleted,
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setRetainedReadFailed(true);
      });
    return () => controller.abort();
  }, [workspace, address, deletedParent, retainedVersion, retainedAttempt]);
  const profiles = useSyncExternalStore(
    workspace.session.profiles.subscribe,
    workspace.session.profiles.snapshot,
  );
  const resolveName = useIdentityNames(workspace.session.names);
  const author = doc?.event.pubkey ?? "";
  const profile = profiles.get(author);
  const authorName =
    author === workspace.session.viewer
      ? "You"
      : resolveName(author, profile?.name ?? formatPublicKey(author) ?? author);
  useEffect(
    () =>
      workspace.session.artifacts.follow(
        [address.channel],
        (events) => {
          if (
            events.some(
              (event) =>
                event.kind !== 45010 ||
                (event.id !== latest.current.doc?.revision &&
                  docTag(event, "d") === address.id &&
                  docTag(event, "h") === address.channel),
            )
          )
            void refresh();
        },
        () => void refresh({ revoked: true }),
      ),
    [workspace, address, refresh],
  );
  const run = async (action: () => Promise<void>) => {
    setBlocking(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (latest.current.unavailable) return;
      if (error instanceof DocConflict) setConflict(error.current);
      setError(errorText(error));
    } finally {
      setBlocking(false);
    }
  };
  const save = useCallback(
    async (revision?: Doc) => {
      const current = latest.current;
      const base = current.doc;
      if (
        !base ||
        current.busy ||
        saveRequest.current ||
        !current.canEdit ||
        current.unavailable ||
        current.conflict ||
        (!revision && !hasEdits(base, current) && !current.restoreFrom) ||
        (base.deleted && !current.restoreFrom && !revision)
      )
        return;
      const restoration = base.deleted
        ? (revision ?? current.restoreFrom)
        : undefined;
      const request = workspace.save(
        base,
        {
          title: revision?.title ?? current.title,
          markdown: revision?.markdown ?? current.markdown,
          ...(restoration ? { restoreFrom: restoration } : {}),
        },
        base.deleted ? "restore" : "update",
      );
      saveRequest.current = request;
      setSaving(true);
      if (revision) setBlocking(true);
      else setAwaitingReceipt(true);
      setSaveError("");
      try {
        const next = await request;
        if (!mounted.current || latest.current.unavailable) return;
        if (revision) {
          latest.current = {
            ...latest.current,
            doc: next,
            title: next.title,
            markdown: next.markdown,
            restoreFrom: undefined,
          };
          adopt(next);
          setDialog(undefined);
          return;
        }
        // Advance the accepted base without replacing edits made in flight.
        latest.current = {
          ...latest.current,
          doc: next,
          restoreFrom: undefined,
          awaitingReceipt: false,
        };
        setDoc(next);
        setRestoreFrom(undefined);
        setAwaitingReceipt(false);
        callbacks.current.onChange(next);
      } catch (error) {
        if (!mounted.current || latest.current.unavailable) return;
        if (error instanceof DocConflict) setConflict(error.current);
        else if (!revision && !hasEdits(base, latest.current))
          refreshAfterSave.current = true;
        setSaveError(errorText(error));
      } finally {
        saveRequest.current = null;
        if (mounted.current) {
          setSaving(false);
          if (revision) setBlocking(false);
          if (refreshAfterSave.current) {
            refreshAfterSave.current = false;
            void refresh();
          }
        }
      }
    },
    [workspace, refresh, adopt, setDialog],
  );
  useEffect(() => {
    if (
      dialog === "history" ||
      !doc ||
      !hasEdits(doc, { title, markdown }) ||
      !canEdit ||
      unavailable ||
      doc.deleted ||
      restoreFrom ||
      conflict ||
      saveError ||
      composing ||
      busy ||
      saving
    )
      return;
    const timer = window.setTimeout(() => void save(), 1500);
    return () => window.clearTimeout(timer);
  }, [
    dialog,
    canEdit,
    unavailable,
    doc,
    restoreFrom,
    conflict,
    saveError,
    composing,
    busy,
    saving,
    title,
    markdown,
    save,
  ]);
  const loading = refreshing && (!doc || unavailable);
  const displayTitle = doc && docDisplayTitle(doc, retainedVersion?.title);
  const readOnlyMessage =
    doc && !unavailable && !canEdit && !doc.deleted
      ? doc.editable
        ? "You have read-only access."
        : "This doc format is read-only in this version of Buzz."
      : undefined;
  const modeHint = !loading && !editing ? readOnlyMessage : undefined;
  const modeControl = (
    <Select
      label="Doc mode"
      variant="compact"
      appearance={!loading && editing ? "subtle" : "outlined"}
      size="sm"
      value={loading ? "" : editing ? "editing" : "viewing"}
      disabled={loading || !canEdit}
      groups={[
        {
          label: "Doc mode",
          options: [
            { value: "viewing", label: "Viewing" },
            { value: "editing", label: "Editing" },
          ],
        },
      ]}
      onValueChange={(mode) => setEditing(mode === "editing")}
    />
  );
  const showRefresh =
    needsRefresh ||
    retainedReadFailed ||
    (!!doc && !unavailable && liveInterrupted);
  const shareButton = (
    <IconButton
      ref={shareTrigger}
      aria-label="Share doc"
      title="Share doc"
      icon={<ShareIcon size={16} />}
      disabled={loading}
      onClick={() => setDialog("share")}
    />
  );
  const actionsButton = (
    <IconButton
      ref={actionsTrigger}
      aria-label="Doc actions"
      title="Doc actions"
      icon={<DotsThreeIcon size={16} />}
      disabled={loading}
    />
  );
  return (
    <article
      className={styles.documentPane}
      aria-label={
        !unavailable && doc ? displayTitle : loading ? "Loading doc" : "Doc"
      }
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: blank-space clicks extend the existing textbox hit area; keyboard users reach that textbox with Tab. */}
      <section
        className={readerStyles.document}
        aria-label="Doc contents"
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onPointerDown={(event) => {
          blankPress.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          const startedOnBlank = blankPress.current;
          blankPress.current = false;
          if (
            !startedOnBlank ||
            !editing ||
            !canEdit ||
            blocking ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey ||
            event.target !== event.currentTarget ||
            !body.current ||
            event.clientY < body.current.getBoundingClientRect().bottom
          )
            return;
          editor.current?.focusEnd();
        }}
      >
        {loading ? (
          <LoadingRegion
            pending
            label="Loading doc…"
            statusVisibility="screen-reader"
          >
            <div className={readerStyles.loadingHeader}>
              <div
                className={`${readerStyles.loadingTitle} text-heading`}
                aria-hidden="true"
              >
                <span className="h-3 w-1/2 rounded-full bg-affordance-disabled" />
              </div>
              <DocBylinePlaceholder />
            </div>
          </LoadingRegion>
        ) : doc && canEdit && !unavailable && !doc.deleted ? (
          <DocTitle
            ref={titleInput}
            value={title}
            onValueChange={setTitle}
            disabled={blocking}
            readOnly={!editing}
          />
        ) : (
          <h2 className="text-heading">
            {!unavailable && doc ? displayTitle : "Doc"}
          </h2>
        )}
        {doc && !unavailable && (
          <DocByline
            doc={doc.event}
            status={
              doc.deleted
                ? "Moved to Trash"
                : canEdit
                  ? saving
                    ? "Saving…"
                    : saveError
                      ? "Save paused"
                      : dirty
                        ? "Unsaved changes"
                        : "Saved"
                  : undefined
            }
            isAgent={!!profile?.isAgent}
            author={authorName}
            picture={avatarMedia(profile?.picture, workspace.session.media)}
          />
        )}
        <div className={styles.actions}>
          {modeHint ? (
            <Tooltip content={modeHint}>
              <fieldset
                className="min-w-20 rounded-full"
                aria-label="Doc mode"
                aria-description={modeHint}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: The disabled control's hint needs a keyboard trigger.
                tabIndex={0}
              >
                {modeControl}
              </fieldset>
            </Tooltip>
          ) : (
            (loading || (doc && canEdit && !doc.deleted)) && (
              <div className="min-w-20">{modeControl}</div>
            )
          )}
          <DocSaveAction
            shown={!!doc && ((dirty && !!saveError) || !!restoreFrom)}
            loading={saving}
            disabled={busy || !!conflict || !canEdit || unavailable}
            onClick={() => void save()}
          >
            {restoreFrom ? "Restore doc" : "Retry save"}
          </DocSaveAction>
          {doc?.deleted && canEdit && !unavailable && (
            <Button
              variant="prominent"
              size="sm"
              disabled={busy || !!conflict || !retainedVersion?.editable}
              loading={saving}
              onClick={() => void save(retainedVersion)}
            >
              Restore
            </Button>
          )}
          {showRefresh && (
            <IconButton
              aria-label="Refresh doc"
              title="Refresh doc"
              icon={
                <ArrowsClockwiseIcon
                  size={16}
                  aria-hidden="true"
                  className={busy ? "motion-safe:animate-spin" : undefined}
                />
              }
              aria-busy={busy}
              disabled={busy || saving}
              onClick={() => {
                void refresh();
                if (retainedReadFailed)
                  setRetainedAttempt((attempt) => attempt + 1);
              }}
            />
          )}
          {loading && (
            <>
              {shareButton}
              {actionsButton}
            </>
          )}
          {doc && !unavailable && (
            <>
              {shareButton}
              <MenuRoot>
                <MenuTrigger render={actionsButton} />
                <MenuPopup>
                  {onOpenInDocs && (
                    <MenuItem onClick={onOpenInDocs}>Open in Docs</MenuItem>
                  )}
                  {canEdit && !doc.deleted && (
                    <MenuItem
                      onClick={() => {
                        setSource(editing ? !source : true);
                        setEditing(true);
                      }}
                    >
                      {editing && source ? "Formatted text" : "Markdown source"}
                    </MenuItem>
                  )}
                  <DocHistoryMenu
                    doc={doc}
                    workspace={workspace}
                    onSelect={(revision, offset) => {
                      setHistorySelection({ revision, offset });
                      setLocalDialog("history");
                      presentation.current.onViewChange?.({
                        edit: editing,
                        dialog: "history",
                        revision,
                        offset,
                      });
                    }}
                  />
                  {canEdit && !doc.deleted && (
                    <MenuItem
                      tone="danger"
                      disabled={busy || saving || dirty}
                      onClick={() => setDialog("delete")}
                    >
                      Move to Trash
                    </MenuItem>
                  )}
                </MenuPopup>
              </MenuRoot>
            </>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        {saveError && !unavailable && (
          <p role="alert">
            Auto-save is paused. Your draft is kept. {saveError}
          </p>
        )}
        {readOnlyMessage && editing && (
          <p className="text-caption text-subtle">{readOnlyMessage}</p>
        )}
        {doc?.deleted && !unavailable && (
          <p className="text-body-sm text-subtle">This doc is in Trash.</p>
        )}
        {doc && !doc.deleted && !unavailable && (
          <div
            ref={body}
            className={source && editing ? styles.sourceBody : styles.stack}
          >
            <DocEditor
              ref={editor}
              source={source}
              onSourceChange={setSource}
              toolbarTarget={toolbarTarget}
              value={markdown}
              editing={editing}
              onChange={setMarkdown}
              disabled={blocking}
              linkOpen={dialog === "link"}
              onLinkOpenChange={(open) => setDialog(open ? "link" : undefined)}
              onSave={() => {
                if (saveError || restoreFrom) void save();
              }}
            >
              <DocMarkdown
                text={markdown}
                community={community}
                onOpen={onOpen}
                session={workspace.session}
                openLink={onOpenLink}
              />
            </DocEditor>
          </div>
        )}
        {doc && !unavailable && dialog === "share" && (
          <DocSharing
            doc={doc}
            workspace={workspace}
            trigger={shareTrigger}
            onClose={() => setDialog(undefined)}
          />
        )}
        {doc && !unavailable && dialog === "history" && (
          <DocHistory
            doc={doc}
            workspace={workspace}
            canEdit={canEdit && !conflict && !unavailable}
            dirty={dirty || !!restoreFrom}
            pending={blocking}
            restoreDisabled={busy || saving}
            error={saveError}
            trigger={actionsTrigger}
            selection={view ?? historySelection ?? {}}
            onClose={() => setDialog(undefined)}
            onRestore={(revision) => void save(revision)}
          />
        )}
        {doc && !unavailable && dialog === "delete" && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setDialog(undefined);
            }}
            title="Move this doc to Trash?"
            description="You can restore it later."
            preventClose={busy}
            actions={
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDialog(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      const deleted = await workspace.save(
                        doc,
                        { title: doc.title, markdown: "" },
                        "delete",
                      );
                      if (!latest.current.unavailable) {
                        adopt(deleted);
                        setDialog(undefined);
                      }
                    });
                  }}
                >
                  Move to Trash
                </Button>
              </>
            }
          />
        )}
        {conflict && !unavailable && active && (
          <Dialog
            open
            onOpenChange={() => {}}
            title={
              conflict.deleted
                ? "This doc was moved to Trash"
                : "This doc has a newer revision"
            }
            description={
              conflict.deleted
                ? "Copy your draft before opening the version in Trash."
                : "Compare the latest contents with your unsaved draft before choosing what to keep."
            }
            size="wide"
            height="stable"
            preventClose
            actions={
              <>
                <Button
                  onClick={() => {
                    adopt(conflict);
                    setEditing(false);
                    setError("");
                  }}
                >
                  {conflict.deleted ? "Open in Trash" : "Use latest version"}
                </Button>
                {conflict.deleted ? (
                  <Button
                    onClick={async () => {
                      try {
                        await writeClipboardText(
                          [title, markdown].filter(Boolean).join("\n\n"),
                        );
                        notify("Draft copied.", "success");
                      } catch {
                        notify("Couldn’t copy the draft.", "error");
                      }
                    }}
                  >
                    Copy draft
                  </Button>
                ) : (
                  <Button
                    disabled={!conflict.editable}
                    onClick={() => {
                      setDoc(conflict);
                      setAwaitingReceipt(false);
                      setConflict(undefined);
                      setError("");
                      setSaveError("");
                    }}
                  >
                    Keep my draft
                  </Button>
                )}
              </>
            }
          >
            <DocRevisionPreview
              revision={conflict}
              workspace={workspace}
              label="Latest revision"
            />
          </Dialog>
        )}
      </section>
      <div ref={setToolbarTarget} className={styles.editorDock} />
    </article>
  );
}
