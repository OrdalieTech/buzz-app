# Finder

You often remember a piece of a conversation, a name, or a word someone used,
but not which channel or thread it was in. The finder lets you search for those
pieces directly. Press ⌘P (Ctrl+P on Windows and Linux) to search the channel
you're in, or ⌘⇧P (Ctrl+Shift+P) to search all of Buzz. Type a few letters and
see matching messages as you type, with a preview of each one in context.
Press Enter to jump to the message.

It works like [fzf](https://github.com/junegunn/fzf) or Neovim's
[Telescope](https://github.com/nvim-telescope/telescope.nvim): letters don't
have to be next to each other, so `dplyrlbk` finds "deploy rollback".

## Status

The finder is off by default. Enable it in Settings → Plugins.

| Part | State |
| --- | --- |
| Matching and ranking (`match.ts`, `corpus.ts`) | Done, with tests and a benchmark |
| The dialog (`FinderDialog.tsx`) | Done, tried on a fixture page with fake data |
| ⌘P and ⌘⇧P in the app (`index.tsx`) | Done; the plugin is off until you enable it |
| Filling the index from your account (`sync.ts`) | Done; channel paging has tests |
| This channel | Done, with older history read as needed |
| All of Buzz | Done: this device at once, then the relay after a typing pause |
| Reading ahead in the channels you use most | Done, with tests and a model of how much it finds |
| Saving the index between launches | Not started: it is rebuilt each launch |
| Clear cache empties the index | Not yet: it empties on restart or sign-out |
| Edited messages | Not yet: the finder shows the original text |
| A commands list (run any Buzz shortcut) | Not started: Buzz can't run a shortcut by its ID yet |

## The two searches

| Key | Searches |
| --- | --- |
| ⌘P (Ctrl+P) | **This channel**, when a conversation is open. Elsewhere, **All of Buzz**. It works while you type. |
| ⌘⇧P (Ctrl+Shift+P) | **All of Buzz**. Not while typing in a text field, where it's Spoiler formatting. |

The switch under the search field changes between them, and so does pressing
the other key while Finder is open. The text you typed stays when you switch.
Closing Finder clears it, so each opening starts empty. Change both keys in
Settings → Shortcuts.

- **This channel** fuzzy-searches only that channel. With fewer than 20
  matches, it reads older messages in pages of 500, up to 5,000 per opening.
  **Keep going** allows another 5,000. It shows how far back it searched, or
  when it searched the whole channel. Closing or switching stops the read.
  Reopening resumes where it left off. Join a public preview before searching
  its history here.
- **All of Buzz** shows matches from this device at once. After a short pause
  in typing, with at least three letters in the last word, it also asks the
  relay, which searches every message you can read, including public channels
  you haven't joined. Those hits appear below, under **More from all of Buzz**,
  ranked the same way. Rows you're looking at never move: once relay rows show,
  the device rows above them hold still until you change the text. Relay rows
  for earlier text clear as soon as you change it, so Enter can't open one
  while the new search loads. Use **Retry** after a failed read, or **More
  messages** for the next page.

Older channel messages stay in the index for this session. Relay hits from
joined channels join it when you close Finder. Public previews stay out; their
access is checked on each read.

## How to search

- Words are separate searches that must all match: `maya canary` finds messages
  with both. A word can match the message, the person who wrote it, or the
  channel it was in.
- `'word` matches those exact letters together.
- `!word` leaves out messages containing `word`.
- A capital letter makes that word match case: `API` won't match "api".
- With nothing typed, the finder lists your newest messages.

Results are scored the way fzf scores them: letters at the start of a word,
and letters next to each other, score higher. Words typed together score
higher still when the message has them together, so "delete this channel"
finds that phrase before messages that only mention each word. Ties go to the
newer message.

Matching differs from fzf in two ways, because chat messages are long
sentences, not file names:

- **Words you type whole are found whole.** If a word appears exactly as
  typed, that occurrence is scored, choosing the best one (a word start beats
  the middle of a word).
- **Letters must stay close together.** Otherwise one word's letters have to
  fit within about three times its length and cross at most one space.
  `dplyrlbk` still finds "deploy rollback", but `any` can't be stitched
  together from "**a**nd", a later "**n**", and "**y**ou". Type two words
  (`dpl rlbk`) to match letters further apart.

## What it searches

The index starts with three sources:

- **Your own conversations** from the last 90 days, read from the relay when
  the finder starts: messages you wrote, threads you replied in, direct
  messages, and messages that mention you.
- **The channels you use most.** After that first read, the finder reads the
  newest 500 messages of up to 16 channels you visit and search most. See
  [Reading ahead](#reading-ahead).
- **Everything else Buzz receives from channels you're in** while it's open:
  new messages as they arrive, and older ones as you scroll past them. These
  cost no extra relay reads; the app already fetched them.

Channels you haven't joined, which you can preview, stay out.

The index lives in memory on this device. It is never sent anywhere. Scoped
searches can add older messages. A reconnect keeps it. Signing out, being
refused by the community, or switching to another account or community drops
it. **Clear cache** doesn't; restarting does. When you lose access to a
channel, its messages leave the index; if you rejoin it, the next reconnect
reads your history in that channel again. A deleted message leaves the index
too, and stays out if a later read brings it back.

## How it stays current

The first time it runs, the finder reads your history from the relay in pages
of 500, newest first, until it reaches 90 days back. Every read waits at least
300 ms after the one before, between pages and between filters.
That happens once per launch, followed by the read-ahead. After a reconnect it
reads only what is newer than its last read, from 5 minutes before it, then any
older pages the first read hadn't reached: usually one page for each of your
messages, mentions, direct-message and thread reads. Channels already read
ahead get only what is newer than their last read, the same way. After that it
adds messages the app already receives while it's open, plus messages found in
the two scopes.
It does not poll.

Because the first fill can read a lot of messages, the plugin starts **off** for now. That
lets us measure the first fill on real accounts before it reaches everyone.

## Reading ahead

Most of the time, what you're looking for was said recently, in a channel you
keep going back to. Your own messages don't cover that, and the app only loads
the newest messages of a channel when you open it. So the finder keeps track
of which channels you use:

- Opening a channel counts 1.
- Searching it with **This channel**, or opening a message from Finder, counts 2.
- Older activity counts for less: a visit is worth half as much a week later.

These counts stay on this device, kept apart for each community and account,
like ⌘K's recent searches. They hold channel IDs and numbers, no message
text. Leaving the community, or signing out and wiping this device's data,
removes them.

When the finder starts, after reading your own conversations, it reads the
newest page (500 messages) of each of your top 16 joined channels, one page
every 300–600 ms. That is at most 16 background reads per session. **This
channel** later continues from where the read-ahead stopped, so no page is read
twice.

Why 16 channels one page deep, and not fewer channels read deeper: most
searches are for recent messages, so a second page of a channel finds much less
than a first page of another channel. `bin/node scripts/perf/finder/readahead-bench.ts <messages>`
models a 60-channel community and someone who visits a few channels much more
than others. The share of searches whose message is already indexed when you
start typing:

| Messages in 90 days | No read-ahead | 8 channels × 2 pages | 16 channels × 1 page |
| --- | --- | --- | --- |
| 20,000 | 54% | 69% | 76% |
| 60,000 | 37% | 66% | 74% |
| 200,000 | 21% | 58% | 61% |

It's a model: real numbers depend on how you use Buzz. It does show the shape.
Reading ahead roughly doubles what's already there in a busy community, and
spreading the same reads over more channels beats reading deeper.

The read-ahead adds at most 8,000 messages. For a 25,000-message index, that
is about 4 MB more memory and a little over 1 ms more per keystroke.

The counts start empty, so the first session after you turn Finder on reads
ahead nothing. They build up as you use Buzz.

## How fast it is

Each search scans every indexed message. Three things keep that fast:

1. **A letter check first.** Each message stores which letters it contains as
   a 32-bit number. A message missing any letter you typed is skipped without
   reading its text.
2. **Newest first, and stop scoring early.** Messages are kept oldest to newest
   and scanned from the end. Once the top 50 results all have the best possible
   score, no older message can beat them, so the rest only get a quick yes/no
   check (for the match count).
3. **Typing more searches less.** When the new query is the old one plus more
   letters, only messages whose letters were still in order, within two
   neighboring words, are checked again. A message that missed only because its
   letters were too far apart stays in that list, since a longer query allows
   them to spread further, so typing and pasting find the same messages.

Timings for one keystroke, typed one letter at a time, on synthetic history
(`bin/node scripts/perf/finder/bench.ts <messages>`). The synthetic history uses
a small vocabulary, so far more messages match each word than in real
conversations. Treat these as worst cases.

| Messages | Memory | Typed key, median by query | Slowest query, cold (median) |
| --- | --- | --- | --- |
| 25,000 | 10 MB | 1–4 ms | 5 ms |
| 50,000 | 20 MB | 2–10 ms | 11 ms |
| 200,000 | 81 MB | 8–44 ms | 56 ms |

Measured on a Linux workstation.
A screen frame is 16 ms, so up to about 50,000 messages it keeps up with typing.
Next steps for larger histories are searching in a background worker (so typing
never waits) and splitting the search across several workers.

## Code

| File | What it does |
| --- | --- |
| `src/bundled/finder/match.ts` | fzf's matching and scoring, ported to TypeScript |
| `src/bundled/finder/corpus.ts` | The in-memory index and search. No UI, so other tools can use it |
| `src/bundled/finder/FinderDialog.tsx` | The dialog, built from the same parts as ⌘K search |
| `src/bundled/finder/search.ts` | What the dialog shows: device matches, older pages of one channel, and relay hits merged below |
| `src/bundled/finder/sync.ts` | Fills the index and keeps it current, including the read-ahead |
| `src/bundled/finder/interest.ts` | Which channels you use most |
| `scripts/perf/finder/bench.ts` | The search benchmark |
| `scripts/perf/finder/readahead-bench.ts` | The read-ahead model |
| `tests/fixtures/finder.html` | The dialog on fake data, for trying it without an account |

The matcher is ported from fzf, which is MIT licensed. Its license is in
[NOTICE.md](../NOTICE.md).

## Trying it

Run the fixture page from the repository root:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1461
```

Open `http://127.0.0.1:1461/tests/fixtures/finder.html`. Add `?extra=200000`
to search 200,000 more synthetic messages, and `&theme=dark` for dark mode.

Use `?channel=c0` to make **This channel** available; it opens there. Search
for `quartz` to find notes among 3,000 signed messages; only the newest 300
start in the index. Try a word with no matches to reach the end. Use
`?channel=c0&history=6000` with a word that has no matches to reach the
5,000-message cap and try **Keep going**. Choose **All of Buzz** in the switch,
or press ⌘⇧P, to see device matches with relay hits below them.
