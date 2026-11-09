import styles from "./TypingDots.module.css";

/** Shared activity motion. Callers own receipt/work evidence and accessible labels. */
export function TypingDots({
  state = "working",
  size = "default",
}: {
  state?: "waiting" | "working";
  size?: "default" | "small" | "message";
}) {
  return (
    <span
      className={styles.dots}
      data-state={state}
      data-size={size}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </span>
  );
}
