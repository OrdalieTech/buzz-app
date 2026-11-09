import type { ReactNode } from "react";
import { usePanelSplit } from "./usePanelSplit";
import { PanelDock } from "./PanelDock";
import styles from "./Panels.module.css";

/** The companion's split on every host; `.frame`/`.dock` CSS mirrors it. */
export const COMPANION_SPLIT = {
  name: "companion",
  defaultWidth: 420,
  min: 300,
} as const;

// Keep this frame mounted even while closed: changing ancestry resets page state.
export function PanelFrame({
  scope,
  companion,
  children,
}: {
  /** Community/viewer workspace whose saved companion width applies. */
  scope: string | undefined;
  companion?: ReactNode;
  children: ReactNode;
}) {
  const split = usePanelSplit(
    scope,
    COMPANION_SPLIT.name,
    COMPANION_SPLIT.defaultWidth,
    COMPANION_SPLIT.min,
  );
  return (
    <div
      ref={split.ref}
      style={split.style}
      className={`${styles.frame} ${styles.splitMotion}`}
    >
      <div className={styles.page}>{children}</div>
      <PanelDock
        open={!!companion}
        className={styles.dock}
        resizeHandle={split.handle}
      >
        {companion}
      </PanelDock>
    </div>
  );
}
