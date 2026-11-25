import type { FinderDoc } from "../../src/bundled/finder/corpus.ts";

/** A repeatable, realistic-looking message history for benchmarks and the
 * fixture page: the same seed always gives the same messages. */
export function syntheticDocs(count: number, seed = 1): FinderDoc[] {
  let state = seed >>> 0;
  // mulberry32
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Word frequency falls off like real text: a few words are everywhere.
  const pick = <T>(items: readonly T[], skew = 1.6) =>
    items[Math.floor(items.length * random() ** skew)] as T;
  const first =
    "Maya Sam Priya Jordan Wes Alex Noah Lena Omar Kai Rosa Theo Ines Ravi Zoe Ben Ada Luis Mei Femi".split(
      " ",
    );
  const last =
    "Chen Ortiz Patel Kim Okafor Novak Silva Haddad Berg Tanaka Moreau Reyes Ivanova Mensah Brooks".split(
      " ",
    );
  const people = Array.from({ length: 240 }, (_, n) => ({
    id: `p${n}`,
    name: `${first[n % first.length]} ${last[(n * 7) % last.length]}`,
  }));
  const places = [
    ...Array.from(
      { length: 180 },
      (_, n) =>
        `${pick(["eng", "team", "proj", "help", "ops", "design"], 1)}-${pick(
          [
            "infra",
            "payments",
            "mobile",
            "relay",
            "growth",
            "search",
            "release",
            "oncall",
            "billing",
            "identity",
            "desktop",
            "web",
          ],
          1,
        )}${n > 11 ? `-${n}` : ""}`,
    ),
    ...people.slice(0, 60).map((person) => person.name),
  ];
  const words = (
    "the a to and of is it that for on we this in you be with can I but not so just " +
    "deploy rollback canary release build test flaky merge review approve ship staging prod " +
    "relay channel thread message reaction search index cache latency p99 timeout retry backoff " +
    "migration schema postgres query plan dashboard alert oncall incident postmortem fix bug " +
    "design figma mockup spacing token theme dark light modal dialog sidebar shortcut keyboard " +
    "meeting tomorrow today friday sync agenda notes doc proposal roadmap quarter okr goal " +
    "customer feedback support ticket escalation rollout flag experiment metric conversion " +
    "think maybe probably sounds good thanks lgtm nice yeah agreed wait actually hmm " +
    "websocket reconnect cursor jitter fleet load budget memory heap worker benchmark fzf " +
    "telescope neovim plugin manifest bundle typescript rust tauri webkit chromium linux macos"
  ).split(" ");
  const now = 1_790_000_000;
  return Array.from({ length: count }, (_, n) => {
    const author = pick(people, 1.3);
    const length = 3 + Math.floor(40 * random() ** 2);
    const text = Array.from({ length }, () => pick(words)).join(" ");
    return {
      id: `m${n}`,
      channelId: pick(places, 1.2),
      authorId: author.id,
      createdAt: now - Math.floor(random() * 90 * 86_400),
      author: author.name,
      place: pick(places, 1.2),
      text: random() < 0.1 ? `@${pick(people).name} ${text}` : text,
    };
  });
}
