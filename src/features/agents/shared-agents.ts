import { avatarSource } from "../../shared/avatar-source";
import type { EventData } from "../relay/events";
import {
  AGENT_CATALOG_KIND,
  object,
  validCatalogEnvelope,
} from "./catalog-envelope";
import { sharedModel } from "./synced-route";

export type SharedAgent = {
  /** `owner:d`, unique per publisher and catalog slug. */
  id: string;
  name: string;
  owner: string;
  picture?: string;
  model: string;
  runtime?: string;
  provider?: string;
  instructions: string;
};

/** The agents a community's catalog events currently share, by name. NIP-33
 * picks the head per (owner, d) first, so an unshared or invalid replacement
 * hides older shared heads rather than reviving them. */
export function sharedAgents(events: readonly EventData[]): SharedAgent[] {
  const heads = new Map<string, EventData>();
  for (const event of [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1),
  )) {
    const d = event.tags.filter((tag) => tag[0] === "d");
    if (event.kind !== AGENT_CATALOG_KIND || d.length !== 1 || !d[0]?.[1])
      continue;
    const key = `${event.pubkey}:${d[0][1]}`;
    if (!heads.has(key)) heads.set(key, event);
  }
  return [...heads]
    .flatMap(([id, event]) => {
      const body = object(event.content);
      if (
        !body ||
        !validCatalogEnvelope(event) ||
        !event.tags.some((tag) => tag[0] === "shared")
      )
        return [];
      const picture = avatarSource(body.avatar_url);
      return [
        {
          id,
          name: String(body.display_name).trim(),
          owner: event.pubkey,
          ...(picture?.startsWith("https:") ? { picture } : {}),
          model: sharedModel(
            typeof body.model === "string" ? body.model.trim() : "",
            body.model_route,
          ),
          ...(typeof body.runtime === "string" && body.runtime.trim()
            ? { runtime: body.runtime.trim() }
            : {}),
          ...(typeof body.provider === "string" && body.provider.trim()
            ? { provider: body.provider.trim() }
            : {}),
          instructions:
            typeof body.system_prompt === "string" ? body.system_prompt : "",
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
