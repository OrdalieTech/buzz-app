import type { FileCardProps } from "../conversation/contracts";
import {
  IconButton,
  type IconButtonProps,
} from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowUpRightIcon,
  ArrowsClockwiseIcon,
  CheckIcon,
  CircleNotchIcon,
  DownloadIcon,
  FolderOpenIcon,
} from "../../shared/design-system/icons/index";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuIcon,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { FileTypeIcon } from "./FileTypeIcon";
import fileIconStyles from "./FileTypeIcon.module.css";
import type { Attachment } from "../relay/contracts";
import { isApplePlatform } from "../shortcuts/format";
import {
  isNativeMediaSource,
  isProxySource,
  safeOpenUrl,
} from "./attachment-source";
import styles from "./Messages.module.css";
import {
  downloadNativeMedia,
  openSavedDownload,
  savedDownloadStatus,
  subscribeSavedDownloads,
} from "./native-download";
import { useNativeDownload, type DownloadState } from "./use-native-download";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** A native file card. `checking` has not heard yet whether a saved copy
 * exists, and `choosing` is a click waiting to hear. `ready` has a copy to
 * open; `moved` lost it; `failedAgain` kept its copy when Download again failed. */
type FileCardState =
  | "checking"
  | "choosing"
  | "idle"
  | "pending"
  | "ready"
  | "moved"
  | "openFailed"
  | "failed"
  | "failedAgain";

/** How long a click or a failed download waits to hear about a saved copy. */
const SAVED_ANSWER_LIMIT_MS = 5000;

