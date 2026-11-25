import { purgeArtifactStorage } from "../artifact-storage/store";
import { purgeOutboxStorage } from "./outbox-storage";
import { relayPartition } from "./partition";
import { clearNativeMedia, nativeMediaUsage } from "./native";
import { createHeadPersistence } from "./persistence";
import { purgeReadStateStorage } from "./read-state-storage";
import { purgeSoloModelPicks } from "../messages/solo-model-picks-storage";

type Attempt = (store: string, work: () => Promise<void>) => Promise<void>;

/** Clears what the relay saved for one partition that it can read again:
 * Clear cache and an access refusal forget only this, leaving forgets it with
 * the rest of the partition. */
export async function purgeRelayCache(
  origin: string,
  viewer: string,
  attempt: Attempt,
) {
  await attempt("channel heads", async () => {
    // Without IndexedDB the cache never existed; the persistence reports it as
    // unavailable rather than empty.
    if (typeof indexedDB === "undefined") return;
    const heads = createHeadPersistence(viewer, origin);
    try {
      await heads.clear();
    } finally {
      heads.close();
    }
  });
  await attempt("saved images", () => clearNativeMedia(origin));
}

/** The bytes `purgeRelayCache` would free on disk. */
export async function relayCacheUsage(origin: string, viewer: string) {
  const heads = createHeadPersistence(viewer, origin);
  try {
    const [saved, images] = await Promise.all([
      typeof indexedDB === "undefined" ? 0 : (heads.usage?.() ?? 0),
      nativeMediaUsage(origin),
    ]);
    return saved + (images ?? 0);
  } finally {
    heads.close();
  }
}

/** Clears the relay's durable stores for one partition, each through the
 * caller's `attempt` so an unavailable store neither keeps the others nor goes
 * unreported. The databases stay separate; only this entrypoint is shared. */
export async function purgeRelayPartition(
  origin: string,
  viewer: string,
  attempt: Attempt,
) {
  const partition = relayPartition(origin, viewer);
  await purgeRelayCache(origin, viewer, attempt);
  await attempt("read state", () => purgeReadStateStorage(partition));
  await attempt("outbox", () => purgeOutboxStorage(partition));
  await attempt("artifacts", () => purgeArtifactStorage(viewer, origin));
  await attempt("model and effort choices", () =>
    purgeSoloModelPicks(partition),
  );
}
