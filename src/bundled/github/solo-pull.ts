// A Solo chat's pull request: one link per chat, kept as a NIP-AR artifact in
// the chat so every device and agent in it sees the same one, with its state
// from the app's shared pull request states while shown.
import {
  ARTIFACT_KIND,
  uuidv5,
} from "../../features/agents/agent-config-artifacts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import type { PullState, PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";
import { ownSolo } from "../../features/solo/labels";

export const SOLO_PULL_TYPE = "buzz.solo.pr";
/** How soon shown chats whose links could not be read try again. */
export const SOLO_REFRESH_MS = 60_000;
/** Links change rarely and only by hand, so shown chats read them again when
 * the window comes back, at most this often. */
const LINKS_AGAIN_MS = 5 * 60_000;
/** Chats per link read. Each has one link artifact, so a read of 500, the
 * session reader's cap, leaves room for concurrent revisions. */
const CHANNELS_PER_READ = 100;
const LINKS_PER_READ = 500;

/** A chat's linked pull request, and its state once read. */
export type SoloPull = Readonly<{
  url: string;
  state?: PullState | undefined;
  /** It could not be read. */
  failed?: boolean | undefined;
}>;

const tag = (event: EventData, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];

/** The pull request a current revision links: a URL, `null` once unlinked, or
 * undefined when it is not a Solo pull request link. */
export function linkOf(event: EventData): string | null | undefined {
  if (event.kind !== ARTIFACT_KIND || tag(event, "type") !== SOLO_PULL_TYPE)
    return undefined;
  try {
    const { url } = JSON.parse(event.content) as { url?: unknown };
    if (url === null) return null;
    const reference =
      typeof url === "string" ? parseGitHubReference(url) : undefined;
    return reference?.kind === "pull" ? reference.url : undefined;
  } catch {
    return undefined;
  }
}

/** Each chat's link artifact `d`, worked out once. */
const linkIds = new Map<string, Promise<string>>();
const linkId = (channel: string) => {
  let id = linkIds.get(channel);
  if (!id) {
    id = uuidv5(channel, SOLO_PULL_TYPE);
    linkIds.set(channel, id);
  }
  return id;
};

async function readLinks(
  session: RelaySession,
  channels: readonly string[],
  signal: AbortSignal,
) {
  const read = session.snapshotRead;
  const links = new Map<string, string | null>();
  if (!read) return links;
  for (let at = 0; at < channels.length; at += CHANNELS_PER_READ) {
    const page = channels.slice(at, at + CHANNELS_PER_READ);
    // Only the chats' link artifacts, not their other artifacts.
    const ids = await Promise.all(page.map(linkId));
    const events = await read(
      [
        {
          kinds: [ARTIFACT_KIND],
          "#h": page,
          "#d": ids,
          artifact: "current",
          limit: LINKS_PER_READ,
        },
      ],
      { signal },
    );
    for (const channel of page) links.set(channel, null);
    for (const event of events) {
      const channel = tag(event, "h");
      const url = linkOf(event);
      if (channel && links.get(channel) === null && url)
        links.set(channel, url);
    }
  }
  return links;
}

/** Whether the signed-in `viewer` manages `channel`'s link: their own Solo
 * chat, or one their agent `agent` started for them. */
export function linksSolo(
  channel: Parameters<typeof ownSolo>[0],
  viewer: string | undefined,
  agent?: string | undefined,
) {
  return ownSolo(channel, viewer) || (!!viewer && ownSolo(channel, agent));
}

/** Links `url` to the Solo chat `channel`, or unlinks it with `null`, as the
 * signed-in person. */
export async function writeLink(
  session: RelaySession,
  channel: string,
  url: string | null,
  signal = AbortSignal.timeout(20_000),
) {
  const read = session.snapshotRead;
  const writer = session.configArtifactWriter;
  if (!read || !writer)
    throw new Error("This community connection can't save pull request links.");
  const d = await linkId(channel);
  const [head] = await read(
    [
      {
        kinds: [ARTIFACT_KIND],
        "#h": [channel],
        "#d": [d],
        artifact: "current",
        limit: 1,
      },
    ],
    { signal },
  );
  if (head ? linkOf(head) === url : url === null) return;
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({ version: 1, url }),
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", SOLO_PULL_TYPE],
        ["title", "Pull request"],
        ["op", head ? "update" : "create"],
        ...(head ? [["prev", head.id]] : []),
      ],
    },
    signal,
  );
  await writer.publish(event, signal);
}

