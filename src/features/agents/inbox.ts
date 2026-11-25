import type { ChannelSummary } from "../relay/contracts";
import { ByteLru } from "../relay/budget";
import { DiscoveryState } from "../relay/discovery";
import {
  hasEventProof,
  type ReadFilter,
  type RelayEvent,
} from "../relay/events";
import { createRelayReader } from "../relay/reader";
import type { AgentReads } from "./reads";

/** Each channel has a metadata and a roster event; reads cap at 500. */
const FACTS_PER_READ = 250;

const channelOf = (event: RelayEvent) =>
  event.tags.find(([key]) => key === "h")?.[1];

export class AgentInbox {
  private readonly channels = new ByteLru<ChannelSummary>(128, 2 * 1024 * 1024);
  private readonly listeners = new Set<() => void>();
  private readonly reader;
  readonly reads: AgentReads;
  private nextRead = Date.now() + Math.floor(Math.random() * 5_000);
  private retryDelay = 0;

  due() {
    return Date.now() >= this.nextRead;
  }

  constructor(
    private readonly owner: AgentReads,
    private readonly pubkey: string,
    private readonly authority: string,
    query: (filters: readonly ReadFilter[]) => Promise<RelayEvent[]>,
    private readonly lifetime: AbortSignal,
  ) {
    this.reader = createRelayReader({
      viewer: pubkey,
      relayAuthor: authority,
      media: () => undefined,
      query: async (filters, signal) => {
        lifetime.throwIfAborted();
        signal?.throwIfAborted();
        const events = await query(filters);
        lifetime.throwIfAborted();
        signal?.throwIfAborted();
        return events;
      },
    });
    lifetime.addEventListener("abort", () => this.reader.dispose(), {
      once: true,
    });
    this.reads = {
      ...owner,
      channel: async (id) => {
        const known = await owner.channel(id);
        if (known) return known;
        await this.resolve([id], lifetime).catch((error) => {
          if (!lifetime.aborted)
            console.warn("Agent inbox could not refresh channel facts", error);
        });
        const channel = this.channel(id);
        return (
          channel && {
            name: channel.name,
            ...(channel.description ? { about: channel.description } : {}),
            dm: channel.channelType === "dm",
            members: channel.members ?? [],
          }
        );
      },
      read: async (filters, signal) => {
        const ids = filters.flatMap((filter) => filter["#h"] ?? []);
        const known = await Promise.all(ids.map((id) => owner.channel(id)));
        return known.some((channel) => !channel)
          ? this.reader.reader.read(filters, {
              signal: AbortSignal.any([lifetime, signal]),
            })
          : owner.read(filters, signal);
      },
      channelLabel: (id) => {
        const channel = this.channel(id);
        return (
          owner.channelLabel(id) ??
          (channel && {
            name: channel.name,
            ...(channel.private ? { private: channel.private } : {}),
            ...(channel.channelType
              ? { channelType: channel.channelType }
              : {}),
          })
        );
      },
      subscribeChannels: (listener) => {
        this.listeners.add(listener);
        const stop = owner.subscribeChannels(listener);
        return () => {
          this.listeners.delete(listener);
          stop();
        };
      },
    };
  }

  channel(id: string) {
    return this.lifetime.aborted ? undefined : this.channels.get(id);
  }

