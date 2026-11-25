# Instructions for agents

[CONTRIBUTING.md](CONTRIBUTING.md) has setup, commands and the source layout.
These rules add what agents need on top of it.

## How to work

- Every PR must leave a functioning main, we can release at any time. So make
  PRs the smallest complete change that solves the task.
- Run focused tests for what you changed. The git hooks own formatting, lint,
  type checks and related tests, and CI runs everything. Run a full suite
  locally only when asked or to reproduce a CI failure.
- To reproduce or record UI behavior, use the headless browser fixture in
  `tests/browser/` with video on. Don't launch native desktop builds unless the
  human asks.

## Worktrees

Create every worktree from a freshly fetched main, then bootstrap it before
doing anything else:

```sh
git fetch origin main
git worktree add <path> -b <branch> origin/main
<path>/scripts/bootstrap-worktree.sh <absolute path of the checkout you came from>
```

Never use `git stash`; worktrees share one stash list.

## Product rules

- **Plugins first.** A new public feature that fits the plugin API starts as a
  plugin in [buzz-plugins](https://github.com/block/buzz-plugins). Bundling a
  plugin here needs a core maintainer's agreement each time. When turning a
  shipped plugin off by default, follow [plugin defaults](docs/plugin-defaults.md).
- **Help guide.** When a change makes a significant product change, update
  [the help guide](docs/buzz-help.md). Agents answer product questions from it,
  so keep it short.
- **UI.** Read the [design guide](src/shared/design-system/DESIGN.md) before
  any UI change. Use shared components, tokens and Tabler icons from
  `src/shared/design-system/icons`; don't restyle shared controls locally.
- **Hosts.** Product logic lives once in `src/features/`. The desktop and
  browser hosts own only I/O and secrets.
- **Relay load.** Every client reconnects at once after a relay restart, so
  design relay paths for the whole fleet.
- **Agent tools.** The tools in `src/buzz-mcp/` are the reference interface for
  every Buzz agent, local and remote, so change them deliberately. Prefer many
  small tools with real schemas to one tool with an action argument, and put
  guidance that spans tools in the server instructions, not tool descriptions.

## Tests

Tests cost time on every push, in CI and in every agent's context. Keep a test
only if it would pass after a clean rewrite with the same behavior, and its
failure would mean a real break: a broken contract (wire formats, saved data
and migrations, permissions, data loss) or something a user would see.

Don't write these, and delete them when you find them:

- How the UI looks: colors, sizes, spacing, classes, computed styles. Test what
  the user can do and see.
- Which internal functions ran, with what arguments, or in what order. Check
  calls only at real boundaries (relay, network, OS, storage).
- Source text, imports, structure or exact copy.
- Tests that mostly check their own mocks.
- Near-identical cases, or a behavior already tested elsewhere. Keep the
  cheapest one.
- Edge cases no user has hit.
- Private helpers that the public behavior already covers.

When you fix a bug, extend an existing test before adding one. When behavior
changes, delete the old behavior's tests; don't bend them to fit.

How to write them:

- Use the cheapest layer that can see the failure. Default to a Vitest test
  next to the code, with React Testing Library for components. Don't mock React
  hooks. Use a browser journey only for what needs a real browser.
- Never hide a flake with retries, longer timeouts or looser assertions. Find
  whether the product, the fixture or the test is wrong, and fix that.

## Open source

This repository is public, and every feature must work for any community or
distributor. Never commit anything that only makes sense for a specific organization,
or refer to internal company context.

Company or community specific behavior belongs in a private plugin. A host change
made for one must be a general extension point that any plugin author could use,
and must never name or special-case a specific plugin or organization.

The same goes for issues, PR text, commit messages and reviews: no quotes,
links or attributions from internal discussions.

## Commits and PRs

Sign off every commit with `git commit --signoff`. An agent committing as its
human adds a `Co-authored-by` trailer for itself, and an agent committing as
itself credits its human.

## Inspect a live agent session

To debug an agent conversation, open its live viewer for the human and leave it
running:

```sh
bin/node scripts/session-debug.mjs '<Buzz thread ID or link>'
```
