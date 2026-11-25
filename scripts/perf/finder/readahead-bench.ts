// How often the message you're looking for is already in the index, with and
// without reading ahead in the channels you visit most. Run from the
// repository root:
//   bin/node scripts/perf/finder/readahead-bench.ts [messages=60000]
// A model, not a measurement: a 60-channel community and a person who visits
// a few channels much more than the rest, searching mostly for recent
// messages in the channels they pay attention to.
import { registerHooks } from "node:module";

// The app's imports leave off ".ts"; Node needs it.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      return next(`${specifier}.ts`, context);
    }
  },
});
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
const { noteInterest, topInterest } = await import(
  "../../../src/bundled/finder/interest.ts"
);

let state = 7;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const zipf = (count: number, s: number) => {
  const weights = Array.from({ length: count }, (_, n) => 1 / (n + 1) ** s);
  const sum = weights.reduce((a, b) => a + b);
  return weights.map((w) => w / sum);
};
const sample = (weights: readonly number[]) => {
  let r = random();
  for (const [n, w] of weights.entries()) {
    r -= w;
    if (r <= 0) return n;
  }
  return weights.length - 1;
};
const shuffled = <T>(items: T[]) => {
  for (let n = items.length - 1; n > 0; n--) {
    const m = Math.floor(random() * (n + 1));
    [items[n], items[m]] = [items[m] as T, items[n] as T];
  }
  return items;
};

const CHANNELS = 60;
const DAYS = 90;
const TOTAL = Number(process.argv[2] ?? 60_000);
const PAGE = 500;
/** What the app already loaded for a channel opened today. */
const HEAD = 50;
/** Your messages, mentions and threads you replied in, per channel. */
const OWN = 0.09;
const day = 86_400;
const now = 1_800_000_000;
const scope = "https://relay.example.org:viewer";

// Traffic and attention are uneven and only loosely related: the busiest
// channel is not always the one you read.
const volume = shuffled(zipf(CHANNELS, 1.1)).map((w) => Math.round(w * TOTAL));
const attention = zipf(CHANNELS, 1.0);
const order = shuffled(Array.from({ length: CHANNELS }, (_, n) => n));
const want = Array.from(
  { length: CHANNELS },
  (_, n) => attention[order.indexOf(n)] ?? 0,
);

// Four weeks of visits, 30 a day.
const today = new Set<number>();
for (let d = 27; d >= 0; d--)
  for (let v = 0; v < 30; v++) {
    const channel = sample(want);
    noteInterest(scope, `c${channel}`, 1, now - d * day + v * 600);
    if (d === 0) today.add(channel);
  }

const SEARCHES = 200_000;
const targets = Array.from({ length: SEARCHES }, () => {
  const channel = sample(want);
  // Mostly recent: half are from the last week.
  const age = Math.min(DAYS, -Math.log(1 - random()) * 10);
  // Position counted from the channel's newest message.
  return {
    channel,
    position: Math.floor(((volume[channel] ?? 0) * age) / DAYS),
    own: random() < OWN,
  };
});

const coverage = (channels: number, pages: number) => {
  const warmed = new Set(
    topInterest(scope, channels, now).map((id) => Number(id.slice(1))),
  );
  let found = 0;
  for (const { channel, position, own } of targets)
    if (
      own ||
      (today.has(channel) && position < HEAD) ||
      (warmed.has(channel) && position < pages * PAGE)
    )
      found++;
  const reads = [...warmed].reduce(
    (sum, c) => sum + Math.min(pages, Math.ceil(((volume[c] ?? 0) + 1) / PAGE)),
    0,
  );
  const docs = [...warmed].reduce(
    (sum, c) => sum + Math.min(pages * PAGE, volume[c] ?? 0),
    0,
  );
  return { found: (100 * found) / SEARCHES, reads, docs };
};

console.log(
  `${CHANNELS} channels, ${TOTAL.toLocaleString()} messages in ${DAYS} days, ` +
    `${today.size} opened today`,
);
console.log("channels  pages  already indexed  reads  messages added");
for (const [channels, pages] of [
  [0, 0],
  [8, 1],
  [8, 2],
  [16, 1],
  [16, 2],
  [24, 1],
  [32, 1],
] as const) {
  const { found, reads, docs } = coverage(channels, pages);
  console.log(
    `${String(channels).padStart(8)}  ${String(pages).padStart(5)}  ` +
      `${found.toFixed(1).padStart(14)}%  ${String(reads).padStart(5)}  ` +
      `${docs.toLocaleString().padStart(14)}`,
  );
}
