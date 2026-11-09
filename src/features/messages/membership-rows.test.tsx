// @vitest-environment jsdom
import { assert, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { profileTarget } from "../profiles/target";
import type { ChannelMessage, MembershipChange } from "../relay/contracts";
import {
  membershipRows,
  membershipDescription,
  renderedRowIndex,
  withoutStartingAgents,
} from "./membership-rows";
import { MembershipRow } from "./MembershipRow";
import { geometrySignature } from "./geometry";
const wes = "a".repeat(64),
  pinky = "b".repeat(64),
  brain = "c".repeat(64);
const profiles = new Map([
  [wes, { name: "Wes" }],
  [pinky, { name: "Pinky" }],
  [brain, { name: "Brain" }],
]);
function row(
  id: string,
  membership?: MembershipChange,
  createdAt = 100,
): ChannelMessage {
  return {
    id,
    channelId: "a",
    authorId: "relay",
    content: "",
    createdAt,
    ...(membership ? { membership } : {}),
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
  };
}
const joined = (actor: string, target: string): MembershipChange => ({
  type: "member_joined",
  actor,
  target,
});
const left = (target: string): MembershipChange => ({
  type: "member_left",
  actor: target,
  target,
});
const removed = (actor: string, target: string): MembershipChange => ({
  type: "member_removed",
  actor,
  target,
});
it("matches the grouped invitation wording and keeps pronouns grammatical", () => {
  expect(
    membershipDescription(
      [row("1", joined(wes, pinky)), row("2", joined(wes, brain))],
      profiles,
      wes,
    ).text,
  ).toBe("Pinky added by you, along with Brain");
  expect(
    membershipDescription([row("1", joined(pinky, wes))], profiles, wes).text,
  ).toBe("You were added by Pinky");
  // Every member name, and only a member name, is tagged with its identity.
  expect(
    membershipDescription(
      [row("1", joined(wes, pinky)), row("2", joined(wes, brain))],
      profiles,
      wes,
    ).parts,
  ).toEqual([
    { id: pinky, text: "Pinky" },
    { text: " added by " },
    { id: wes, text: "you" },
    { text: ", along with " },
    { id: brain, text: "Brain" },
  ]);
  expect(
    membershipDescription([row("1", removed(pinky, wes))], profiles, wes).text,
  ).toBe("You were removed by Pinky");
});
it("groups removals without attributing a removal to the wrong actor", () => {
  const rows = [row("3", removed(wes, pinky)), row("4", removed(brain, wes))];
  expect(membershipRows(rows).map((r) => r.id)).toEqual(["4"]);
  const summary = membershipDescription(rows, profiles);
  expect(summary.text).toBe("Pinky and 1 other were removed");
  expect(summary.title).toContain("Pinky was removed by Wes");
  expect(summary.title).toContain("Wes was removed by Brain");
});
it("only conversation entries break membership groups; long gaps and midnight keep stable keys", () => {
  const a = row("a", joined(wes, pinky), 200),
    b = row("b", joined(wes, brain), 210);
  expect(membershipRows([a, b]).map((r) => r.id)).toEqual(["b"]);
  const old = row("old", joined(pinky, pinky), 100);
  expect(membershipRows([old, a, b]).map((r) => r.id)).toEqual(["b"]);
  expect(membershipRows([a, row("chat"), b])).toHaveLength(3);
  expect(
    membershipRows([a, { ...b, createdAt: a.createdAt + 3601 }]),
  ).toHaveLength(1);
  expect(
    membershipRows([a, { ...b, createdAt: a.createdAt + 3600 }]),
  ).toHaveLength(1);
  const midnight = new Date(2026, 8, 12).getTime() / 1000;
  expect(
    membershipRows([
      { ...a, createdAt: midnight - 1 },
      { ...b, createdAt: midnight },
    ]),
  ).toHaveLength(1);
});
it("hides self-joins and voluntary leaves before grouping, preserving messages and visible keys", () => {
  const hidden = [row("join", joined(pinky, pinky)), row("leave", left(pinky))];
  expect(membershipRows(hidden)).toEqual([]);
  expect(membershipDescription(hidden, profiles).text).toBe("");
  const addition = row("added", joined(wes, pinky));
  const removal = row("removed", removed(wes, brain));
  const message = row("message");
  expect(membershipRows([addition, ...hidden])).toEqual([addition]);
  expect(
    membershipRows([addition, ...hidden, removal])[0]?.membershipRows,
  ).toEqual([addition, removal]);
  expect(membershipRows([addition, ...hidden, message, removal])).toEqual([
    addition,
    message,
    removal,
  ]);
});
it("resolves a saved anchor on a hidden membership event to the nearest rendered row", () => {
  const first = row("first");
  const join = row("join", joined(pinky, pinky));
  const addition = row("added", joined(wes, pinky));
  const leave = row("leave", left(brain));
  const removal = row("removed", removed(wes, brain));
  const events = [first, join, addition, leave, removal];
  const rows = membershipRows(events);
  expect(rows.map(({ id }) => id)).toEqual(["first", "removed"]);
  expect(renderedRowIndex(rows, events, "first")).toBe(0);
  // A grouped member resolves to its group; a hidden event to the next one.
  expect(renderedRowIndex(rows, events, "added")).toBe(1);
  expect(renderedRowIndex(rows, events, "join")).toBe(1);
  // With nothing rendered after it, a hidden event resolves to the one before.
  const tail = [first, join];
  expect(renderedRowIndex(membershipRows(tail), tail, "join")).toBe(0);
  // An event that is not loaded still waits for its page.
  expect(renderedRowIndex(rows, events, "missing")).toBe(-1);
  expect(renderedRowIndex([], [join], "join")).toBe(-1);
});

it("collapses high-volume mixed activity and deduplicates repeat arrivals without swallowing messages", () => {
  const arrivals = Array.from({ length: 148 }, (_, index) => {
    const id = `member-${index}`;
    return row(String(index), joined("adder", id));
  });
  const activity = [
    ...arrivals.slice(0, 25),
    row("remove", removed(wes, pinky)),
    ...arrivals.slice(25),
    ...arrivals,
  ];
  const grouped = membershipRows([...activity, row("message")]);
  expect(grouped).toHaveLength(2);
  expect(grouped[0]?.membershipRows).toEqual(activity);
  const summary = membershipDescription(
    grouped[0]?.membershipRows ?? [],
    profiles,
  );
  expect(summary.text).toBe(
    "member-0 and 147 others were added · Pinky was removed",
  );
  const preview = summary.parts.find((part) => part.preview)?.preview;
  expect(preview?.members).toHaveLength(148);
  expect(preview?.members[0]).toEqual({ id: "member-0", name: "member-0" });
  expect(preview?.members.at(-1)).toEqual({
    id: "member-147",
    name: "member-147",
  });
  expect(summary.title).toContain("Pinky was removed by Wes");
  expect(summary.title.match(/member-0 was added by adder/g)).toHaveLength(1);
  expect(grouped[1]?.id).toBe("message");
});
it("describes each person by their latest visible change in the run", () => {
  const changes = [
    row("added", joined(wes, pinky)),
    row("removed", removed(brain, pinky)),
    row("added-back", joined(brain, pinky)),
  ];
  const group = membershipRows(changes)[0];
  expect(group?.membershipRows).toEqual(changes);
  expect(membershipDescription(changes, profiles).text).toBe(
    "Pinky added by Brain",
  );
  expect(membershipDescription(changes.slice(0, 2), profiles).text).toBe(
    "Pinky was removed by Brain",
  );
  const mixed = membershipDescription(
    [...changes, row("other-removal", removed(wes, brain))],
    profiles,
  );
  expect(mixed.text).toBe("Pinky was added · Brain was removed");
  expect(mixed.title).toBe(
    "Pinky was added by Brain; Brain was removed by Wes",
  );
  expect(mixed.targets).toEqual([pinky, brain]);
});
it("every grouped input remains represented for mixed three-event sequences", () => {
  const changes = [
    joined(wes, pinky),
    joined(brain, pinky),
    removed(wes, pinky),
    removed(brain, pinky),
  ];
  for (const a of changes)
    for (const b of changes)
      for (const c of changes) {
        const rows = [row("a", a), row("b", b), row("c", c)];
        const groups = membershipRows(rows);
        expect(groups.flatMap((r) => r.membershipRows ?? [r])).toEqual(rows);
        for (const group of groups) {
          const description = membershipDescription(
            group.membershipRows ?? [group],
            profiles,
          );
          expect(description.text).not.toBe("");
          expect(description.targets).toEqual([
            ...new Set(
              (group.membershipRows ?? [group]).map(
                (r) => r.membership?.target,
              ),
            ),
          ]);
        }
      }
});
it("keeps one visible name and a labelled overflow control with capped decorative avatars", () => {
  const rows = [pinky, brain, wes, "d".repeat(64)].map((id, i) =>
    row(String(i), joined("adder", id)),
  );
  const group = membershipRows(rows)[0];
  assert.exists(group);
  const view = render(
    <MembershipRow
      row={group}
      profiles={profiles}
      media={() => undefined}
      viewer={wes}
      day={false}
    />,
  );
  expect(view.container.querySelector("p")).toHaveTextContent(
    "Pinky and 3 others were added",
  );
  expect(screen.getByRole("button", { name: "3 others" })).toHaveAttribute(
    "aria-haspopup",
    "dialog",
  );
  expect(
    view.container.querySelector('[aria-hidden="true"]'),
  ).toHaveTextContent("+1");
  expect(view.container.querySelector("p")).toHaveAttribute(
    "title",
    "Pinky was added by adder; Brain was added by adder; You were added by adder; dddddddddd was added by adder",
  );
  view.unmount();
});
it.each([false, true])(
  "keeps small membership media requests with agent hint %s",
  (agent) => {
    const picture = "https://image.test/member.png";
    const media = vi.fn((url: string) => url);
    const html = renderToStaticMarkup(
      <MembershipRow
        row={row("join", joined(wes, pinky))}
        profiles={new Map([[pinky, { name: "Pinky", picture }]])}
        agentPubkeys={new Set(agent ? [pinky] : [])}
        media={media}
        day={false}
      />,
    );
    expect(media).toHaveBeenCalledWith(picture, "small");
    expect(html).toContain(
      `data-avatar-shape="${agent ? "squircle" : "circle"}"`,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("button");
  },
);
it("actor/subject profile enrichment invalidates cached system-row geometry", () => {
  const rows = [row("a", joined(wes, pinky))];
  const original = geometrySignature(rows, profiles);
  expect(
    geometrySignature(
      rows,
      new Map([...profiles, [pinky, { name: "Longer Pinky" }]]),
    ),
  ).not.toBe(original);
  expect(
    geometrySignature(
      rows,
      new Map([...profiles, [wes, { name: "Longer Wes" }]]),
    ),
  ).not.toBe(original);
});
it("member names open the subject's and the actor's profiles when the host can", () => {
  const open = vi.fn(() => true);
  const group = membershipRows([
    row("1", joined(wes, pinky)),
    row("2", joined(wes, brain)),
  ])[0];
  assert.exists(group);
  const mount = (canOpenLink: (target: string) => boolean) =>
    render(
      <MembershipRow
        row={group}
        profiles={profiles}
        agentPubkeys={new Set([brain])}
        media={() => undefined}
        viewer={wes}
        day={false}
        onOpenLink={open}
        canOpenLink={canOpenLink}
      />,
    );
  mount(() => true);
  const paragraph = screen.getByTitle("Pinky and Brain");
  expect(paragraph.textContent).toBe("Pinky added by you, along with Brain");
  const subject = screen.getByRole("button", { name: "View Pinky profile" });
  fireEvent.click(subject);
  expect(open).toHaveBeenLastCalledWith(profileTarget(pinky));
  // jsdom clicks never focus, so this proves the explicit focus that keeps a
  // return target for the profile tab under WebKit.
  expect(subject).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "View your profile" }));
  expect(open).toHaveBeenLastCalledWith(profileTarget(wes));
  const agent = screen.getByRole("button", { name: "View Brain profile" });
  // System notices name people as quiet text, never as mention chips.
  expect(agent).not.toHaveAttribute("data-mention-kind");
  fireEvent.click(agent);
  expect(open).toHaveBeenLastCalledWith(profileTarget(brain, { agent: true }));
  expect(screen.getAllByRole("button")).toHaveLength(3);
  cleanup();
  // A host that cannot open a profile keeps that name as plain prose.
  mount((target) => target === profileTarget(pinky));
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Pinky",
  ]);
  expect(screen.getByTitle("Pinky and Brain").textContent).toBe(
    "Pinky added by you, along with Brain",
  );
  cleanup();
  render(
    <MembershipRow
      row={row("1", removed(pinky, brain))}
      profiles={profiles}
      media={() => undefined}
      viewer={wes}
      day={false}
      onOpenLink={open}
      canOpenLink={() => true}
    />,
  );
  expect(screen.getByTitle("Brain").textContent).toBe(
    "Brain was removed by Pinky",
  );
  fireEvent.click(screen.getByRole("button", { name: "View Pinky profile" }));
  expect(open).toHaveBeenLastCalledWith(profileTarget(pinky));
  // Without agent evidence, Brain opens as a person.
  fireEvent.click(screen.getByRole("button", { name: "View Brain profile" }));
  expect(open).toHaveBeenLastCalledWith(profileTarget(brain));
  expect(document.querySelector("[data-profile-target]")).toBeNull();
});

