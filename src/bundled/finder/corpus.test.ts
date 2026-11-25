import { expect, test } from "vitest";
import { createCorpus, type FinderDoc } from "./corpus";

let next = 0;
const doc = (text: string, patch: Partial<FinderDoc> = {}): FinderDoc => ({
  id: `m${next++}`,
  channelId: "eng",
  authorId: "a",
  createdAt: next,
  author: "Maya Chen",
  place: "eng-infra",
  text,
  ...patch,
});
const texts = (
  corpus: ReturnType<typeof createCorpus>,
  query: string,
  add?: string,
) => {
  if (add) corpus.add([doc(add)]);
  return corpus.search(query).hits.map((hit) => hit.doc.text);
};

test("ranks word starts and runs above letters inside words", () => {
  const corpus = createCorpus();
  corpus.add([
    doc("an explanation is pending"),
    doc("the plan is pending"),
    doc("deploy looks good"),
    doc("draft a plan, look good"),
  ]);
  expect(texts(corpus, "plan")).toEqual([
    "draft a plan, look good",
    "the plan is pending",
    "an explanation is pending",
  ]);
  // Letters close together beat initials spread over a sentence.
  expect(texts(corpus, "dpl")[0]).toBe("deploy looks good");
  expect(texts(corpus, "zzz")).toEqual([]);
});

test("finds the words typed, not letters picked across a long message", () => {
  const corpus = createCorpus();
  corpus.add([
    doc("Yes, I'm here and responding. What do you need?"),
    doc(
      "Example TODOs [ ] Pick a small task to try with Pony. [ ] Share the doc",
    ),
    doc("\u201cI don't hold any shares myself, so back to work.\u201d", {
      author: "Peter",
    }),
    doc("we should deploy the rollback today"),
    doc("such as 13 replies in 5 minutes"),
    doc("so does Jerry share the solo chat"),
  ]);
  expect(texts(corpus, "any shares")).toEqual([
    "\u201cI don't hold any shares myself, so back to work.\u201d",
  ]);
  // Letters can still skip within a word and its neighbor, not a sentence.
  expect(texts(corpus, "shares")).toEqual([
    "\u201cI don't hold any shares myself, so back to work.\u201d",
  ]);
  expect(texts(corpus, "dplyrlbk")).toEqual([]);
  expect(texts(corpus, "dplyrlbk", "we should deploy rollback today")).toEqual([
    "we should deploy rollback today",
  ]);
});

test("words typed together rank first and are what's underlined", () => {
  const corpus = createCorpus();
  // Newer messages hold the same words apart; newest wins ties otherwise.
  corpus.add([
    doc("this one: can we delete this channel"),
    doc("delete it? this is a channel for drafts"),
    doc("this channel is where we delete old drafts"),
  ]);
  expect(texts(corpus, "delete this channel")[0]).toBe(
    "this one: can we delete this channel",
  );
  // Even when only one result is kept, the scan doesn't stop before it.
  const [hit] = corpus.search("delete this chan", 1).hits;
  expect(hit?.doc.text).toBe("this one: can we delete this channel");
  // Only the phrase, not the first "this".
  expect(hit?.positions).toEqual(
    [..."delete this chan"].flatMap((char, i) => (char === " " ? [] : 17 + i)),
  );
});

test("every term must match, in the text or who and where it was said", () => {
  const corpus = createCorpus();
  corpus.add([
    doc("rollback the canary", { author: "Sam Ortiz" }),
    doc("rollback finished"),
    doc("canary looks good", { place: "release" }),
  ]);
  expect(texts(corpus, "sam rollback")).toEqual(["rollback the canary"]);
  expect(texts(corpus, "canary release")).toEqual(["canary looks good"]);
  expect(texts(corpus, "rollback !canary")).toEqual(["rollback finished"]);
  expect(texts(corpus, "'nary")).toEqual([
    "canary looks good",
    "rollback the canary",
  ]);
});

test("a capital letter makes that term match case", () => {
  const corpus = createCorpus();
  corpus.add([doc("ask about the API"), doc("the api is slow")]);
  expect(texts(corpus, "API")).toEqual(["ask about the API"]);
  expect(texts(corpus, "api")).toHaveLength(2);
});

