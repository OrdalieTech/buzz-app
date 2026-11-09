import type { DraftPicks } from "./ComposerModels";
import { lockSoloModelPicks } from "./solo-model-picks-lock";
export { lockSoloModelPicks } from "./solo-model-picks-lock";
import {
  publishModelPicks,
  transactModelPicks,
} from "./solo-model-picks-storage";

export const soloModelPicksKey = (channelId: string) =>
  `solo:model-picks:${channelId}`;

export function parseSoloModelPicks(
  revision: string | null | undefined,
): DraftPicks {
  let saved: unknown;
  try {
    saved = JSON.parse(revision ?? "null");
  } catch {
    return {};
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(
    Object.entries(saved).flatMap(([pubkey, pick]) => {
      if (
        !/^[0-9a-f]{64}$/.test(pubkey) ||
        !pick ||
        typeof pick !== "object" ||
        Array.isArray(pick)
      )
        return [];
      const record = pick as Record<string, unknown>;
      const model = typeof record.model === "string" ? record.model : undefined;
      const effort =
        typeof record.effort === "string" ? record.effort : undefined;
      const type = typeof record.type === "string" ? record.type : undefined;
      return model || effort
        ? [
            [
              pubkey,
              {
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
                ...(type ? { type } : {}),
              },
            ],
          ]
        : [];
    }),
  );
}

export function readSoloModelPicks(scope: string, key: string) {
  return transactModelPicks(scope, [key], (tx) => ({
    revision: tx.revision(key),
    version: tx.version(key),
  }));
}

export function updateSoloModelPicks(
  scope: string,
  key: string,
  edits: ReadonlyMap<string, DraftPicks[string] | undefined>,
) {
  return lockSoloModelPicks(scope, async () => {
    const saved = await transactModelPicks(scope, [key], (tx) => {
      const revision = tx.revision(key);
      const picks = { ...parseSoloModelPicks(revision) };
      for (const [pubkey, pick] of edits) {
        if (pick) picks[pubkey] = pick;
        else delete picks[pubkey];
      }
      const version = tx.write(key, picks);
      return { picks, version };
    });
    publishModelPicks(scope);
    return saved;
  });
}