it("omits only the owner's starting agents once history reaches the start", () => {
  const added = (id: string, actor: string, target: string) =>
    row(id, { type: "member_joined", actor, target });
  const message = { ...row("message"), authorId: wes, content: "Hi" };
  const agents = new Set([pinky, brain]);
  const rows = [
    added("starting", wes, pinky),
    added("person", wes, "d".repeat(64)),
    added("by-agent", pinky, brain),
    message,
    added("later", wes, brain),
  ];
  expect(
    withoutStartingAgents(rows, wes, agents, true).map((row) => row.id),
  ).toEqual(["person", "by-agent", "message", "later"]);
  // Partial history cannot prove a leading arrival started the chat.
  expect(withoutStartingAgents(rows, wes, agents, false)).toBe(rows);
  expect(withoutStartingAgents(rows, undefined, agents, true)).toBe(rows);
  // A chat with no messages yet still started with its agents.
  expect(
    withoutStartingAgents([added("only", wes, pinky)], wes, agents, true),
  ).toEqual([]);
  // Setup churn hides as a whole, so no removal outlives its hidden addition.
  expect(
    withoutStartingAgents(
      [
        added("first", wes, pinky),
        row("removed", removed(wes, pinky)),
        row("left", left(brain)),
        added("again", wes, pinky),
        message,
      ],
      wes,
      agents,
      true,
    ).map((row) => row.id),
  ).toEqual(["left", "message"]);
});
