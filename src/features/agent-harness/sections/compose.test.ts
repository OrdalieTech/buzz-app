import { describe, expect, it } from "vitest";
import { systemPrompt } from "../../../bundled/claude-code/prompt";
import { developerInstructions } from "../../../bundled/codex/prompt";
import { composeBase } from "./compose";
import { type Facts, locked, SECTIONS } from "./index";

const workspace = "/home/owner/.buzz/agents/example";
const folder = "/home/owner/code/project";
const agent = { name: "Example Agent", pubkey: "ab".repeat(32) };
const SCOPES = ["thread", "channel"] as const;
const FACTS: readonly Facts[] = SCOPES.flatMap((scope) => [
  { scope },
  { scope, ownFolder: workspace },
]);

const snapshot = (name: string) => `./snapshots/${name}.txt`;
const defaultText = (section: (typeof SECTIONS)[number], facts: Facts) =>
  (typeof section.text === "string"
    ? section.text
    : section.text(facts)
  ).trim();

// One file per composition, so a change of any default text shows as a diff
// of the whole prompt in review. Run Vitest with `-u` to update them.
describe("the session prompt of each harness", () => {
  for (const scope of SCOPES) {
    // Claude Code, Goose and Pi build theirs with `systemPrompt`.
    it(`for Claude Code, with ${scope} sessions`, async () => {
      const frame = {
        scope,
        agent,
        instructions: "Be terse.",
        repositories:
          "<community-repositories>\nRepositories: /home/owner/code\n</community-repositories>",
        team: "<team>\nCrew\n</team>",
        memory: "I am the example agent.",
      };
      await expect(
        systemPrompt({ ...frame, cwd: workspace }),
      ).toMatchFileSnapshot(snapshot(`claude.${scope}.default`));
      await expect(
        systemPrompt({ ...frame, cwd: folder, workspace }),
      ).toMatchFileSnapshot(snapshot(`claude.${scope}.own-folder`));
    });

    it(`for Codex, with ${scope} sessions`, async () => {
      // The thread for a message in a channel's thread.
      const place = scope === "thread" ? "thread" : "conversation";
      await expect(
        developerInstructions(agent, scope, undefined, place),
      ).toMatchFileSnapshot(snapshot(`codex.${scope}.default`));
      await expect(
        developerInstructions(agent, scope, workspace, place),
      ).toMatchFileSnapshot(snapshot(`codex.${scope}.own-folder`));
    });
  }
});

describe("composeBase", () => {
  it.each(FACTS)("prints each locked section once, in order (%o)", (facts) => {
    const { text } = composeBase(facts);
    let from = 0;
    for (const section of SECTIONS.filter(locked)) {
      const body = defaultText(section, facts);
      const printed = section.title ? `## ${section.title}\n\n${body}` : body;
      const at = text.indexOf(printed, from);
      expect(at, section.id).toBeGreaterThanOrEqual(from);
      expect(text.indexOf(printed, at + 1), section.id).toBe(-1);
      from = at + printed.length;
    }
  });

  it("prints every section under a heading of its own, after the opening lines", () => {
    for (const facts of FACTS) {
      const headings = composeBase(facts)
        .text.split("\n")
        .filter((line) => /^#+ /.test(line));
      expect(headings).toEqual(
        SECTIONS.flatMap(({ title }) => (title ? [`## ${title}`] : [])),
      );
    }
  });

  // Settings, plugins and saved sessions name a section by its id and title,
  // and who may replace it decides what a prompt can lose.
  it("keeps each section's id, its title and who can replace it", () => {
    expect(
      SECTIONS.map(({ id, title, owner, plugin }) =>
        [id, title, owner && "owner", plugin && "plugin"]
          .filter(Boolean)
          .join(" | "),
      ),
    ).toEqual([
      "intro",
      "turn-contract | Incoming Turn Contract",
      "trust | Trust",
      "tools | Buzz Tools",
      "mentions | Mentions",
      "callbacks | Callback Mentions | plugin",
      "threading | Threading",
      "routing | Routing | plugin",
      "publishing | Publishing | owner | plugin",
      "progress | Progress | owner | plugin",
      "waiting | Waiting",
      "etiquette | Etiquette | owner",
      "audience | Audience",
      "workspace-layout | Workspace Layout",
      "memory | Agent Memory | owner",
      "engineering | Engineering Discipline | owner",
      "repo-conventions | Working in the Repo",
      "commit-identity | Commit identity | owner",
      "working-location | Working location | plugin",
      "autonomy | Autonomy | owner | plugin",
      "session-model | Session Model",
      "product-help | Product help",
    ]);
  });

  it("gives the Session Model of the session's scope", () => {
    const model = (scope: "thread" | "channel") =>
      composeBase({ scope }).text.split("## Session Model")[1];
    expect(model("thread")).toContain("each thread gets its own independent");
    expect(model("channel")).toContain("You are one per-channel session");
  });

  it("describes the session itself when the harness says what it is", () => {
    const model = (facts: Facts) =>
      composeBase(facts).text.split("## Session Model")[1];
    expect(model({ scope: "thread", place: "thread" })).toContain(
      "This session is one thread",
    );
    expect(model({ scope: "thread", place: "conversation" })).toContain(
      "This session is one whole conversation: a DM, a personal chat, a huddle",
    );
    expect(model({ scope: "channel", place: "conversation" })).toContain(
      "You are one per-channel session",
    );
    for (const scope of ["thread", "channel"] as const)
      expect(model({ scope, place: "standalone" })).toContain(
        "This run joins no conversation",
      );
    // Sessions in other workspaces do not share files.
    for (const place of ["thread", "conversation", "standalone"] as const)
      expect(model({ scope: "thread", place })).toContain(
        "they share files on disk when they use the same workspace",
      );
  });

  it("names the workspace exactly as given", () => {
    // `$&` and `$1` mean something to a string replacement.
    const { text } = composeBase({
      scope: "thread",
      ownFolder: "/home/$&/$1/ws",
    });
    expect(text).toContain("Your persistent workspace is at `/home/$&/$1/ws`,");
    expect(text).not.toContain("{workspace}");
  });
});

// A section that is not locked can be off or replaced, so a reference to it,
// or to text "above" or "below", could point at nothing.
describe("the default texts", () => {
  const replaceable = SECTIONS.filter((section) => !locked(section)).flatMap(
    ({ title }) => (title ? [title] : []),
  );
  // What a message might say is not a reference.
  const unquoted = (text: string) => text.replace(/"[^"\n]*"/g, '""');

  it.each(SECTIONS.map((section) => [section.id, section] as const))(
    "of %s name no section that can be missing",
    (_, section) => {
      for (const facts of FACTS) {
        const text = unquoted(defaultText(section, facts));
        expect(text).not.toMatch(/\b(above|below)\b/i);
        for (const title of replaceable)
          expect(text, title).not.toMatch(new RegExp(`\\b${title}\\b`));
      }
    },
  );
});
