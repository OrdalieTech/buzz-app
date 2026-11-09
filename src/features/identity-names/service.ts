import { createNameProvider } from "./directory";
import type { NamingIdentity } from "./policy";
import type { LocalAgents } from "../agents/local";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ProfileQueries } from "../relay/profile-directory";
import type { AgentLibrary } from "../agents/library";
import { createContributions } from "../../plugins/contributions";

export type NamingPolicy = {
  id: string;
  /** Compare all displayed aliases across distinct keys; return each key's last
   * supplied alias. Repeated configurations of one key are not namesakes.
   * With `candidates`, the directory passes only the rows `scopeKeys` selects
   * (the candidates and their agents' owners), not the whole cache. */
  resolve(
    identities: readonly NamingIdentity[],
    viewer?: string,
    candidates?: readonly string[],
  ): ReadonlyMap<string, { name: string; qualifier?: string | undefined }>;
};

export type NameSource = {
  viewer?: string | undefined;
  relayUrl?: string | undefined;
  profiles: ProfileQueries;
  agentLibrary: {
    snapshot(): AgentLibrary & { status: string };
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
    retain(): () => void;
  };
};
export type NameProvider = {
  id: string;
  /** Resolve keys against one candidate scope; the requested key always joins it. */
  scope(
    source: NameSource,
    candidates?: readonly string[],
    displayFacts?: readonly NamingIdentity[],
  ): (
    pubkey: string,
  ) => { name: string; qualifier?: string | undefined } | undefined;
  activate(source: NameSource): undefined | (() => void);
  subscribe?(listener: () => void): () => void;
};
export type IdentityName = Readonly<{
  name: string;
  qualifier?: string | undefined;
  source: "agent-directory" | "public-profile";
}>;
export interface IdentityNameView {
  lookup(
    pubkey: string,
    candidates?: readonly string[],
    displayFacts?: readonly NamingIdentity[],
  ): IdentityName | undefined;
  /** Normalize one candidate scope once for many lookups. */
  scope(
    candidates?: readonly string[],
    displayFacts?: readonly NamingIdentity[],
  ): (pubkey: string) => IdentityName | undefined;
  resolve(
    pubkey: string,
    fallback?: string,
    candidates?: readonly string[],
    displayFacts?: readonly NamingIdentity[],
  ): string | undefined;
  snapshot(): number;
  subscribe(listener: () => void): () => void;
}
export interface IdentityNames {
  bind(source: NameSource): IdentityNameView & { dispose(): void };
  register(policy: NamingPolicy): void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    identityNames: IdentityNames;
  }
}

/** Stable injected service; provider replacement never replaces consumers' handle. */
export class IdentityNamesService extends Service implements IdentityNames {
  private readonly entries;
  private readonly registrations = new Set<object>();

  constructor(
    ctx: Context,
    private readonly control?: LocalAgents,
  ) {
    super(ctx, "identityNames");
    this.entries = createContributions<NameProvider>(ctx);
  }
  register(policy: NamingPolicy) {
    if (this.registrations.size)
      throw new Error("An identity name provider is already registered");
    const token = {};
    const registrations = this.registrations;
    this.ctx.effect(() => {
      registrations.add(token);
      return () => {
        registrations.delete(token);
      };
    });
    this.entries.register(this.ctx, createNameProvider(policy, this.control));
  }
  bind(source: NameSource) {
    return bindNames(source, this.entries);
  }
}

/** Without an active policy, use public names and caller fallbacks. */
export function bindNames(
  source: NameSource,
  providers?: {
    snapshot(): readonly NameProvider[];
    subscribe(listener: () => void): () => void;
  },
): IdentityNameView & { dispose(): void } {
  let closed = false;
  let revision = 0;
  let provider: NameProvider | undefined;
  let stopLibrary: (() => void) | undefined;
  let stopProvider: (() => void) | undefined;
  let deactivate: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    if (closed) return;
    revision++;
    for (const listener of listeners) listener();
  };
  const select = () => {
    if (closed) return;
    const entries = providers?.snapshot() ?? [];
    // Competing providers do not acquire last-writer authority.
    const next = entries.length === 1 ? entries[0] : undefined;
    if (provider === next) return;
    deactivate?.();
    deactivate = undefined;
    stopLibrary?.();
    stopLibrary = undefined;
    stopProvider?.();
    stopProvider = undefined;
    provider = next;
    if (provider) {
      stopLibrary = source.agentLibrary.subscribe(emit);
      stopProvider = provider.subscribe?.(emit);
      deactivate = provider.activate(source);
    }
    emit();
  };
  const stops = [source.profiles.subscribe(emit)];
  if (providers) stops.push(providers.subscribe(select));
  select();
  // Callers resolve many keys against one candidate array (a channel's
  // participants or members). Reuse that array's scope so each key does not
  // renormalize the candidates; the scope re-reads live state per lookup.
  let last:
    | {
        candidates: readonly string[] | undefined;
        displayFacts: readonly NamingIdentity[] | undefined;
        scoped: (pubkey: string) => IdentityName | undefined;
      }
    | undefined;
  const scope = (
    candidates?: readonly string[],
    displayFacts?: readonly NamingIdentity[],
  ) => {
    if (
      last &&
      last.candidates === candidates &&
      last.displayFacts === displayFacts
    )
      return last.scoped;
    let owner: NameProvider | undefined;
    let local: ReturnType<NameProvider["scope"]> | undefined;
    const scoped = (pubkey: string): IdentityName | undefined => {
      if (closed) return undefined;
      if (owner !== provider) {
        owner = provider;
        local = provider?.scope(source, candidates, displayFacts);
      }
      const label = local?.(pubkey);
      if (label?.name)
        return {
          name: label.name,
          qualifier: label.qualifier,
          source: "agent-directory",
        };
      const profile = source.profiles.snapshot().get(pubkey.toLowerCase());
      const name = profile?.nameIsFallback ? undefined : profile?.name;
      return name ? { name, source: "public-profile" } : undefined;
    };
    last = { candidates, displayFacts, scoped };
    return scoped;
  };
  const lookup = (
    pubkey: string,
    candidates?: readonly string[],
    displayFacts?: readonly NamingIdentity[],
  ) => scope(candidates, displayFacts)(pubkey);
  return {
    lookup,
    scope,
    resolve(pubkey, fallback, candidates, displayFacts) {
      return lookup(pubkey, candidates, displayFacts)?.name ?? fallback;
    },
    snapshot: () => revision,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      closed = true;
      provider = undefined;
      deactivate?.();
      stopLibrary?.();
      stopProvider?.();
      for (const stop of stops) stop();
      listeners.clear();
    },
  };
}
