import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { resolveMatch, type Contribution } from "../../plugins/contributions";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import type {
  ContributionReader,
  LinkPreviewRenderer,
  LinkPreviewSettings,
  LinkPreviewStatus,
} from "../conversation/contracts";
import { useTargetOpener } from "../conversation/opener";
import { Button } from "../../shared/design-system/ui/Button";
import { combineStatuses, linkPreviewStatus } from "./link-preview-status";
import styles from "./LinkPreviews.module.css";

/** A message shows this many cards before the rest fold behind one button. */
export const FOLD_AFTER = 3;

const none: readonly Contribution<LinkPreviewRenderer>[] = [];
const noSubscribe = () => () => {};
const noSnapshot = () => none;
const noStatuses = combineStatuses([]);

/** One card, with the host's opener for targets other than its link. */
function LinkPreviewCard({
  url,
  messageId,
  registry,
  renderer,
  open,
}: {
  url: string;
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer>;
  renderer: Contribution<LinkPreviewRenderer>;
  open(): boolean;
}) {
  const opener = useTargetOpener(registry, renderer);
  const Preview = renderer.component;
  return (
    <Preview url={url} messageId={messageId} open={open} opener={opener} />
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Drawn by the host while a renderer reports `needs-setup`. It passes no
 * message content to the plugin and runs nothing; setup happens in Settings. */
function LinkPreviewSetup({
  url,
  title,
  onOpenSettings,
  onFocusedRemoval,
}: {
  url: string;
  title: string;
  onOpenSettings(): void;
  onFocusedRemoval(): void;
}) {
  const host = hostOf(url);
  const button = useRef<HTMLButtonElement>(null);
  const removed = useRef(onFocusedRemoval);
  removed.current = onFocusedRemoval;
  // Layout cleanup runs while the button is still attached, so it can tell
  // whether a status change is about to take keyboard focus with it.
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node && node.ownerDocument.activeElement === node) removed.current();
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      className={styles.setup}
      onClick={onOpenSettings}
      data-link-preview-setup
    >
      <span className={styles.setupTitle}>Set up {title} for previews</span>{" "}
      <span className={styles.setupDetail}>{host} · Open Settings</span>
    </button>
  );
}

function shownWithin(element: HTMLElement, root: HTMLElement): boolean {
  if (element.closest("[inert], [aria-hidden='true']")) return false;
  const view = root.ownerDocument.defaultView;
  if (!view) return false;
  const { visibility } = view.getComputedStyle(element);
  if (visibility === "hidden" || visibility === "collapse") return false;
  for (
    let node: HTMLElement | null = element;
    node && node !== root;
    node = node.parentElement
  ) {
    if (node.hidden || view.getComputedStyle(node).display === "none")
      return false;
  }
  return true;
}

export function LinkPreviews({
  urls,
  messageId,
  registry,
  onOpenLink,
  settings,
}: {
  urls: readonly string[];
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer> | undefined;
  onOpenLink(url: string): boolean;
  /** Plugin Settings cards; without them, renderers that need setup draw no card. */
  settings?: LinkPreviewSettings | undefined;
}) {
  const renderers = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.snapshot ?? noSnapshot,
    registry?.snapshot ?? noSnapshot,
  );
  const [open, setOpen] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const matched = urls.flatMap((url) => {
    const renderer = resolveMatch(renderers, url);
    return renderer ? [{ url, renderer }] : [];
  });
  const distinct = [...new Set(matched.map(({ renderer }) => renderer))];
  const identity = distinct.map(contributionKey).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity names exactly the registrations in distinct.
  const statuses = useMemo(
    () =>
      registry
        ? combineStatuses(
            distinct.map((renderer) => linkPreviewStatus(registry, renderer)),
          )
        : noStatuses,
    [registry, identity],
  );
  const snapshot = useSyncExternalStore(
    statuses.subscribe,
    statuses.get,
    statuses.get,
  );
  const read = snapshot.split(",");
  const statusOf = new Map(
    distinct.map((renderer, index) => [
      renderer,
      (read[index] ?? "checking") as LinkPreviewStatus,
    ]),
  );
  const sections = distinct.map((renderer) =>
    renderer.settings ? `${renderer.pluginId}/${renderer.settings}` : "",
  );
  const readSettings = () =>
    sections
      .map((section) => (section && settings?.has(section) ? "1" : "0"))
      .join("");
  const available = useSyncExternalStore(
    settings?.subscribe ?? noSubscribe,
    readSettings,
    readSettings,
  );
  const sectionOf = new Map(
    distinct.flatMap((renderer, index) => {
      const section = sections[index];
      return section && available[index] === "1" ? [[renderer, section]] : [];
    }),
  );
  const cards = matched.flatMap(({ url, renderer }) => {
    const status = statusOf.get(renderer) ?? "checking";
    if (status === "checking") return [];
    if (status === "needs-setup" && !sectionOf.has(renderer)) return [];
    return [{ url, renderer, status }];
  });
  const container = useRef<HTMLDivElement>(null);
  const focusLost = useRef(false);
  useLayoutEffect(() => {
    if (!focusLost.current) return;
    focusLost.current = false;
    const root = container.current;
    if (!root) return;
    const active = root.ownerDocument.activeElement;
    if (active && active !== root.ownerDocument.body) return;
    const candidates = [
      ...root.querySelectorAll<HTMLElement>("[data-link-preview-setup]"),
      ...root.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ];
    for (const candidate of candidates) {
      if (!shownWithin(candidate, root)) continue;
      candidate.focus({ preventScroll: true });
      if (root.ownerDocument.activeElement === candidate) return;
    }
    root.focus({ preventScroll: true });
  });
  if (!registry || !matched.length) return null;
  const shown = open ? cards : cards.slice(0, FOLD_AFTER);
  const hidden = cards.length - shown.length;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group, not a form fieldset, is where focus lands when a setup card goes away.
    <div
      ref={container}
      className={styles.previews}
      role="group"
      aria-label="Link previews"
      tabIndex={-1}
      data-link-previews={cards.length ? "" : undefined}
    >
      {shown.map(({ url, renderer, status }) => {
        const key = contributionKey(renderer);
        const section = sectionOf.get(renderer);
        if (status === "needs-setup" && settings && section) {
          return (
            <LinkPreviewSetup
              key={`setup:${key}:${url}`}
              url={url}
              title={renderer.title}
              onFocusedRemoval={() => {
                focusLost.current = true;
              }}
              onOpenSettings={() => {
                if (
                  registry.snapshot().includes(renderer) &&
                  settings.has(section)
                )
                  settings.open(section);
              }}
            />
          );
        }
        return (
          <ContributionBoundary
            key={`${key}:${url}`}
            fallback={null}
            resetIdentity={key}
          >
            <LinkPreviewCard
              url={url}
              messageId={messageId}
              registry={registry}
              renderer={renderer}
              open={() =>
                live.current && registry.snapshot().includes(renderer)
                  ? onOpenLink(url)
                  : false
              }
            />
          </ContributionBoundary>
        );
      })}
      {(hidden > 0 || (open && cards.length > FOLD_AFTER)) && (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? "Show fewer previews"
            : `Show ${hidden} more ${hidden === 1 ? "preview" : "previews"}`}
        </Button>
      )}
    </div>
  );
}
