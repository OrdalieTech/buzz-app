import { diffLines } from "diff";
import { useMemo, type ReactNode } from "react";
import styles from "./ChannelTemplates.module.css";

/** Comparisons beyond these bounds show full content instead of a diff. */
export const CANVAS_DIFF_LINES = 5000;
export const CANVAS_DIFF_EDIT_LENGTH = 2000;
export const CANVAS_DIFF_TIMEOUT_MS = 200;
const CONTEXT = 3;

type Row = { key: number } & (
  | { kind: "added" | "removed" | "same"; text: string }
  | { kind: "skip"; count: number }
);

type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

const lines = (value: string) => {
  const split = value.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
};

/** Line rows from the current Canvas to a revision, as old Buzz showed them:
 * added lines are the revision's, removed lines are current lines it drops, unchanged runs collapsed to context, or
 * undefined when the comparison exceeds its bounds. */
export function canvasDiffRows(current: string, revision: string) {
  if (
    lines(current).length > CANVAS_DIFF_LINES ||
    lines(revision).length > CANVAS_DIFF_LINES
  )
    return undefined;
  const changes = diffLines(current, revision, {
    maxEditLength: CANVAS_DIFF_EDIT_LENGTH,
    timeout: CANVAS_DIFF_TIMEOUT_MS,
  });
  if (!changes) return undefined;
  const rows: Row[] = [];
  const push = (row: DistributiveOmit<Row, "key">) =>
    rows.push({ ...row, key: rows.length } as Row);
  changes.forEach((change, index) => {
    const text = lines(change.value);
    if (change.added || change.removed) {
      const kind = change.added ? "added" : "removed";
      for (const line of text) push({ kind, text: line });
      return;
    }
    const head = index === 0 ? 0 : CONTEXT;
    const tail = index === changes.length - 1 ? 0 : CONTEXT;
    if (text.length <= head + tail + 1) {
      for (const line of text) push({ kind: "same", text: line });
      return;
    }
    for (const line of text.slice(0, head)) push({ kind: "same", text: line });
    push({ kind: "skip", count: text.length - head - tail });
    for (const line of text.slice(text.length - tail))
      push({ kind: "same", text: line });
  });
  return rows;
}

const marks = { added: "+", removed: "−", same: " " } as const;
const names = { added: "Added", removed: "Removed", same: "Unchanged" };

export function CanvasDiff({
  current,
  revision,
  fallback,
}: {
  current: string;
  revision: string;
  fallback(note: string): ReactNode;
}) {
  const rows = useMemo(
    () => canvasDiffRows(current, revision),
    [current, revision],
  );
  if (!rows) return fallback("Comparison too large; showing full content.");
  return (
    <section
      aria-label="Changes from current version"
      className={styles.diff}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll owner must support keyboard panning.
      tabIndex={0}
    >
      {rows.map((row) =>
        row.kind === "skip" ? (
          <div key={row.key} className={styles.diffSkip}>
            {`⋯ ${row.count} unchanged ${row.count === 1 ? "line" : "lines"}`}
          </div>
        ) : (
          <div key={row.key} className={styles.diffLine} data-change={row.kind}>
            <span aria-hidden="true" className={styles.diffMark}>
              {marks[row.kind]}
            </span>
            <span className="sr-only">{`${names[row.kind]}: `}</span>
            {row.text || " "}
          </div>
        ),
      )}
    </section>
  );
}
