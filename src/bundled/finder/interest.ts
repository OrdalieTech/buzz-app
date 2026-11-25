import { readView, writeView } from "../../shared/view-state";

// Which channels you keep coming back to, kept on this device for one
// community and account. Leaving the community removes it with the rest of
// that community's view state.
const KEY = "finder-interest";
/** A visit counts half as much a week later. */
const HALF_LIFE_S = 7 * 86_400;
const KEEP = 50;

type Entry = [score: number, at: number];

const now = () => Math.floor(Date.now() / 1000);
const decayed = ([score, at]: Entry, when: number) =>
  score * 0.5 ** (Math.max(0, when - at) / HALF_LIFE_S);

function ranked(scope: string, when: number): [string, number][] {
  const saved = readView<unknown>(scope, KEY, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return [];
  return Object.entries(saved as Record<string, unknown>)
    .flatMap(([id, entry]): [string, number][] =>
      Array.isArray(entry) &&
      Number.isFinite(entry[0]) &&
      Number.isFinite(entry[1])
        ? [[id, decayed(entry as Entry, when)]]
        : [],
    )
    .sort((a, b) => b[1] - a[1]);
}

/** Records interest in a channel: 1 for a visit, more for a search in it. */
export function noteInterest(
  scope: string,
  channelId: string,
  weight: number,
  when = now(),
) {
  const scores = new Map(ranked(scope, when));
  scores.set(channelId, (scores.get(channelId) ?? 0) + weight);
  const kept = [...scores].sort((a, b) => b[1] - a[1]).slice(0, KEEP);
  writeView(
    scope,
    KEY,
    Object.fromEntries(kept.map(([id, score]) => [id, [score, when]])),
  );
}

/** Channel ids, most visited and searched first, recent counting more. */
export function topInterest(scope: string, count: number, when = now()) {
  return ranked(scope, when)
    .slice(0, count)
    .map(([id]) => id);
}