/** Whether the host has a saved copy; none when it fails or does not answer. */
function hasSavedCopy(source: string, name: string) {
  return new Promise<boolean>((resolve) => {
    const limit = setTimeout(resolve, SAVED_ANSWER_LIMIT_MS, false);
    void savedDownloadStatus(source, name)
      .catch(() => false)
      .then((saved) => {
        clearTimeout(limit);
        resolve(saved);
      });
  });
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${Math.round(size / (1024 * 1024))} MB`;
  return `${Math.round(size / (1024 * 1024 * 1024))} GB`;
}

function mimeLabel(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const [type, subtype] = mime.split("/");
  if (!type || !subtype) return undefined;
  if (subtype === "pdf") return "PDF file";
  if (!/^[a-z0-9]+$/i.test(subtype)) return undefined;
  return `${subtype.toUpperCase()} file`;
}

export function FileAttachment({
  attachment,
  source,
  onOpenLink,
  onPreview,
  typeLabel,
}: Omit<FileCardProps, "source"> & { source: string | undefined }) {
  const displayName = attachment.name ?? mimeLabel(attachment.mime) ?? "File";
  const nativeSource = source ? isNativeMediaSource(source) : false;
  const proxySource = source ? isProxySource(source) || nativeSource : false;
  const externalSource = !!source && safeOpenUrl(source) && !proxySource;
  if (source && !proxySource && !externalSource)
    return (
      <UnavailableFileAttachment
        displayName={displayName}
        attachment={attachment}
      />
    );

  if (source && proxySource && onPreview) {
    const renderPreview = (
      state: DownloadState = "idle",
      download?: () => Promise<void>,
    ) => {
      const action = {
        "aria-label": `${state === "failed" ? "Retry download" : "Download"} ${displayName}`,
        title: `Download ${displayName}`,
        icon:
          state === "failed" ? (
            <ArrowsClockwiseIcon aria-hidden="true" />
          ) : state === "saved" ? (
            <CheckIcon aria-hidden="true" />
          ) : (
            <DownloadIcon aria-hidden="true" />
          ),
        shape: "row-end",
      } satisfies IconButtonProps;
      return (
        <div className={styles.filePreviewAttachment}>
          {/* Unselectable, so a copied selection leaves it out; the macOS
              app's engine does not report that style to the copy walk. */}
          <div className={styles.filePreviewMain} data-copy-skip>
            <NavigationItem
              aria-label={`Preview ${displayName}`}
              icon={
                <span className={fileIconStyles.slot}>
                  <FileTypeIcon name={attachment.name} mime={attachment.mime} />
                </span>
              }
              label={
                <span className={styles.fileAttachmentBody}>
                  <span
                    className={styles.fileAttachmentName}
                    title={displayName}
                  >
                    {displayName}
                  </span>
                  <span className={styles.fileAttachmentMeta}>
                    {state === "pending" ? (
                      "Downloading…"
                    ) : state === "saved" ? (
                      "Saved to Downloads"
                    ) : state === "failed" ? (
                      "Couldn’t download · Retry"
                    ) : (
                      <>
                        {typeLabel ?? mimeLabel(attachment.mime) ?? "File"}
                        {attachment.size !== undefined &&
                          ` · ${formatFileSize(attachment.size)}`}
                      </>
                    )}
                  </span>
                </span>
              }
              onClick={onPreview}
            />
          </div>
          <span className={styles.fileDownloadAction}>
            {nativeSource ? (
              <IconButton
                {...action}
                loading={state === "pending"}
                onClick={() => void download?.()}
              />
            ) : (
              <IconButton
                {...action}
                nativeButton={false}
                role="link"
                render={<a href={source} download={attachment.name ?? ""} />}
              />
            )}
          </span>
        </div>
      );
    };
    return nativeSource ? (
      <NativeDownloadAction
        key={JSON.stringify([source, attachment.name])}
        source={source}
        name={attachment.name ?? ""}
        displayName={displayName}
      >
        {renderPreview}
      </NativeDownloadAction>
    ) : (
      renderPreview()
    );
  }

  const content = (state: FileCardState = "idle") => (
    <>
      <span className={fileIconStyles.slot}>
        <FileTypeIcon name={attachment.name} mime={attachment.mime} />
      </span>
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        {/* A copied selection leaves this out: it would run into the name. */}
        <span className={styles.fileAttachmentMeta} data-copy-skip>
          {state === "pending"
            ? "Downloading…"
            : state === "ready"
              ? attachment.size
                ? `${formatFileSize(attachment.size)} · Downloaded`
                : "Downloaded"
              : state === "moved"
                ? "Moved or changed · Download again"
                : state === "openFailed"
                  ? "Couldn’t open · Try again"
                  : state === "failed"
                    ? "Couldn’t download · Retry"
                    : state === "choosing"
                      ? "Checking…"
                      : source
                        ? attachment.size
                          ? formatFileSize(attachment.size)
                          : proxySource
                            ? "Download file"
                            : "Open file"
                        : "File unavailable"}
        </span>
      </span>
      {state === "pending" || state === "choosing" ? (
        <CircleNotchIcon
          size={20}
          className="motion-safe:animate-spin"
          aria-hidden="true"
        />
      ) : state === "failed" || state === "openFailed" ? (
        <ArrowsClockwiseIcon size={20} aria-hidden="true" />
      ) : proxySource && state !== "ready" ? (
        <DownloadIcon size={20} aria-hidden="true" />
      ) : (
        <ArrowUpRightIcon size={20} aria-hidden="true" />
      )}
    </>
  );
  if (!source)
    return (
      <UnavailableFileAttachment
        displayName={displayName}
        attachment={attachment}
      />
    );
  if (externalSource)
    return (
      <a
        className={styles.fileAttachment}
        href={source}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${displayName}`}
        title={displayName}
        // A copied selection labels the link with this, not its text, which
        // runs the name into the size.
        data-link-label={displayName}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (onOpenLink(source)) event.preventDefault();
        }}
      >
        {content()}
      </a>
    );
  if (nativeSource)
    return (
      <NativeFileDownload
        key={JSON.stringify([source, attachment.name])}
        source={source}
        name={attachment.name ?? ""}
        displayName={displayName}
      >
        {content}
      </NativeFileDownload>
    );
  return (
    <a
      className={styles.fileAttachment}
      href={source}
      download={attachment.name ?? ""}
      aria-label={`Download ${displayName}`}
      title={displayName}
    >
      {content()}
    </a>
  );
}

/** The download action beside a preview card: a source/name change mounts a
 * fresh download lifetime, retiring old results. */
function NativeDownloadAction({
  source,
  name,
  displayName,
  children,
}: {
  source: string;
  name: string;
  displayName: string;
  children(state: DownloadState, download: () => Promise<void>): ReactNode;
}) {
  const { state, download } = useNativeDownload(source, name);
  const announcement =
    state === "pending"
      ? `Downloading ${displayName}`
      : state === "saved"
        ? `Saved ${displayName} to Downloads`
        : state === "failed"
          ? `Couldn’t download ${displayName}. Try again.`
          : "";
  return (
    <>
      {children(state, download)}
      {/* Not shown, so not copied by a selection that runs past the card. */}
      <span
        className="sr-only"
        role={state === "failed" ? "alert" : "status"}
        data-copy-skip
      >
        {announcement}
      </span>
    </>
  );
}

/** A source/name change mounts a fresh download lifetime, retiring old results.
 * The host remembers where it saved the file; once saved, a click opens that
 * copy and the context menu shows it in its folder or downloads it again.
 * Until the host has said whether a copy exists, the card looks ready to
 * download, and a click asks before it opens or downloads. */
