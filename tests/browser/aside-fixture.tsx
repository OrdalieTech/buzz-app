import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from "../../src/shared/design-system/ui/Popover";

// A dashboard shaped like a plugin's Plan tile. It draws its own card, sizes
// to it in the box the host gives it, and scrolls its own content past the
// box's height; its Details popover escapes the box, over the history.
// `short` fits in a window, `tall` is taller than one.
const STEP =
  "Check the rollout dashboard, confirm error rates stay flat, then post the summary.";

export type AsideSize = "short" | "tall";

export function AsideWidget({ size }: { size: AsideSize }) {
  const steps = size === "tall" ? 28 : 2;
  return (
    <section
      aria-label="Fixture dashboard"
      data-fixture-aside-scroll=""
      style={{
        overflowY: "auto",
        margin: 8,
        padding: 16,
        boxSizing: "border-box",
        border: "1px solid var(--border-standard)",
        borderRadius: "var(--radius-card)",
        background: "var(--surface-base)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <h3 style={{ margin: "0 0 8px" }}>
        Plan · {steps} steps{" "}
        <PopoverRoot>
          <PopoverTrigger>Details</PopoverTrigger>
          <PopoverPopup side="left">
            Step details escape the Plan, over the history.
          </PopoverPopup>
        </PopoverRoot>
      </h3>
      <ol style={{ margin: 0, paddingInlineStart: 20, lineHeight: "20px" }}>
        {Array.from({ length: steps }, (_, index) => index + 1).map((step) => (
          <li key={step} style={{ marginBottom: 12 }}>
            <strong>Step {step}.</strong> {STEP}
          </li>
        ))}
      </ol>
      <p style={{ margin: 0, fontWeight: 600 }}>End of plan</p>
    </section>
  );
}
