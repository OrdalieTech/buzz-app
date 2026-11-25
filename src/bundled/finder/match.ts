// Scoring ported from fzf's `calculateScore`, and matching adapted from its
// `FuzzyMatchV1` (src/algo/algo.go, MIT, Copyright (c) 2013-2026 Junegunn
// Choi). See NOTICE.md. Chat messages are long prose, unlike file paths, so a
// term's letters must stay close together and typed words are tried first.

const scoreMatch = 16;
const scoreGapStart = -3;
const scoreGapExtension = -1;
const bonusBoundary = scoreMatch / 2;
const bonusNonWord = scoreMatch / 2;
const bonusCamel123 = bonusBoundary + scoreGapExtension;
const bonusConsecutive = -(scoreGapStart + scoreGapExtension);
const bonusFirstCharMultiplier = 2;
const bonusBoundaryWhite = bonusBoundary + 2;
const bonusBoundaryDelimiter = bonusBoundary + 1;

const White = 0;
const NonWord = 1;
const Delimiter = 2;
const Lower = 3;
const Upper = 4;
const Letter = 5;
const NumberClass = 6;

function classify(code: number) {
  const char = String.fromCharCode(code);
  if (/\s/u.test(char)) return White;
  if ("/,:;|".includes(char)) return Delimiter;
  if (/\p{Lu}/u.test(char)) return Upper;
  if (/\p{Ll}/u.test(char)) return Lower;
  if (/\p{N}/u.test(char)) return NumberClass;
  if (/[\p{L}\p{M}]/u.test(char)) return Letter;
  return NonWord;
}

/** Every UTF-16 unit's class, filled as units are first seen (surrogate
 * halves count as letters, which emoji rarely need to be otherwise). */
const classes = new Uint8Array(65536).fill(255);
const classOf = (code: number) => {
  let found = classes[code] as number;
  if (found === 255) {
    found = code >= 0xd800 && code <= 0xdfff ? Letter : classify(code);
    classes[code] = found;
  }
  return found;
};

function bonusOf(previous: number, current: number) {
  if (current > NonWord) {
    if (previous === White) return bonusBoundaryWhite;
    if (previous === Delimiter) return bonusBoundaryDelimiter;
    if (previous === NonWord) return bonusBoundary;
  }
  if (
    (previous === Lower && current === Upper) ||
    (previous !== NumberClass && current === NumberClass)
  )
    return bonusCamel123;
  if (current === NonWord || current === Delimiter) return bonusNonWord;
  if (current === White) return bonusBoundaryWhite;
  return 0;
}
/** `bonus[previous * 7 + current]`, as fzf precomputes it. */
const bonus = Int8Array.from({ length: 49 }, (_, n) =>
  bonusOf(Math.floor(n / 7), n % 7),
);

/** fzf's score for `pattern` matched in order within `text[start..end]`.
 * Pushes matched indexes into `positions` when given. */
function scoreSpan(
  text: string,
  pattern: string,
  start: number,
  end: number,
  positions?: number[],
) {
  let p = 0;
  let score = 0;
  let inGap = false;
  let consecutive = 0;
  let firstBonus = 0;
  let previous = start > 0 ? classOf(text.charCodeAt(start - 1)) : White;
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    const current = classOf(code);
    if (code === pattern.charCodeAt(p)) {
      positions?.push(i);
      score += scoreMatch;
      let gain = bonus[previous * 7 + current] as number;
      if (consecutive === 0) firstBonus = gain;
      else {
        if (gain >= bonusBoundary && gain > firstBonus) firstBonus = gain;
        gain = Math.max(gain, firstBonus, bonusConsecutive);
      }
      score += p === 0 ? gain * bonusFirstCharMultiplier : gain;
      inGap = false;
      consecutive++;
      p++;
    } else {
      score += inGap ? scoreGapExtension : scoreGapStart;
      inGap = true;
      consecutive = 0;
      firstBonus = 0;
    }
    previous = current;
  }
  return score;
}

/** How far one term's letters may spread: chat messages are long, and
 * letters picked from different words ("a" in "and", "y" in "you") are noise.
 * `dplyrlbk` still finds "deploy rollback". */
