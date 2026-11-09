// An agent's lookup of a pull request's state: what the owner's links and
// sidebar show, from the same store, with how old it is.
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { GitHubDetails } from "./data";
import {
  PULL_REFRESH_MS,
  type PullDetails,
  type PullStates,
} from "./pull-states";
import { parseGitHubReference } from "./references";

/** The panel's facts, such as files changed, as plain values under
 * snake_case keys. */
const factsOf = (facts: GitHubDetails["facts"]) =>
  Object.fromEntries(
    facts.map(([label, value]) => [
      label.toLowerCase().replaceAll(" ", "_"),
      typeof value !== "object"
        ? value
        : "additions" in value
          ? `+${value.additions} -${value.deletions}`
          : `${value.head.label} -> ${value.base.label}`,
    ]),
  );

/** What the panel shows beyond the state, for `details: true`. */
const detailsOf = ({ details, checklist, publicChecks }: PullDetails) => ({
  title: details.title,
  author: details.author,
  ...factsOf(details.facts),
  ...(checklist
    ? {
        review: {
          decision: checklist.review.decision,
          approved: checklist.review.approved,
          changes_requested: checklist.review.changes,
          waiting: checklist.review.waiting,
        },
        unresolved_threads: checklist.unresolved,
        ...(checklist.moreThreads ? { more_threads_unread: true } : {}),
        merge_state: checklist.merge,
        auto_merge: checklist.autoMerge ?? null,
        can_update_branch: checklist.canUpdateBranch,
      }
    : { checks: publicChecks?.state ?? "unknown" }),
});

export function addPullStateTool(
  agents: { addTool(tool: AddedTool): void },
  states: PullStates,
) {
  agents.addTool({
    name: "github_pr_state",
    description:
      "Reads a GitHub pull request's state as the owner's links show it: open, draft, merged or closed, its checks, failed check names and conflicts, and when it was read. With details true it also gives what the owner's GitHub panel shows: title, branches, files changed, the review decision and reviewers, unresolved review threads, the merge state and auto-merge. It is at most a minute old unless fresh is true, or the last read failed: then last_read_failed says why and age_seconds how old it is. Checks and conflicts need the gh CLI signed in; without it a lookup gives only the state, and with details true also the title and branches, and the head's public checks once the owner's panel has read them.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The pull request's https://github.com/… URL",
        },
        fresh: {
          type: "boolean",
          description: "Read it from GitHub now rather than within the minute",
        },
        details: {
          type: "boolean",
          description:
            "Also give what the panel shows: reviews, unresolved threads, merge state and branches",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      // The store reads issues' state too, for links; this is pull requests'.
      if (
        typeof args.url !== "string" ||
        parseGitHubReference(args.url)?.kind !== "pull"
      )
        throw new Error("url must be a GitHub pull request URL");
      const { state, readAt, error } = await states.read(args.url, {
        maxAge: args.fresh === true ? 0 : PULL_REFRESH_MS,
        ...(args.details === true ? { level: "details" as const } : {}),
      });
      if (state === "failed")
        throw new Error(
          `Could not read ${args.url}: ${error?.message ?? "GitHub did not answer"}`,
        );
      return JSON.stringify(
        {
          state: state.state,
          ...(state.head
            ? {
                checks: state.checks ?? "none",
                failed: state.failed,
                settled: state.settled,
                conflicts: state.conflicts,
                head: state.head,
              }
            : {}),
          ...(args.details === true && state.details
            ? { details: detailsOf(state.details) }
            : {}),
          read_at: new Date(readAt).toISOString(),
          age_seconds: Math.max(0, Math.round((Date.now() - readAt) / 1000)),
          source: state.head ? "gh" : "public",
          // The state above is the last one read; reading it again failed.
          ...(error ? { last_read_failed: error.message } : {}),
        },
        null,
        2,
      );
    },
  });
}