export type SoloPulls = Readonly<{
  /** Keeps `channel`'s link and pull request current while subscribed. */
  watch(channel: string, listener: () => void): () => void;
  get(channel: string): SoloPull | undefined;
  /** Shows a link this device just wrote, without reading it back. */
  linked(channel: string, url: string | null): void;
}>;

/** One session's Solo pull requests, with their states from `states`.
 *
 * Links are read once per shown chat, batched for rows that appear together,
 * and again when the window comes back after a while; never on a timer. A
 * shown chat's linked pull request is watched in `states` while shown. */
export function createSoloPulls(
  session: RelaySession,
  states: PullStates,
): SoloPulls {
  const listeners = new Map<string, Set<() => void>>();
  const links = new Map<string, string | null>();
  /** Shown chats whose link is still to be read. */
  const unread = new Set<string>();
  /** Each shown chat's subscription to its linked pull request's state. */
  const watching = new Map<string, () => void>();
  let linksReadAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let scheduled = false;
  /** What `get` answered since the last change, so it answers the same. */
  const views = new Map<string, SoloPull | undefined>();
  const notify = (channel: string) => {
    views.delete(channel);
    for (const listener of listeners.get(channel) ?? []) listener();
  };
  /** Watches the pull request `channel` links now, while the chat is shown.
   * The store may have moved on while the chat was not: `get` reads afresh. */
  const follow = (channel: string) => {
    watching.get(channel)?.();
    watching.delete(channel);
    views.delete(channel);
    const url = links.get(channel);
    if (url && listeners.has(channel))
      watching.set(
        channel,
        states.watch(url, () => notify(channel)),
      );
  };
  /** Tries again in a while, while a shown chat's link is still unread. */
  const later = () => {
    clearTimeout(timer);
    timer = undefined;
    if (![...unread].some((channel) => listeners.has(channel))) return;
    timer = setTimeout(
      () => (document.visibilityState === "visible" ? void refresh() : later()),
      SOLO_REFRESH_MS,
    );
  };
  /** Reads the links still unread. */
  async function refresh() {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    clearTimeout(timer);
    timer = undefined;
    const signal = AbortSignal.any([
      current.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      const channels = [...unread].filter((channel) => listeners.has(channel));
      if (!channels.length) return;
      const read = await readLinks(session, channels, signal);
      // A refresh that was stopped or replaced changes nothing.
      if (current.signal.aborted) return;
      for (const [channel, url] of read) {
        links.set(channel, url);
        unread.delete(channel);
        follow(channel);
        notify(channel);
      }
    } catch {
      // Keep what is shown; the next refresh tries again.
    } finally {
      if (controller === current) {
        controller = undefined;
        if (listeners.size) later();
      }
    }
  }
  /** Reads soon, once for every row that starts watching together. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (listeners.size) void refresh();
    });
  }
  /** Back in the window after a while: shown chats read their links again. */
  const returned = () => {
    if (
      document.visibilityState !== "visible" ||
      Date.now() - linksReadAt < LINKS_AGAIN_MS
    )
      return;
    linksReadAt = Date.now();
    for (const channel of listeners.keys()) unread.add(channel);
    schedule();
  };
  return {
    watch(channel, listener) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        if (!listeners.size) {
          linksReadAt = Date.now();
          document.addEventListener("visibilitychange", returned);
        }
        listeners.set(channel, set);
        if (links.has(channel)) follow(channel);
        else {
          unread.add(channel);
          schedule();
        }
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size) return;
        listeners.delete(channel);
        watching.get(channel)?.();
        watching.delete(channel);
        if (listeners.size) return;
        document.removeEventListener("visibilitychange", returned);
        clearTimeout(timer);
        timer = undefined;
        controller?.abort();
        controller = undefined;
      };
    },
    get(channel) {
      if (!views.has(channel)) {
        const url = links.get(channel);
        const state = url ? states.get(url) : undefined;
        views.set(
          channel,
          !url
            ? undefined
            : state === "failed"
              ? { url, failed: true }
              : { url, state },
        );
      }
      return views.get(channel);
    },
    linked(channel, url) {
      links.set(channel, url);
      unread.delete(channel);
      follow(channel);
      notify(channel);
    },
  };
}
