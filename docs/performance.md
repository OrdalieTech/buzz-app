# Performance runs

`pnpm perf` measures how much browser work common actions cost: opening a
channel, scrolling, opening a thread, and keeping up with background traffic.
It drives the production app with the [browser test](browser-testing.md)
fixture, so the backend is modeled and local. It reports numbers; no case
fails on timing. CI runs every case once as a smoke check, without thresholds,
and `pnpm test` doesn't run them.

## Run

```sh
bin/pnpm test:browser:install   # once per Playwright version
bin/pnpm perf --scenario channel-open --repeat 5 --cpu 4 --out results.json
```

- `--scenario`: a case name, or a group that runs every case starting with it
  (`channel-open`, `scroll-paging`, `thread`, `thread-scroll`,
  `background-traffic`). Default `all`.
- `--repeat`: samples per case, default 5. Each sample starts from fresh
  storage and server state.
- `--cpu`: Chromium's CPU slowdown factor (1 is unthrottled). It doesn't
  throttle the network.
- `--browser webkit`: only for the `thread-scroll` cases. Everything else is
  Chromium only.

Each run writes to a fresh `test-results/perf/run-*` directory, or to `--out`.
The JSON has every sample and each metric's median, min and max. Only wholly
passing samples count toward the summary, so check each run's status and
errors before trusting a number.

## Cases

| Case | What it measures |
| --- | --- |
| `channel-open-cold` | Clicking a channel never opened or hovered |
| `channel-open-hover` | The same, after a 150ms hover head start |
| `channel-open-cold-markdown` | The cold case with Markdown-heavy messages |
| `scroll-short` | 800px upward within the loaded head of a 120-message channel |
| `scroll-long` | 12,000px upward through 360 fully loaded messages |
| `scroll-paging-fast` | Scrolling to the oldest of 640 messages while older pages arrive after 100ms |
| `scroll-paging-delayed` | The same with 500ms page delays |
| `scroll-paging-delayed-short` | The delayed case with one- and two-line messages |
| `scroll-paging-fast-keyboard`, `-markdown`, `-first-seen` | The fast case in keyboard modality, with Markdown messages, or with older pages the app hasn't verified yet |
| `thread-open-rich`, `-close-rich`, `-reopen-rich` | A 120-reply thread with media, tables and code |
| `thread-unread-open-60`, `-200` | Opening a thread whose 60 or 200 replies are all unread |
| `thread-scroll-open`, `-fling`, `-reverse` | The [long-thread workload](#thread-scrolling) |
| `background-traffic` | Reading one channel while 30 others get a message every 200ms for 30 seconds |
| `background-traffic-large-sidebar` | The same, with 128 DMs and 1,001 participants |

A case that can't finish its work (paging stalls, or the expected messages
never arrive) fails instead of reporting a fast time.

## Metrics

| Metric | Meaning |
| --- | --- |
| `firstRowsMs` | Click to the target's rows on screen |
| `durationMs` | Wall time until the timeline's layout stops changing for 200ms |
| `scriptMs`, `layoutMs`, `styleMs`, `taskMs` | Chromium's JavaScript, layout, style and main-thread task time |
| `loafBlockingMs` | Long-animation-frame blocking time, from every frame that overlaps the action |
| `rafP95GapMs`, `rafMaxGapMs`, `rafGapsOver33`, `rafGapsOver50` | Animation-frame spacing during a scroll gesture |
| `edgeWaitMs` | Paging time spent held at the top edge, waiting for older history |
| `domGapFrames` | Thread scroll frames with no loaded reply in view |
| `idleTaskMsPerSec`, `trafficTaskMsPerSec`, `taskMsPerMessage` (and script, style and layout per message) | Background traffic cost |
| `heapGrowthKBPerMessage`, `nodesDelta`, `listenersDelta` | Background traffic growth, measured after a forced GC |

The task categories overlap, so don't add them up or read them as CPU
percentages. Frame gaps show main-thread stalls, not compositor frame rate.
The browser build verifies signatures in JavaScript, which the desktop app does
natively, so per-message script time runs higher here.

## Compare a change

Keep one scenario and setting, save the baseline JSON, make one change and
rerun. On an idle machine, alternate baseline and candidate runs before claiming
a win, and run the correctness tests too. Results from different CPU settings,
browsers or machines aren't comparable. If a case's definition changed between
the two commits, collect a new baseline.

## Thread scrolling

`thread-scroll` scrolls a 460-reply weekly-update thread from 40 authors, with
every page loaded first. Chromium scrolls threads off the main thread, so its
frame spacing stays smooth even when compositing is slow; read its counters
instead. `--browser webkit` shows those stalls in frame spacing, but has no
counters, CPU throttling or real gesture timing. Neither shows trackpad momentum
or painted pixels: `domGapFrames` can read zero while the macOS app shows blank
regions. For that, use the native run below.

### Thread scrolling targets

For the 460-reply thread in the macOS app, with every reply loaded, on a 60 Hz
display. A run is two upward trackpad flings with a reversal, then Jump to
latest. The targets are advisory.

| While scrolling the loaded thread | Target | Ceiling |
| --- | --- | --- |
| 95th-percentile frame interval | 16.7 ms (60 fps) | 33 ms |
| Frames longer than two 60 Hz frames, per run | 0 | 5 |
| Captured frames with a blank band (35% of the pane or more), per run | 0 | 5 |

The target is the goal. The ceiling is the line a regression must not cross
while the target is out of reach.

### Native thread scrolling

This runs the same workload in the macOS desktop app and records the pane on
video. It runs locally, not in CI.

```sh
bin/node scripts/perf/thread-native/run.mjs --arms base=origin/main,head=worktree --runs 4
```

Each arm is a revision; `worktree` means the current files. Runs alternate
between arms (ABBA) over one Rust build.

Before you start:
- It needs a logged-in macOS session, Screen Recording and Accessibility
  permission for the terminal, an idle machine and the main display at 60 Hz.
- It places the window at the `1504×916` reference size when the main display's
  usable area holds it, and otherwise fits it to the display (minimum
  `1280×700` usable) for within-run ABBA comparisons.
- It opens a real Buzz window, takes over the pointer with synthetic trackpad
  gestures, and records the screen. Don't use the computer while it runs.
- It signs with an ephemeral fixture key, but shares the Keychain and plugin
  data with other development builds.
- An interrupted run can leave a temporary checkout; `git worktree prune` and
  deleting its `buzz-thread-native-*` temporary folder clean it up.

`summary.md` in the results folder gives each metric's median and range per
arm against the targets, with per-run JSON and videos beside it. Compare arms
within one run, not across machines or sessions.

| Metric | Meaning |
| --- | --- |
| `gapP95Ms`, `gapMaxMs` | Time between animation frames |
| `framesOver33` | Frame intervals longer than two 60 Hz frames |
| `droppedFrames` | Frames missed across those intervals |
| `blankFrames`, `longestBlankMs` | Captured frames with a blank band over at least 35% of the pane, and the longest run of them |

### Current measurements

Native medians on one Apple silicon macOS VM with a 60 Hz display (`1920×1200`,
1×), four ABBA runs per build in one session (2026-11-24). Each change that
moves these numbers adds its row.

| Build | p95 frame interval | Frames over two 60 Hz frames | Dropped frames | Blank frames | Longest blank |
| --- | --- | --- | --- | --- | --- |
| 2026-11-05 (`83c48be0aa`, before scrolling fixes) | 88 ms | 77 | 208 | 48 | 233 ms |
| 2026-11-24 (`20c9e4c154`, `main`) | 31 ms | 12 | 27 | 0 | 0 ms |
