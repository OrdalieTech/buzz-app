// Finder search timing on synthetic history. Run from the repository root:
//   bin/node scripts/perf/finder/bench.ts [messages=200000]
// Prints the median and slowest time per keystroke for each query, typed one
// key at a time (the real case) and searched cold (the worst case).
import { createCorpus } from "../../../src/bundled/finder/corpus.ts";
import { syntheticDocs } from "../../../tests/fixtures/finder-synthetic.ts";

const size = Number(process.argv[2] ?? 200_000);
const docs = syntheticDocs(size);
globalThis.gc?.();
const heap = process.memoryUsage().heapUsed;
let started = performance.now();
const corpus = createCorpus();
corpus.add(docs);
const built = performance.now() - started;
globalThis.gc?.();
console.log(
  `${size} messages: built in ${built.toFixed(0)} ms, ` +
    `${((process.memoryUsage().heapUsed - heap) / 1e6).toFixed(0)} MB heap`,
);

const queries = [
  "d",
  "dep",
  "deploy rollback",
  "maya canary relay",
  "dplyrlbk",
  "neovim telescope",
  "'p99 !prod",
];
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    (
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    ).toFixed(2);
  return `median ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`;
};
const reset = () => corpus.add([docs[0] as (typeof docs)[number]]);

// Warm up the JIT.
for (let n = 0; n < 5; n++)
  for (const q of queries) {
    reset();
    corpus.search(q);
  }

for (const query of queries) {
  const cold: number[] = [];
  const typed: number[] = [];
  let total = 0;
  for (let round = 0; round < 7; round++) {
    reset();
    started = performance.now();
    total = corpus.search(query).total;
    cold.push(performance.now() - started);
    reset();
    for (let n = 1; n <= query.length; n++) {
      started = performance.now();
      corpus.search(query.slice(0, n));
      typed.push(performance.now() - started);
    }
  }
  console.log(`${JSON.stringify(query)} (${total} matches)`);
  console.log(`  cold:  ${stats(cold)}`);
  console.log(`  typed: ${stats(typed)} per key`);
}
