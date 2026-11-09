import type {
  ChannelMessage,
  MembershipChange,
  Profile,
} from "../relay/contracts";

export type TimelineRow = ChannelMessage & {
  membershipRows?: readonly ChannelMessage[];
};
/** A Solo chat implies the agents its owner started it with; omit the owner's
 * agent additions and removals before the first message once history reaches
 * the chat's start. Later changes, people and agents added by someone else
 * still show. */
export function withoutStartingAgents(
  rows: readonly ChannelMessage[],
  owner: string | undefined,
  agents: ReadonlySet<string>,
  complete: boolean,
): readonly ChannelMessage[] {
  if (!complete || !owner) return rows;
  const first = rows.findIndex((row) => !row.membership);
  const start = first === -1 ? rows.length : first;
  const starting = (row: ChannelMessage) =>
    (row.membership?.type === "member_joined" ||
      row.membership?.type === "member_removed") &&
    row.membership.actor === owner &&
    agents.has(row.membership.target);
  return rows.some((row, index) => index < start && starting(row))
    ? rows.filter((row, index) => index >= start || !starting(row))
    : rows;
}

/** Only explicit additions and removals belong in the conversation. */
const visibleMembership = (change: MembershipChange) =>
  change.type === "member_removed" ||
  (change.type === "member_joined" && change.actor !== change.target);

/** Newest-anchored groups keep loaded keys stable when history is prepended.
 * Every uninterrupted membership run is one row, regardless of elapsed time.
 * A conversation entry (including a huddle) always breaks the group. */
export function membershipRows(
  rows: readonly ChannelMessage[],
): readonly TimelineRow[] {
  rows = rows.filter(
    ({ membership }) => !membership || visibleMembership(membership),
  );
  const result: TimelineRow[] = [];
  for (let end = rows.length - 1; end >= 0; ) {
    const newest = rows[end];
    if (!newest) break;
    let start = end;
    while (newest.membership && start > 0 && rows[start - 1]?.membership)
      start--;
    result.push(
      start === end
        ? newest
        : {
            ...newest,
            createdAt: rows[start]?.createdAt ?? newest.createdAt,
            membershipRows: rows.slice(start, end + 1),
          },
    );
    end = start - 1;
  }
  return result.reverse();
}

/** The index of the row that renders an event. A hidden membership event, such
 * as a reading anchor saved before self-joins were hidden, resolves to the
 * nearest later rendered event, else the nearest earlier one. */
export function renderedRowIndex(
  rows: readonly TimelineRow[],
  events: readonly ChannelMessage[],
  id: string,
) {
  const find = (target: string) =>
    rows.findIndex(
      (row) =>
        row.id === target ||
        row.membershipRows?.some((member) => member.id === target),
    );
  const direct = find(id);
  const at = direct < 0 ? events.findIndex((event) => event.id === id) : -1;
  if (at < 0) return direct;
  for (let index = at + 1; index < events.length; index++) {
    const found = find(events[index]?.id ?? "");
    if (found >= 0) return found;
  }
  for (let index = at - 1; index >= 0; index--) {
    const found = find(events[index]?.id ?? "");
    if (found >= 0) return found;
  }
  return -1;
}

/** A prose segment; `id` marks a member name that may open that profile. */
export type MembershipPart = {
  text: string;
  id?: string;
  preview?: { label: string; members: readonly { id: string; name: string }[] };
};

export function membershipDescription(
  rows: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
  viewer?: string,
  resolveName?: (id: string, fallback: string) => string,
) {
  const latest = new Map<string, MembershipChange>();
  for (const row of rows)
    if (row.membership && visibleMembership(row.membership))
      latest.set(row.membership.target, row.membership);
  const changes = [...latest.values()];
  const first = changes[0];
  if (!first) return { targets: [], parts: [], text: "", title: "" };
  const targets = [...latest.keys()];
  const name = (id: string, subject = false): MembershipPart => ({
    id,
    text:
      id === viewer
        ? subject
          ? "You"
          : "you"
        : (resolveName?.(id, profiles.get(id)?.name ?? id.slice(0, 10)) ??
          profiles.get(id)?.name ??
          id.slice(0, 10)),
  });
  const plain = (text: string): MembershipPart => ({ text });
  const list = (items: readonly MembershipPart[]) => {
    let next = 0;
    return new Intl.ListFormat(undefined, { type: "conjunction" })
      .formatToParts(items.map((item) => item.text))
      .map((part) =>
        part.type === "element"
          ? (items[next++] ?? plain(part.value))
          : plain(part.value),
      );
  };
  // Each person appears only under their latest visible action.
  const kinds = new Set(changes.map((change) => change.type));
  if (
    targets.length > 3 ||
    kinds.size > 1 ||
    (first.type === "member_removed" &&
      changes.some((change) => change.actor !== first.actor))
  ) {
    const parts: MembershipPart[] = [];
    for (const [type, label] of [
      ["member_joined", "added"],
      ["member_removed", "removed"],
    ] as const) {
      const people = [
        ...new Set(
          changes
            .filter((change) => change.type === type)
            .map((change) => change.target),
        ),
      ];
      const person = people[0];
      if (!person) continue;
      if (parts.length) parts.push(plain(" · "));
      parts.push(name(person, true));
      if (people.length > 1) {
        parts.push(plain(" and "), {
          text: `${people.length - 1} ${people.length === 2 ? "other" : "others"}`,
          preview: {
            label: `People who were ${label}`,
            members: people.map((id) => ({ id, name: name(id, true).text })),
          },
        });
      }
      parts.push(
        plain(
          ` ${people.length > 1 || person === viewer ? "were" : "was"} ${label}`,
        ),
      );
    }
    const text = parts.map((part) => part.text).join("");
    const detail = changes.map((change) => {
      const subject = name(change.target, true).text;
      const action = change.type === "member_removed" ? "removed" : "added";
      return `${subject} ${change.target === viewer ? "were" : "was"} ${action} by ${name(change.actor).text}`;
    });
    return {
      targets,
      parts,
      text,
      title: [...new Set(detail)].join("; "),
    };
  }
  const lead = name(first.target, true);
  const others = targets.slice(1, 3);
  const rest = list(others.map((id) => name(id)));
  const alongWith = (separator = "") =>
    rest.length ? [plain(`${separator} along with `), ...rest] : [];
  let parts: MembershipPart[];
  if (first.type === "member_removed") {
    parts = [
      lead,
      plain(` ${first.target === viewer ? "were" : "was"} removed by `),
      name(first.actor),
      ...alongWith(","),
    ];
  } else {
    const sameAdder = changes.every(({ actor }) => actor === first.actor);
    const action = sameAdder
      ? [
          plain(` ${first.target === viewer ? "were added" : "added"} by `),
          name(first.actor),
        ]
      : [plain(` ${first.target === viewer ? "were" : "was"} added`)];
    parts = [lead, ...action, ...alongWith(sameAdder ? "," : "")];
  }
  return {
    targets,
    parts,
    text: parts.map((part) => part.text).join(""),
    title: list(targets.map((id) => name(id)))
      .map((part) => part.text)
      .join(""),
  };
}