const spread = (length: number) => Math.max(length * 3, length + 6);
/** Spaces in `text[start..end)`: a term's letters may run across two
 * neighboring words ("dplyrlbk" in "deploy rollback"), not a sentence. */
function spaces(text: string, start: number, end: number) {
  let count = 0;
  for (
    let at = text.indexOf(" ", start);
    at >= 0 && at < end;
    at = text.indexOf(" ", at + 1)
  )
    count++;
  return count;
}

/** Start points tried per message. ponytail: fixed cap, an fzf v2-style
 * alignment if it misses real matches. */
const STARTS = 64;

/** A fuzzy match of `pattern` in `text`: the letters typed together if they
 * appear so, else the best-scoring compact run of them, trying each place the
 * first letter appears (fzf's v1 takes only the first). Both strings are
 * already in the case being compared. With `score` false, only whether it
 * matches (0) or not. */
export function fuzzyMatch(
  text: string,
  pattern: string,
  positions?: number[],
  score = true,
): number | undefined {
  if (!pattern) return 0;
  if (!score) {
    if (text.includes(pattern)) return 0;
  } else {
    const together = exactMatch(text, pattern, positions);
    if (together !== undefined) return together;
  }
  const limit = spread(pattern.length);
  const head = pattern[0] as string;
  let best: number | undefined;
  let bestStart = -1;
  let bestEnd = -1;
  for (
    let first = text.indexOf(head), tries = 0;
    first >= 0 && tries < STARTS;
    first = text.indexOf(head, first + 1), tries++
  ) {
    let at = first;
    for (let p = 1; p < pattern.length && at >= 0; p++) {
      at = text.indexOf(pattern[p] as string, at + 1);
      if (at - first >= limit) break;
    }
    // No later start can finish if this one ran out of text.
    if (at < 0) break;
    const end = at + 1;
    if (end - first > limit || spaces(text, first, end) > 1) continue;
    if (!score) return 0;
    const found = scoreSpan(text, pattern, first, end);
    if (best === undefined || found > best) {
      best = found;
      bestStart = first;
      bestEnd = end;
    }
  }
  if (best !== undefined && positions)
    scoreSpan(text, pattern, bestStart, bestEnd, positions);
  return best;
}

/** An exact substring match, scored like fzf's exact match: the occurrence
 * with the best boundary bonus wins. */
export function exactMatch(
  text: string,
  pattern: string,
  positions?: number[],
): number | undefined {
  if (!pattern) return 0;
  let best: number | undefined;
  let bestAt = -1;
  for (
    let at = text.indexOf(pattern);
    at >= 0;
    at = text.indexOf(pattern, at + 1)
  ) {
    const score = scoreSpan(text, pattern, at, at + pattern.length);
    if (best === undefined || score > best) {
      best = score;
      bestAt = at;
    }
    // A word-start hit cannot be beaten by a later one.
    if (
      at === 0 ||
      classOf(text.charCodeAt(at - 1)) === White ||
      best >= pattern.length * scoreMatch + bonusBoundaryWhite * 3
    )
      break;
  }
  if (best === undefined) return undefined;
  if (positions)
    for (let i = 0; i < pattern.length; i++) positions.push(bestAt + i);
  return best;
}

export type Term = Readonly<{
  text: string;
  exact: boolean;
  negate: boolean;
  /** Smart case: a term with a capital letter matches case. */
  caseSensitive: boolean;
}>;

/** Space-separated terms that must all match, as in fzf's extended search:
 * `'word` matches exactly and `!word` excludes. */
export function parseQuery(query: string): readonly Term[] {
  return query
    .trim()
    .split(/\s+/)
    .flatMap((raw): Term[] => {
      let text = raw;
      const negate = text.startsWith("!");
      if (negate) text = text.slice(1);
      const exact = negate || text.startsWith("'");
      if (text.startsWith("'")) text = text.slice(1);
      if (!text) return [];
      const caseSensitive = text !== text.toLowerCase();
      return [{ text, exact, negate, caseSensitive }];
    });
}

/** Letters and digits as bits, so a text lacking any of a term's letters is
 * skipped without scanning it. */
