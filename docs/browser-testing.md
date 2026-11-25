# Browser tests

The journeys in `tests/browser/` drive the real app, built in production mode,
in headless Chromium and WebKit. Each test gets a fresh local server, ephemeral
keys, signed fixture history and fresh browser storage. Nothing opens a native
window, reads the Keychain or writes to a real relay, so this is also the place
to reproduce a bug or record a video of one.

## Run

```sh
bin/pnpm test:browser:install                     # once per Playwright version
bin/pnpm test:browser tests/browser/layout.spec.mjs --no-deps   # one file
bin/pnpm test:browser                             # everything, both engines
bin/pnpm test:browser:ci                          # what Linux CI runs
```

Use `--no-deps` for focused runs; without it, Playwright runs the measurement
projects first (see below). Add `--project chromium` or `--project webkit` to
pick one engine. Tests never retry.

Results go to `test-results/browser/`: failure screenshots and traces, plus an
`evidence.json` per test with versions, the request log, runtime errors and any
measurements. Each run replaces the last one's output, so copy anything you
want to compare first.

**WebKit trace screenshots on macOS.** Local WebKit traces leave out the
screenshot filmstrip, because macOS leaks the surfaces WebKit uses for them and
crashes the login session after about 1,000 traced WebKit tests.
`BUZZ_WEBKIT_TRACE_SCREENSHOTS=1` turns them back on for one diagnostic run.
Never use it in a loop or with `--repeat-each`; the leak lasts until you log
out. CI keeps the filmstrip.

## Write a test

- Import `test` and `expect` from `fixture.mjs` for whole-app journeys.
- Choose the history you need with `test.use({ historyCounts: { alpha: 1, beta: 0 } })`
  (messages per community). Leave existing pagination and measurement datasets
  alone unless you revalidate them.
- To record a video, add `video: "on"` to `test.use`. It lands in the test's
  folder under `test-results/browser/`.
- For a standalone page under `tests/fixtures/`, import from
  `source-fixture.mjs` instead. For a server with its own middleware, use
  `vite-server.mjs`.
- Unexpected network requests, console errors and page errors fail the test.
- Fixture builds enable Channel Settings → Diagnostics by default. Set
  `diagnostics: false` to exercise release behavior. Except with `developmentReact`,
  builds check that Diagnostics-only text is present when enabled and absent
  when disabled; keep `DIAGNOSTICS_LABELS` in `tests/browser/build.mjs` current.

**Vite gotchas:**
- Import `build` and `preview` from `vite-server.mjs`, not from `vite`. Vite
  changes `NODE_ENV` for the rest of the worker, and later fixture servers then
  rebuild their dependencies mid-test.
- Fixture plugins can only add middleware or rewrite index HTML, and can't set
  `optimizeDeps`. If a test imports a dependency no fixture page reaches, add it
  to `fixtureOptimizeDeps.include` in `vite-server.mjs`. Otherwise the page can
  come up blank with a 504 `Outdated Optimize Dep`.

## Tags that change where a test runs

| Tag | Where it runs |
| --- | --- |
| `@local-webkit` | Locally only in WebKit; Chromium still runs it in CI. Run these with `bin/pnpm test:browser:local-only`. |
| `@local-only` | Locally only in both engines (the 50,000-record storage scale case). |
| `@media-recorder` | WebKit's copy runs in the macOS CI job, because the Linux WebKit build has no media recorder. |
| `@classic-scrollbars` | Only in the `chromium-classic-scrollbars` project. On a Mac, set `BUZZ_CLASSIC_SCROLLBARS=1` and turn on always-visible scroll bars, or these skip. |

Don't add a tag to get a red test out of CI. Fix the product, fixture or test.
Before removing `@local-webkit` from a case, check it passes repeatedly on Linux
WebKit.

## Measurements

`channel-opening.spec.mjs` and `scroll.spec.mjs` measure timing and DOM size, so
they run first and alone: Chromium, then WebKit, then the functional journeys
with two workers. A measurement failure skips the later phases. To run every
project regardless, use `bin/pnpm test:browser --no-deps --workers=1`. To
repeat measurements, use
`bin/pnpm test:browser --project '*-measurements' --no-deps --workers=1 --repeat-each=3`;
plain `--repeat-each` doesn't repeat them.

## CI

CI runs one serial measurement job, the functional journeys sharded across
Linux runners per engine, and the `@media-recorder` WebKit cases on macOS.
Functional journeys use three workers on eight-core PR runners and two on
standard runners. Measurements remain serial. To reproduce a denser functional
run locally, use `BUZZ_BROWSER_WORKERS=3 bin/pnpm test:browser:ci --project chromium --no-deps`
(or `--project webkit`).
`CI required` fails if any of them fails, is skipped or is cancelled. An
integration test checks that the shards cover every functional test exactly
once, so update it with the matrix. For slow-test runs, see
[performance](performance.md).
