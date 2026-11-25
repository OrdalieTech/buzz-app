import type { PluginManifest } from "./api";
import type { PluginManager } from "./manager";

type Owners = Pick<
  ReturnType<PluginManager["snapshot"]>,
  "hostOwned" | "configuration"
>;
export type PluginOwner = Readonly<{
  manifest: PluginManifest;
  /** A host-owned feature: it always runs and has no catalog entry. */
  hostOwned: boolean;
}>;

/**
 * Who contributes under `id`: a host-owned feature, else a catalog plugin.
 * Host-owned goes first because the manager never activates a catalog entry
 * under a host-owned id. Undefined when the id is neither, which includes a
 * catalog plugin while the catalog is not ready.
 */
export function resolveOwner(
  { hostOwned, configuration }: Owners,
  id: string,
): PluginOwner | undefined {
  const feature = hostOwned.find((manifest) => manifest.id === id);
  if (feature) return { manifest: feature, hostOwned: true };
  const plugin =
    configuration.status === "ready"
      ? configuration.catalog.plugins.find(({ manifest }) => manifest.id === id)
      : undefined;
  return plugin && { manifest: plugin.manifest, hostOwned: false };
}

/** The owner's display name, or `id` itself when it has no known owner. */
export const ownerName = (snapshot: Owners, id: string) =>
  resolveOwner(snapshot, id)?.manifest.name ?? id;
