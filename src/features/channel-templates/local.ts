// The owner's channel templates on this device: a name, the agents and Agents
// teams a new channel starts with, and its starting Canvas. Creating a channel
// from one sends ordinary channel setup, so the session owns applying it.
import { useSyncExternalStore } from "react";
import { TEMPLATE_CANVAS_BYTES } from "./model";

export type ChannelTemplate = Readonly<{
  id: string;
  name: string;
  /** Agents team ids. A team deleted since is skipped. */
  teams: readonly string[];
  /** Agent pubkeys, added alongside the teams' members. */
  agents: readonly string[];
  canvas: string;
}>;
export type ChannelTemplateChange = Omit<ChannelTemplate, "id"> &
  Readonly<{ id?: string }>;
export const TEMPLATES_KEY = "buzz.channel-templates.v1";

function parse(raw: string | null): readonly ChannelTemplate[] {
  let stored: unknown;
  try {
    stored = JSON.parse(raw ?? "null");
  } catch {
    return [];
  }
  const templates =
    (stored as { version?: unknown } | null)?.version === 1
      ? (stored as { templates?: unknown }).templates
      : undefined;
  if (!Array.isArray(templates)) return [];
  return templates.flatMap((item: Partial<ChannelTemplate> | null) =>
    typeof item?.id === "string" &&
    typeof item.name === "string" &&
    typeof item.canvas === "string" &&
    Array.isArray(item.teams)
      ? [
          {
            id: item.id,
            name: item.name,
            teams: item.teams.filter((team) => typeof team === "string"),
            // Templates saved before agents could be chosen have none.
            agents: Array.isArray(item.agents)
              ? item.agents.filter((agent) => typeof agent === "string")
              : [],
            canvas: item.canvas,
          },
        ]
      : [],
  );
}

// Keyed by the stored text, so another window's write is read afresh.
let cached:
  | { raw: string | null; value: readonly ChannelTemplate[] }
  | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of [...listeners]) listener();
};

export const channelTemplates = {
  snapshot() {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (cached?.raw !== raw) cached = { raw, value: Object.freeze(parse(raw)) };
    return cached.value;
  },
  subscribe(listener: () => void) {
    const other = (event: StorageEvent) => {
      if (event.key === TEMPLATES_KEY) listener();
    };
    listeners.add(listener);
    window.addEventListener("storage", other);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", other);
    };
  },
  /** Creates a template, or replaces the one with `id`. */
  save({
    id,
    name,
    teams,
    agents,
    canvas,
  }: ChannelTemplateChange): ChannelTemplate {
    if (!name.trim()) throw new Error("Name the template");
    if (new TextEncoder().encode(canvas).length > TEMPLATE_CANVAS_BYTES)
      throw new Error(
        `Canvas is too large (${TEMPLATE_CANVAS_BYTES / 1024} KiB maximum)`,
      );
    const saved = channelTemplates.snapshot();
    if (id && !saved.some((item) => item.id === id))
      throw new Error("No such template");
    const template: ChannelTemplate = Object.freeze({
      id: id ?? crypto.randomUUID(),
      name: name.trim(),
      teams: Object.freeze([...new Set(teams)]),
      agents: Object.freeze([...new Set(agents)]),
      canvas: canvas.trim() ? canvas : "",
    });
    write(
      id
        ? saved.map((item) => (item.id === id ? template : item))
        : [...saved, template],
    );
    return template;
  },
  /** Points every template on team `from` at team `to` instead. */
  replaceTeam(from: string, to: string) {
    const saved = channelTemplates.snapshot();
    if (saved.some((item) => item.teams.includes(from)))
      write(
        saved.map((item) =>
          Object.freeze({
            ...item,
            teams: Object.freeze([
              ...new Set(item.teams.map((id) => (id === from ? to : id))),
            ]),
          }),
        ),
      );
  },
  remove(id: string) {
    write(channelTemplates.snapshot().filter((item) => item.id !== id));
  },
};

/** Saves the templates; listeners hear only once storage has taken them. */
function write(templates: readonly ChannelTemplate[]) {
  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify({ version: 1, templates }),
  );
  notify();
}

export function useChannelTemplates() {
  return useSyncExternalStore(
    channelTemplates.subscribe,
    channelTemplates.snapshot,
  );
}

/** The agents a template adds: its own agents and each member of its teams,
 * once, that is one of `agents` (the owner's agents in this community). */
export function templateAgents(
  template: ChannelTemplate,
  teams: readonly Readonly<{ id: string; members: readonly string[] }>[],
  agents: ReadonlySet<string>,
) {
  return [
    ...new Set([
      ...template.agents,
      ...template.teams.flatMap(
        (id) => teams.find((team) => team.id === id)?.members ?? [],
      ),
    ]),
  ].filter((pubkey) => agents.has(pubkey));
}