test("typing more narrows without missing messages added in between", () => {
  const corpus = createCorpus();
  corpus.add([doc("quarterly roadmap review")]);
  expect(texts(corpus, "road")).toHaveLength(1);
  corpus.add([doc("roadmap draft")]);
  expect(texts(corpus, "roadm")).toEqual([
    "roadmap draft",
    "quarterly roadmap review",
  ]);
  // Lengthening an exclusion matches more, not less.
  expect(texts(corpus, "roadmap !dr")).toEqual(["quarterly roadmap review"]);
  expect(texts(corpus, "roadmap !dra")).toEqual(["quarterly roadmap review"]);
  expect(texts(corpus, "roadmap !draz")).toHaveLength(2);
});

test("keeps the best hits, newest first among equals, and counts the rest", () => {
  const corpus = createCorpus();
  corpus.add(
    Array.from({ length: 80 }, (_, n) =>
      doc(`standup notes ${n}`, { createdAt: n }),
    ),
  );
  const results = corpus.search("standup", 10);
  expect(results.total).toBe(80);
  expect(results.hits.map((hit) => hit.doc.createdAt)).toEqual([
    79, 78, 77, 76, 75, 74, 73, 72, 71, 70,
  ]);
  expect(corpus.search("").hits[0]?.doc.createdAt).toBe(79);
});

test("removed channels stop matching", () => {
  const corpus = createCorpus();
  corpus.add([
    doc("secret plans", { channelId: "private" }),
    doc("public plans"),
  ]);
  expect(texts(corpus, "plans")).toHaveLength(2);
  corpus.remove((d) => d.channelId === "private");
  expect(texts(corpus, "plans")).toEqual(["public plans"]);
  expect(corpus.size).toBe(1);
});

test("channel searches narrow only within the same channel and reset on additions", () => {
  const corpus = createCorpus();
  corpus.add([
    doc("roadmap draft", { channelId: "design" }),
    doc("roadmap review", { channelId: "release" }),
    doc("roadmap done", { channelId: "design" }),
  ]);
  expect(corpus.search("road", 50, "design").total).toBe(2);
  expect(
    corpus.search("roadm", 50, "release").hits.map(({ doc }) => doc.text),
  ).toEqual(["roadmap review"]);
  expect(corpus.search("roadma").total).toBe(3);
  expect(corpus.search("", 1, "release").hits[0]?.doc.text).toBe(
    "roadmap review",
  );
  expect(corpus.search("", 1, "design").total).toBe(2);
  corpus.add([doc("roadmap ready", { channelId: "release" })]);
  expect(corpus.search("roadmap", 50, "release").total).toBe(2);
  expect(corpus.search("roadmap", 50, "missing").total).toBe(0);
});

test("underlines matched letters of the text by code point", () => {
  const corpus = createCorpus();
  corpus.add([doc("🚀 ship it")]);
  const [hit] = corpus.search("ship").hits;
  expect(hit?.positions).toEqual([2, 3, 4, 5]);
  expect(
    [...(hit?.doc.text ?? "")]
      .filter((_, i) => hit?.positions.includes(i))
      .join(""),
  ).toBe("ship");
});

/** Totals and hit ids for each prefix of `query` typed in turn on one
 * corpus, and for each prefix searched fresh. */
const typedAndFresh = (texts: readonly string[], query: string) => {
  const docs = texts.map((text) => doc(text));
  const typed = createCorpus();
  typed.add(docs);
  const result = (corpus: ReturnType<typeof createCorpus>, prefix: string) => {
    const { total, hits } = corpus.search(prefix);
    return { total, ids: hits.map((hit) => hit.doc.id) };
  };
  return [...query].map((_, n) => {
    const prefix = query.slice(0, n + 1);
    const fresh = createCorpus();
    fresh.add(docs);
    return { typed: result(typed, prefix), fresh: result(fresh, prefix) };
  });
};

test.each([
  ["azzzzzzzzzbcde", "abcde"],
  ["the documentation is out of date", "dtion"],
  ["performance regression in search", "pnce"],
])("typing %j letter by letter finds what pasting %j does", (text, query) => {
  const steps = typedAndFresh([text], query);
  for (const { typed, fresh } of steps) expect(typed).toEqual(fresh);
  expect(steps.at(-1)?.typed.total).toBe(1);
});

test("typed and pasted queries agree on hits and order", () => {
  const texts = [
    "the documentation is out of date",
    "performance regression in search",
    "we should deploy the rollback today",
    "setting up the action items for the meeting",
    "azzzzzzzzzbcde and a connection error",
    "a deployment of the docs went out",
  ];
  for (const query of [
    "dtion",
    "pnce",
    "tting",
    "ction",
    "dplyrlbk",
    "the dtion",
    "'out dat",
    "deploy !docs",
  ])
    for (const { typed, fresh } of typedAndFresh(texts, query))
      expect(typed).toEqual(fresh);
});
