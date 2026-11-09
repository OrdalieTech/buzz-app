# View a Claude session started by Buzz

For the live viewer, run `bin/node scripts/session-debug.mjs '<Buzz thread ID or link>'`
from the repository root. See [session debugging](session-debugging.md) for wall
time, token use and live updates. The commands below remain useful for
standalone snapshots and manual transcript inspection.

This guide is for agents investigating a Buzz conversation. All commands run
non-interactively and read the saved transcript without invoking Claude or tools.

Buzz runs Claude through `claude-agent-acp`. Claude saves transcripts
as JSONL under `~/.claude/projects/<project>/<session-id>.jsonl`. The project
directory derives from the agent's working directory, with non-alphanumeric
characters replaced by `-` (long paths also get truncated and hashed). For
example, `/Users/alex/.buzz` becomes `-Users-alex--buzz`.

If the agent has `CLAUDE_CONFIG_DIR` set in its Environment, use that config
directory instead. `CLAUDE_CODE_PROJECT_DIR_NAME` overrides the project name when
set alongside `CLAUDE_CONFIG_DIR`. Run the commands below on the machine that runs
the agent, with `rg` and `jq` installed.

## Find the session

Start from the Buzz link to the thread. In its `buzz://message` link, take the
64-character `thread=` value, or `id=` when the link has no `thread=`. That is
the thread root. Search transcripts for the context Buzz sent to Claude:

```sh
root='<thread-root-id>'
claude_config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
rg -l -F -e "Thread root: $root" -e "Event ID: $root" -e "{\\\"id\\\":\\\"$root" \
  "$claude_config_dir/projects" -g '*.jsonl'
```

Usually exactly one session matches. A channel-scoped session can contain several
Buzz threads; subagent transcripts and restarted sessions can also match. Check
the working directory, timestamps, session ID, and actual recorded model:

```sh
session='/path/to/matching-session.jsonl'
jq -r 'select(.type == "user" or .type == "assistant") |
  [.timestamp, .sessionId, .cwd, .type, .message.model // "-"] | @tsv' \
  "$session"
```

If the Buzz link is unavailable, search for a distinctive part of your message
using `rg -l -F 'distinctive message text' "$claude_config_dir/projects" -g '*.jsonl'`.
JSON escaping can prevent a literal match for text containing quotes or newlines.

## View messages and tool activity without resuming

```sh
jq 'select(.message != null) |
  {timestamp, type, model: .message.model, content: .message.content}' \
  "$session"
```

This shows user messages, assistant text, tool inputs, and tool results. Match
`tool_use.id` with `tool_result.tool_use_id` to follow a command and its output.
It reads the saved file without sending a prompt or starting another Claude
session. The transcript is not a complete capture of the system prompt or launch
environment; use Buzz's agent configuration and process log for those details.

For a long transcript, read a bounded range of messages (indexes start at zero):

```sh
jq -s 'map(select(.message != null)) | .[0:10] |
  .[] | {timestamp, type, model: .message.model, content: .message.content}' \
  "$session"
```

For an empty Buzz reply, inspect the send command and its tool result. A failed
producer in `producer | buzz messages send --content -` can leave Buzz with empty
stdin while the final command still succeeds. Shell aliases can also affect
commands when their target programs are absent from the agent's PATH. Successful
CLI exit or `accepted: true` alone does not prove that the intended text arrived;
check the Buzz thread as well.

## Export a local HTML viewer

From the `buzz-app` repository root, use the pinned Node tool to generate a standalone
HTML file. Choose a new output path; the exporter refuses to overwrite files:

```sh
bin/node scripts/export-claude-session.mjs "$session" /tmp/claude-session.html
```

Give the human the absolute output path, or open it with the app's file viewer.
On macOS, `open /tmp/claude-session.html` opens it in a browser. The exporter
renders through the shared session viewer (`scripts/session-viewer.mjs`): a
searchable sidebar with Default, No-tools, User, and All filters, and the
conversation in order. Buzz turns show their `Content:` text, with the full turn
context expandable. Each tool call shows its input and paired result, marked
when the result is an error; long text expands on click. Meta records appear
only under All.
The viewer contains escaped text, requires no server or network resources, and
does not execute transcript content. It includes every recorded message in the
matched session, which can contain other Buzz threads; non-message metadata
records are omitted. This is a snapshot, not a live view.

An actively written transcript can end with incomplete JSON. The exporter reports
the line and writes no HTML; rerun after the turn finishes. Do not use
`claude -p --resume` to export: it sends a new prompt and can run tools. Claude's
`/export` command is interactive and is not needed for this workflow.

Keep transcripts and exports local unless you intend to share their contents.
Claude's JSONL schema is internal and can change between releases. Missing files
can also reflect retention or disabled persistence. See [Claude Code session
documentation](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)
for storage overrides, retention, and supported export interfaces.
