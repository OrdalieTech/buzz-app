import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  clearView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { ResizeHandle } from "./ResizeHandle";
import styles from "./Panels.module.css";

const DEFAULT_ROOT_FONT_SIZE = 16;
type PrimarySizing = { defaultWidth: number; maxRatio: number };

// The revision records which saved value an in-memory width replaced or
// became, so a failed save survives notifications about other keys.
function loadSplit(scope: string | undefined, key: string) {
  const revision = scope ? viewRevision(scope, key) : undefined;
  let saved: unknown;
  try {
    saved = JSON.parse(revision ?? "null");
  } catch {
    // An unreadable record falls back to the default width.
  }
  const preferred =
    typeof saved === "number" && Number.isFinite(saved) && saved > 0
      ? saved
      : undefined;
  return { scope, key, revision, preferred };
}

/**
 * Each page owns its split. The preferred width is saved per community and
 * viewer workspace (`scope`) under the page's `name`, so it survives the dock
 * closing, page switches and restarts; without a scope it stays in memory.
 */
export function usePanelSplit(
  scope: string | undefined,
  name: string,
  defaultWidth?: number,
  min = 316,
  primary?: PrimarySizing,
  mainMinRem?: number,
) {
  const ref = useRef<HTMLDivElement>(null);
  const key = `panel-split:${name}`;
  const [view, setView] = useState(() => loadSplit(scope, key));
  // A workspace change reads that workspace's width without remounting the page.
  if (view.scope !== scope || view.key !== key) setView(loadSplit(scope, key));
  const { preferred } = view;
  // Follow newer saves from another frame or window sharing this page's width.
  useLayoutEffect(() => {
    if (!scope) return;
    return subscribeView(
      scope,
      () => {
        const revision = viewRevision(scope, key);
        setView((current) =>
          revision === undefined ||
          (current.scope === scope &&
            current.key === key &&
            current.revision === revision)
            ? current
            : loadSplit(scope, key),
        );
      },
      key,
    );
  }, [scope, key]);
  const setPreferred = (width: number | undefined) => {
    if (scope && width !== undefined) writeView(scope, key, width);
    else if (scope)
      try {
        clearView(scope, key);
      } catch {
        // The default still applies until the page next mounts.
      }
    const revision = scope ? viewRevision(scope, key) : undefined;
    setView({ scope, key, preferred: width, revision });
  };
  return {
    ref,
    style: undefined,
    handle: (
      <PanelSplitHandle
        target={ref}
        preferred={preferred}
        setPreferred={setPreferred}
        defaultWidth={defaultWidth}
        min={min}
        primary={primary}
        mainMinRem={mainMinRem}
      />
    ),
  };
}

// Container reflow updates the grip and CSS width, not the page and its messages.
function PanelSplitHandle({
  target: ref,
  preferred,
  setPreferred,
  defaultWidth,
  min,
  primary,
  mainMinRem,
}: {
  target: RefObject<HTMLDivElement | null>;
  preferred: number | undefined;
  setPreferred(width: number | undefined): void;
  defaultWidth: number | undefined;
  min: number;
  primary: PrimarySizing | undefined;
  mainMinRem: number | undefined;
}) {
  const [available, setAvailable] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [rootFontSize, setRootFontSize] = useState(DEFAULT_ROOT_FONT_SIZE);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = element.ownerDocument.documentElement;
    const measure = () => {
      setAvailable(element.clientWidth);
      if (mainMinRem === undefined) return;
      // The borderless board fills the query container that supplies 100cqw.
      setContentWidth(element.getBoundingClientRect().width);
      const fontSize = getComputedStyle(root).fontSize;
      const pixels = fontSize.endsWith("px")
        ? Number.parseFloat(fontSize)
        : NaN;
      setRootFontSize(
        Number.isFinite(pixels) && pixels > 0 ? pixels : DEFAULT_ROOT_FONT_SIZE,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const appearanceObserver =
      mainMinRem === undefined ? undefined : new MutationObserver(measure);
    appearanceObserver?.observe(root, {
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      observer.disconnect();
      appearanceObserver?.disconnect();
    };
  }, [ref, mainMinRem]);
  const floor = Math.max(min, available * (1 - (primary?.maxRatio ?? 1)));
  const reserve = mainMinRem === undefined ? 320 : mainMinRem * rootFontSize;
  const reachable =
    (mainMinRem === undefined ? available : contentWidth) - reserve;
  const constrained =
    mainMinRem !== undefined && available > 0 && reachable < floor;
  const minimum = constrained ? Math.max(0, Math.round(reachable)) : floor;
  const max = constrained
    ? minimum
    : mainMinRem !== undefined && available > 0
      ? Math.floor(reachable)
      : Math.max(minimum, reachable);
  const clamp = (width: number) => Math.min(max, Math.max(minimum, width));
  const width = clamp(
    preferred ??
      defaultWidth ??
      (primary ? available - primary.defaultWidth : available / 2.1),
  );
  const automatic = preferred === undefined && primary === undefined;
  useLayoutEffect(() => {
    if (!available) return;
    const style = ref.current?.style;
    if (automatic) style?.removeProperty("--secondary-panel-width");
    else style?.setProperty("--secondary-panel-width", `${width}px`);
  }, [ref, available, width, automatic]);
  return (
    <ResizeHandle
      label="Resize main and secondary panels"
      direction={-1}
      target={ref}
      property="--secondary-panel-width"
      width={width}
      min={minimum}
      max={max}
      setWidth={(next) => setPreferred(clamp(next))}
      reset={() => setPreferred(undefined)}
      className={styles.resize}
    />
  );
}

/** Attach ref to the layout container and render handle beside the secondary pane. */
export type PanelSplit = ReturnType<typeof usePanelSplit>;

/** Plugin layouts never share persistence keys with built-in page layouts. */
export function usePluginPanelSplit(
  scope: string | undefined,
  name: string,
  defaultWidth?: number,
  min?: number,
  primary?: PrimarySizing,
) {
  return usePanelSplit(scope, `plugin:${name}`, defaultWidth, min, primary);
}
