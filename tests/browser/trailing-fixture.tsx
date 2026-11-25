import type { ConversationWorkspaceProps } from "../../src/features/conversation/contracts";

// A card shaped like a plugin's decision card: a header, one line of its brief
// and controls fit the rest height; the rest of the brief grows into view.
const HEADER = 44;
const LINE = 24;
const FOOTER = 56;
export const trailingRestHeight = HEADER + LINE + FOOTER;

const paragraph =
  "The deploy window overlaps the database maintenance that starts at 02:00 UTC. Moving it earlier keeps the rollback path open, but it lands during the last hour of peak traffic in the western region. ";
/** `long` is the 8,000-character limit of a brief; a `short` card fits in
 * view; `none` has no brief. */
export function trailingBrief(size: "none" | "short" | "long") {
  if (size === "none") return "";
  if (size === "short") return `1. ${paragraph}\n\n2. ${paragraph}`;
  let text = "";
  for (let index = 1; text.length < 8000; index++)
    text += `${index}. ${paragraph}${index % 3 === 0 ? "\n\n" : ""}`;
  return text.slice(0, 8000);
}

export function trailingCard(
  brief: string,
  approve: () => void,
): NonNullable<ConversationWorkspaceProps["trailing"]> {
  return {
    restHeight: trailingRestHeight,
    content: ({ expanded, toggle }) => (
      <article
        aria-label="Fixture card"
        style={{
          // A ring, not a border: a sticky footer sits inside its box's border,
          // so a bottom border would show below it only at the end of the range.
          borderRadius: 12,
          // A plugin's own spacing above the card counts toward its height.
          marginTop: 12,
          background: "var(--surface-panel, Canvas)",
          boxShadow:
            "0 0 0 1px var(--border-standard, #8884), 0 -4px 16px #0002",
        }}
      >
        <header
          style={{
            height: HEADER,
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            fontWeight: 600,
          }}
        >
          Decision: pick the deploy window
        </header>
        <div
          data-fixture-brief=""
          style={{
            padding: "0 16px",
            lineHeight: `${LINE}px`,
            whiteSpace: "pre-wrap",
          }}
        >
          {brief}
        </div>
        <footer
          style={{
            position: "sticky",
            bottom: 0,
            height: FOOTER,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 16px",
            borderRadius: "0 0 12px 12px",
            background: "var(--surface-panel, Canvas)",
            borderTop: "1px solid var(--border-standard, #8884)",
          }}
        >
          <button type="button" aria-expanded={expanded} onClick={toggle}>
            {expanded ? "Hide brief" : "Full brief"}
          </button>
          <button type="button" onClick={approve}>
            Approve
          </button>
        </footer>
      </article>
    ),
  };
}
