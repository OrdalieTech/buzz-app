import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { visibleHtmlSource } from "./message-content";

/** Only a message's tags decide its audience. */
type Tagged = Readonly<{ tags: readonly (readonly string[])[] }>;

/** The message's signed `audience` tag names agents: coordination between
 * agents, which people see quietly and are not notified of. Any other value,
 * or none, is for everyone. */
export const agentAudience = (event: Tagged) =>
  event.tags.some(([name, value]) => name === "audience" && value === "agents");

/** The signed `audience` a message is shown with: `agents` is quiet
 * coordination between agents; `details` is fuller material for people, read
 * in its own viewer. Any other value, or none, is for everyone. */
export const messageAudience = (
  event: Tagged,
): "agents" | "details" | undefined =>
  agentAudience(event)
    ? "agents"
    : event.tags.some(
          ([name, value]) => name === "audience" && value === "details",
        )
      ? "details"
      : undefined;

/** Whether the chat renders a top-level block where it stands. Link and
 * footnote definitions render nothing there, and raw HTML shows only its
 * source outside complete comments. */
const rendersInPlace = (block: RootContent) =>
  block.type !== "definition" &&
  block.type !== "footnoteDefinition" &&
  (block.type !== "html" || visibleHtmlSource(block.value).trim() !== "");

/** What the chat shows of a details message before it opens: its first
 * block, after a leading heading when an older message has one. Blocks are
 * Markdown's, parsed with GFM as the chat renders them, so a heading, list or
 * fence that starts without a blank line still ends the brief, and blocks the
 * chat doesn't render there, such as comments and definitions, are skipped. */
export function detailsBrief(content: string) {
  const blocks = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }).children.filter(rendersInPlace);
  const shown = blocks.slice(0, blocks[0]?.type === "heading" ? 2 : 1);
  return shown
    .map((block) => {
      const source = content.slice(
        block.position?.start.offset ?? 0,
        block.position?.end.offset ?? content.length,
      );
      return block.type === "html" ? visibleHtmlSource(source).trim() : source;
    })
    .join("\n\n");
}
