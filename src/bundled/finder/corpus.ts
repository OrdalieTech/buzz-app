import {
  bestScore,
  charMask,
  matchTerms,
  parseQuery,
  termsInOrder,
  termsMatch,
} from "./match.ts";

/** One message the finder can find. `author` and `place` are display names,
 * searched along with the text so "maya deploy" finds Maya's message. */
export type FinderDoc = Readonly<{
  id: string;
  channelId: string;
  threadRootId?: string | undefined;
  authorId: string;
  createdAt: number;
  author: string;
  place: string;
  text: string;
}>;

export type FinderHit = Readonly<{
  doc: FinderDoc;
  score: number;
  /** Matched indexes into `doc.text`, for underlining. */
  positions: readonly number[];
}>;

export type FinderResults = Readonly<{
  hits: readonly FinderHit[];
  /** How many messages matched, of which `hits` are the best. */
  total: number;
}>;

/** UTF-16 indexes (sorted) as code point indexes, which labels underline. */
function codePoints(text: string, indexes: readonly number[]) {
  if (!/[\uD800-\uDBFF]/.test(text)) return indexes;
  const out: number[] = [];
  let point = 0;
  let next = 0;
  for (let i = 0; i < text.length && next < indexes.length; i++) {
    if (i === indexes[next]) {
      out.push(point);
      next++;
    }
    const code = text.charCodeAt(i);
    if (code < 0xd800 || code > 0xdbff) point++;
  }
  return out;
}

type Entry = {
  doc: FinderDoc;
  /** `author place text`, as searched; `textAt` is where the text starts. */
  haystack: string;
  lower: string;
  textAt: number;
  mask: number;
  live: boolean;
};

/** The messages the finder searches, held in memory, and the search over
 * them. Typing more of the same query only rescans what could still match. */
export function createCorpus() {
  const entries: Entry[] = [];
  const byId = new Map<string, number>();
  let version = 0;
  let dead = 0;
  let sorted = true;
  let last:
    | {
        query: string;
        channelId: string | undefined;
        version: number;
        candidates: number[];
      }
    | undefined;

  function entryOf(doc: FinderDoc): Entry {
    const prefix = `${doc.author} ${doc.place} `;
    const haystack = prefix + doc.text;
    const lowered = haystack.toLowerCase();
    // Lowercasing can change length (İ); positions must line up, so such
    // text is compared as typed.
    const lower = lowered.length === haystack.length ? lowered : haystack;
    return {
      doc,
      haystack,
      lower,
      textAt: prefix.length,
      mask: charMask(haystack),
      live: true,
    };
  }

  /** Oldest first, scanned from the end, so the scan meets ties in the
   * order they rank and can stop scoring once nothing later can place. New
   * messages usually append in order; a batch out of order sorts once, on
   * the next search. Sorting also drops removed entries. */
  const before = (a: FinderDoc, b: FinderDoc) =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  function order() {
    if (sorted) return;
    let write = 0;
    for (const entry of entries) if (entry.live) entries[write++] = entry;
    entries.length = write;
    entries.sort((a, b) => before(a.doc, b.doc));
    byId.clear();
    entries.forEach((entry, at) => {
      byId.set(entry.doc.id, at);
    });
    dead = 0;
    sorted = true;
  }

  function changed() {
    version++;
    last = undefined;
  }

  return {
    get size() {
      return entries.length - dead;
    },
    /** Adds messages, replacing any with the same id. */
    add(docs: readonly FinderDoc[]) {
      for (const doc of docs) {
        const at = byId.get(doc.id);
        const newest = entries.at(-1)?.doc;
        if (at === undefined) {
          if (newest && before(doc, newest) < 0) sorted = false;
          byId.set(doc.id, entries.length);
          entries.push(entryOf(doc));
        } else {
          if ((entries[at] as Entry).doc.createdAt !== doc.createdAt)
            sorted = false;
          entries[at] = entryOf(doc);
        }
      }
      if (docs.length) changed();
    },
    /** Drops messages matching `drop`, e.g. a channel the viewer left. */
    remove(drop: (doc: FinderDoc) => boolean) {
      let removed = 0;
      for (const entry of entries)
        if (entry.live && drop(entry.doc)) {
          entry.live = false;
          byId.delete(entry.doc.id);
          removed++;
        }
      if (!removed) return;
      dead += removed;
      // Compact once enough is removed, on the next search.
      if (dead > 1024 && dead > entries.length / 4) sorted = false;
      changed();
    },
    clear() {
      entries.length = 0;
      byId.clear();
      dead = 0;
      sorted = true;
      changed();
    },
    search(query: string, limit = 50, channelId?: string): FinderResults {
      const terms = parseQuery(query);
      order();
      // Newest first when nothing is typed, as a place to start.
      if (!terms.length) {
        const recent = entries.filter(
          (entry) =>
            entry.live &&
            (channelId === undefined || entry.doc.channelId === channelId),
        );
        return {
          hits: recent
            .slice(-limit)
            .reverse()
            .map(({ doc }) => ({ doc, score: 0, positions: [] })),
          total: recent.length,
        };
      }
      let mask = 0;
      for (const term of terms) if (!term.negate) mask |= charMask(term.text);
      const best = bestScore(terms);
      // A longer query keeps only entries whose letters are still in order,
      // unless it lengthens an exclusion. In-order letters is monotone; the
      // window is not (it widens as a term grows), so each candidate is
      // matched again in full.
      const narrowed =
        last &&
        last.version === version &&
        last.channelId === channelId &&
        query.startsWith(last.query) &&
        !query.includes("!")
          ? last.candidates
          : undefined;
      const candidates: number[] = [];
      let total = 0;
      // Best `limit` hits, worst last. Entries are met newest first, so an
      // equal score never displaces one already held.
      const top: { at: number; score: number }[] = [];
      const consider = (at: number) => {
        const entry = entries[at] as Entry;
        if (
          !entry.live ||
          (channelId !== undefined && entry.doc.channelId !== channelId) ||
          (entry.mask & mask) !== mask ||
          !termsInOrder(terms, entry.haystack, entry.lower)
        )
          return;
        candidates.push(at);
        if (!termsMatch(terms, entry.haystack, entry.lower)) return;
        total++;
        const full = top.length === limit;
        if (full && (top[limit - 1] as { score: number }).score >= best) return;
        const score = matchTerms(terms, entry.haystack, entry.lower) as number;
        if (full) {
          if (score <= (top[limit - 1] as { score: number }).score) return;
          top.pop();
        }
        let i = top.length;
        while (i > 0 && (top[i - 1] as { score: number }).score < score) i--;
        top.splice(i, 0, { at, score });
      };
      if (narrowed) for (const at of narrowed) consider(at);
      else for (let at = entries.length - 1; at >= 0; at--) consider(at);
      last = { query, channelId, version, candidates };
      return {
        total,
        hits: top.map(({ at, score }) => {
          const entry = entries[at] as Entry;
          const positions: number[] = [];
          matchTerms(terms, entry.haystack, entry.lower, positions);
          return {
            doc: entry.doc,
            score,
            positions: codePoints(
              entry.doc.text,
              [
                ...new Set(
                  positions
                    .filter((p) => p >= entry.textAt)
                    .map((p) => p - entry.textAt),
                ),
              ].sort((a, b) => a - b),
            ),
          };
        }),
      };
    },
  };
}

export type FinderCorpus = ReturnType<typeof createCorpus>;