export function charMask(text: string) {
  let mask = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) | 0x20;
    if (code >= 97 && code <= 122) mask |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) mask |= 1 << (26 + ((code - 48) % 6));
  }
  return mask;
}

/** Whether every term matches, by the same rule as `matchTerms` but
 * without scoring. */
export function termsMatch(
  terms: readonly Term[],
  text: string,
  lower: string,
) {
  for (const term of terms) {
    const haystack = term.caseSensitive ? text : lower;
    const found = term.exact
      ? haystack.includes(term.text)
      : fuzzyMatch(haystack, term.text, undefined, false) !== undefined;
    if (found === term.negate) return false;
  }
  return true;
}

/** Whether each term's letters appear in order within two neighboring
 * words, as `termsMatch` needs, but without its window: typing more of a term
 * can only shrink what passes, while the window widens as a term grows.
 * Negated terms are not checked. */
export function termsInOrder(
  terms: readonly Term[],
  text: string,
  lower: string,
) {
  for (const term of terms) {
    if (term.negate) continue;
    const haystack = term.caseSensitive ? text : lower;
    if (
      !(term.exact
        ? haystack.includes(term.text)
        : inOrder(haystack, term.text))
    )
      return false;
  }
  return true;
}

/** `pattern`'s letters in order from some start, spanning at most one space
 * (each start takes the earliest letters, as `fuzzyMatch` does). */
function inOrder(text: string, pattern: string) {
  const head = pattern[0] as string;
  for (
    let first = text.indexOf(head);
    first >= 0;
    first = text.indexOf(head, first + 1)
  ) {
    const space = text.indexOf(" ", first);
    const second = space < 0 ? -1 : text.indexOf(" ", space + 1);
    let at = first;
    for (let p = 1; p < pattern.length && at >= 0; p++) {
      at = text.indexOf(pattern[p] as string, at + 1);
      if (second >= 0 && at > second) break;
    }
    // No later start can finish if this one ran out of text.
    if (at < 0) return false;
    if (second < 0 || at < second) return true;
  }
  return false;
}

/** Two or more words typed together, as they would appear in a message. */
function phraseOf(terms: readonly Term[]) {
  const words = terms.filter((term) => !term.negate);
  if (words.length < 2) return undefined;
  return {
    text: words.map((term) => term.text).join(" "),
    caseSensitive: words.some((term) => term.caseSensitive),
    bonus: scoreMatch * words.length,
  };
}

/** The best score `matchTerms` can give these terms: each one whole, at the
 * start of a word after a space, and all of them together as typed. */
export function bestScore(terms: readonly Term[]) {
  let total = phraseOf(terms)?.bonus ?? 0;
  for (const term of terms)
    if (!term.negate)
      total +=
        term.text.length * scoreMatch +
        bonusBoundaryWhite * (bonusFirstCharMultiplier + term.text.length - 1);
  return total;
}

/** Scores `text` (with `lower`, its lowercase form) against every term, or
 * undefined when any fails. Negated terms add nothing. The words typed
 * together score higher, and are what's underlined. ponytail: single spaces
 * only; a line break between the words isn't a phrase. */
export function matchTerms(
  terms: readonly Term[],
  text: string,
  lower: string,
  positions?: number[],
): number | undefined {
  let total = 0;
  for (const term of terms) {
    const haystack = term.caseSensitive ? text : lower;
    const found = term.exact
      ? exactMatch(haystack, term.text, term.negate ? undefined : positions)
      : fuzzyMatch(haystack, term.text, positions);
    if (term.negate) {
      if (found !== undefined) return undefined;
      continue;
    }
    if (found === undefined) return undefined;
    total += found;
  }
  const phrase = phraseOf(terms);
  const at = phrase
    ? (phrase.caseSensitive ? text : lower).indexOf(phrase.text)
    : -1;
  if (phrase && at >= 0) {
    total += phrase.bonus;
    if (positions) {
      positions.length = 0;
      for (let i = 0; i < phrase.text.length; i++)
        if (phrase.text[i] !== " ") positions.push(at + i);
    }
  }
  return total;
}