  /** Resolves the channels, returning those the relay gave not all of. */
  private async resolve(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<{ partial: string[]; dms: string[] }> {
    if (!ids.length) return { partial: [], dms: [] };
    const unique = [...new Set(ids)];
    const options = {
      signal: AbortSignal.any([this.lifetime, signal]),
      fresh: true,
    };
    const events = (
      await Promise.all(
        Array.from(
          { length: Math.ceil(unique.length / FACTS_PER_READ) },
          (_, index) => {
            const batch = unique.slice(
              index * FACTS_PER_READ,
              (index + 1) * FACTS_PER_READ,
            );
            return this.reader.reader.read(
              [
                {
                  kinds: [39000, 39002],
                  authors: [this.authority],
                  "#d": batch,
                  limit: batch.length * 2,
                },
              ],
              options,
            );
          },
        ),
      )
    ).flat();
    const kinds = new Map<string, Set<number>>();
    const excluded = new Set<string>();
    const discovery = new DiscoveryState(
      this.pubkey,
      this.authority,
      2 * 1024 * 1024,
    );
    for (const event of events)
      if (hasEventProof(event)) {
        discovery.accept(event);
        const id = event.tags.find(([key]) => key === "d")?.[1];
        if (id) kinds.set(id, (kinds.get(id) ?? new Set()).add(event.kind));
        if (
          id &&
          event.kind === 39002 &&
          event.pubkey === this.authority &&
          !event.tags.some(
            ([key, value]) => key === "p" && value === this.pubkey,
          )
        )
          excluded.add(id);
      }
    // A channel these come from is one the agent reads, so missing metadata or
    // roster is unknown, not absent: it neither confirms nor revokes what was
    // verified before.
    const partial = ids.filter((id) => kinds.get(id)?.size !== 2);
    for (const id of ids) {
      // A signed roster without the agent revokes it, whatever else is missing.
      if (excluded.has(id)) this.channels.delete(id);
      if (partial.includes(id)) continue;
      this.channels.delete(id);
      const channel = discovery.get(id);
      if (discovery.authorized(id) && channel?.channelType === "dm")
        this.channels.set(id, channel);
    }
    for (const listener of this.listeners) listener();
    return {
      partial,
      dms: ids.filter(
        (id) =>
          !partial.includes(id) &&
          discovery.authorized(id) &&
          discovery.get(id)?.channelType === "dm",
      ),
    };
  }

  private async read(filter: ReadFilter, signal: AbortSignal) {
    const events = await this.reader.reader.read([filter], {
      signal: AbortSignal.any([this.lifetime, signal]),
      priority: "background",
      fresh: true,
    });
    const ids = [
      ...new Set(
        events.flatMap((event) =>
          event.tags.flatMap(([key, value]) =>
            key === "h" && value ? [value] : [],
          ),
        ),
      ),
    ];
    const known = await Promise.all(ids.map((id) => this.owner.channel(id)));
    const { partial, dms } = await this.resolve(
      ids.filter((_, index) => !known[index]),
      signal,
    );
    const owned = new Set(ids.filter((_, index) => known[index]));
    return { events, partial, readable: new Set([...owned, ...dms]) };
  }

  /** Reads as the agent, failing while any DM it returns is only partly
   * known, so a caller retries rather than acts on it. */
  async readAsAgent(filter: ReadFilter, signal: AbortSignal) {
    const { events, partial, readable } = await this.read(filter, signal);
    if (partial.length)
      throw new Error("The relay did not return all of a DM's details");
    // Only a confirmed DM is read past the owner, judged by this read rather
    // than the bounded cache it may have overflowed.
    return events.filter((event) => readable.has(channelOf(event) ?? ""));
  }

  /** A catch-up page as the relay gave it, whole, so its paging holds; the
   * runner delivers only its confirmed DMs. */
  async mentions(filter: ReadFilter, signal: AbortSignal) {
    try {
      const { events, partial } = await this.read(filter, signal);
      if (partial.length)
        throw new Error("The relay did not return all of a DM's details");
      if (events.length < filter.limit) this.schedule(0);
      return events;
    } catch (error) {
      if (!signal.aborted && !this.lifetime.aborted)
        this.schedule(
          Math.min(this.retryDelay ? this.retryDelay * 2 : 30_000, 240_000),
        );
      throw error;
    }
  }

  private schedule(retryDelay: number) {
    this.retryDelay = retryDelay;
    const delay = retryDelay || 30_000;
    this.nextRead =
      Date.now() + delay + Math.floor((Math.random() * delay) / 4);
  }
}
