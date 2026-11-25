# Inspect an agent session

Use this to see what an agent running in Buzz was given, what it did and where
its time went. Run every command on the machine that runs the agent, from a
buzz-app checkout. None of them resume the agent, run tools or send anything to
a relay.

## Live viewer (Codex and Claude)

```sh
bin/node scripts/session-debug.mjs '<Buzz thread ID or buzz://message link>'
```

This opens a private local page in your browser and follows the transcript as
the agent writes it. Leave the command running; Ctrl+C stops it.

- `--file /absolute/path/session.jsonl` opens a known transcript. Use it for
  channel-scoped sessions and DMs, which the thread search may not find.
- `--no-open` prints the URL without opening a browser.
- `--rates rates.json` adds dollar estimates. Without it, costs show as tokens.

When several sessions answered the same thread, a picker lists them by agent
and harness, newest first.

**Reading the view:**
- The left rail is the session's wall time, top to bottom: inference, tools,
  and **unattributed** time when a run was active but nothing was recorded.
  Waits between runs collapse to a labeled break.
- Inference times are estimates. Transcripts don't record when a request
  started, so a bar runs from the previous input to the model's output, and
  can include queueing.
- Each inference shows new input, cache read, cache write and output tokens.
- On the right, **Prompt** opens what the model received first: the system
  prompt, other instructions and each tool's schema. Messages the agent posted
  to Buzz are highlighted; other assistant text was never sent.

A rates file maps each exact model ID to USD per million tokens, with all four
rates. Nothing is guessed when a model is missing.

```json
{"your-model-id": {"input": 2, "output": 10, "cached": 0.2, "written": 2.5}}
```

## Where transcripts live

- **Codex:** `<codex-home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, and
  `archived_sessions/` beside it. Buzz's Codex home is
  `~/Library/Application Support/Buzz/codex-home` on macOS and
  `${XDG_DATA_HOME:-~/.local/share}/buzz/codex-home` on Linux. Threads from older
  Buzz builds are in `${CODEX_HOME:-~/.codex}`. Decompress `.jsonl.zst` files
  before opening them with `--file`.
- **Claude:** `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project>/<session>.jsonl`,
  where `<project>` is the agent's working directory with every
  non-alphanumeric character replaced by `-` (`/Users/alex/.buzz` becomes
  `-Users-alex--buzz`).

To find one by hand, search for the thread root ID (the `thread=` value of a
Buzz link, or `id=` when there is none) with `rg -l -F '<id>' <dir>`.

## Static snapshot

To hand someone a file, export a standalone HTML page. It needs no server and
doesn't update.

```sh
bin/node scripts/export-codex-session.mjs <rollout.jsonl> /tmp/session.html
bin/node scripts/export-claude-session.mjs <session.jsonl> /tmp/session.html
```

If the agent is mid-turn, the last line can be incomplete and the export
fails; rerun after the turn ends.

## Goose

The viewer doesn't read Goose sessions. Goose keeps Buzz's sessions in
`~/.local/share/goose/sessions/sessions.db` with `session_type = 'acp'`, so
`goose session list` doesn't show them. To find one by a Buzz event ID:

```sh
sqlite3 -readonly ~/.local/share/goose/sessions/sessions.db \
  "SELECT DISTINCT s.id, s.created_at FROM sessions s
   JOIN messages m ON m.session_id = s.id
   WHERE s.session_type = 'acp' AND m.content_json LIKE '%<event-id>%';"
goose session export --session-id <id> --format html -o session.html
```

HTML export needs a Goose build newer than v1.53.0.

## Don't

- Don't open a session with `codex resume`, `codex fork` or `claude --resume`
  to look at it. They continue the conversation and can run tools.
- Transcripts include file contents and Buzz messages the agent read. Keep them
  and their exports local unless you mean to share that content.