function NativeFileDownload({
  source,
  name,
  displayName,
  children,
}: {
  source: string;
  name: string;
  displayName: string;
  children(state: FileCardState): ReactNode;
}) {
  const [state, setState] = useState<FileCardState>("checking");
  // Only this card's own actions are announced, never a status found on mount.
  const [notice, setNotice] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement>();
  const trigger = useRef<HTMLButtonElement>(null);
  // Counts status requests and actions. A status is stale once a later one
  // was asked, an action started, or the card unmounted.
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      // The action in progress decides the state it ends in.
      if (busy.current) return;
      generation.current += 1;
      const asked = generation.current;
      // `saved` is undefined when the host could not say.
      const answer = (saved?: boolean) => {
        if (!mounted || asked !== generation.current) return;
        setState((current) =>
          saved
            ? "ready"
            : current === "checking" || (saved === false && current === "ready")
              ? "idle"
              : current,
        );
      };
      savedDownloadStatus(source, name).then(answer, () => answer());
    };
    refresh();
    const stop = subscribeSavedDownloads(refresh);
    return () => {
      mounted = false;
      stop();
    };
  }, [source, name]);
  const run = async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    generation.current += 1;
    try {
      await action();
    } finally {
      busy.current = false;
    }
  };
  const save = async () => {
    setState("pending");
    setNotice(`Downloading ${displayName}`);
    try {
      await downloadNativeMedia(source, name);
      setState("ready");
      setNotice(`Saved ${displayName} to Downloads`);
    } catch {
      // A failed Download again leaves the earlier copy, and its menu.
      setState((await hasSavedCopy(source, name)) ? "failedAgain" : "failed");
      setNotice(`Couldn’t download ${displayName}. Try again.`);
    }
  };
  const show = async (reveal: boolean) => {
    try {
      if ((await openSavedDownload(source, name, reveal)) === "moved") {
        setState("moved");
        setNotice(`${displayName} was moved or changed. Download it again.`);
      } else {
        setState("ready");
        setNotice("");
      }
    } catch {
      setState("openFailed");
      setNotice(`Couldn’t open ${displayName}. Try again.`);
    }
  };
  const download = () => run(save);
  const open = (reveal: boolean) => run(() => show(reveal));
  /** A click before the first answer asks for itself, so it cannot download
   * a file that is already saved. */
  const choose = () =>
    run(async () => {
      setState("choosing");
      setNotice(`Checking for a saved copy of ${displayName}`);
      await ((await hasSavedCopy(source, name)) ? show(false) : save());
    });
  const saved = state === "ready" || state === "openFailed";
  const menu = saved || state === "failedAgain";
  const retry = state === "failed" || state === "failedAgain";
  const working = state === "pending" || state === "choosing";
  const alert = retry || state === "moved" || state === "openFailed";
  return (
    <ContextMenuRoot
      open={menuOpen}
      onOpenChange={setMenuOpen}
      disabled={!menu}
    >
      <ContextMenuTrigger
        render={
          <button
            ref={trigger}
            type="button"
            className={styles.fileAttachment}
            aria-label={`${retry ? "Retry download" : saved ? "Open" : "Download"} ${displayName}`}
            aria-disabled={working}
            aria-busy={working}
            title={displayName}
            onClick={() =>
              void (state === "checking"
                ? choose()
                : saved
                  ? open(false)
                  : download())
            }
          >
            {children(retry ? "failed" : state)}
          </button>
        }
        onContextMenu={() => setMenuAnchor(undefined)}
        onTouchStart={() => setMenuAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            menu &&
            (event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            setMenuAnchor(trigger.current ?? undefined);
            setMenuOpen(true);
          }
        }}
      />
      {/* Not shown, so not copied by a selection that runs past the card. */}
      <span
        className="sr-only"
        role={alert ? "alert" : "status"}
        data-copy-skip
      >
        {notice}
      </span>
      <MenuPopup size="compact" anchor={menuAnchor} finalFocus={trigger}>
        <MenuItem onClick={() => void open(false)}>
          <MenuIcon>
            <ArrowUpRightIcon size={16} />
          </MenuIcon>
          Open
        </MenuItem>
        <MenuItem onClick={() => void open(true)}>
          <MenuIcon>
            <FolderOpenIcon size={16} />
          </MenuIcon>
          {isApplePlatform(navigator.platform)
            ? "Show in Finder"
            : "Show in folder"}
        </MenuItem>
        <MenuItem onClick={() => void download()}>
          <MenuIcon>
            <DownloadIcon size={16} />
          </MenuIcon>
          Download again
        </MenuItem>
      </MenuPopup>
    </ContextMenuRoot>
  );
}

function UnavailableFileAttachment({
  displayName,
  attachment,
}: {
  displayName: string;
  attachment: Attachment;
}) {
  return (
    <span className={styles.fileAttachment} role="status" title={displayName}>
      <span className={fileIconStyles.slot}>
        <FileTypeIcon name={attachment.name} mime={attachment.mime} />
      </span>
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta} data-copy-skip>
          File unavailable
        </span>
      </span>
    </span>
  );
}
