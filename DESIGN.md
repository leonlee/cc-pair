# cc-pair design

Claude Code and Codex review each other's work. Each runs as a live session in its own terminal,
and they talk through a shared directory that works like a chat channel.

## Decisions

| Topic | Choice |
|---|---|
| Topology | Two live sessions. No headless spawning. |
| Roles | Symmetric. Either agent can author or review. |
| Interface | One `pair` CLI (Node/TS). The agents learn it from a thin prompt: a Claude skill and an AGENTS.md section for Codex. |
| Waiting | `pair wait` blocks, polls every second, and gives up after 540s with exit 2 so the agent runs it again. This keeps it under Claude Code's 10-minute Bash cap. |
| Pickup | The reviewer runs `pair wait` in a loop ("be my reviewer"). |
| Request | The author's summary plus a list of files. The reviewer reads the files from the shared repo. |
| Review | Numbered findings with severity, and a verdict of `approve` or `changes`. Multiple rounds. |
| Disputes | Cap of 3 rounds (`PAIR_MAX_ROUNDS`). A review that still says `changes` at the cap marks the thread `escalated`, and both agents stop to ask the user. |
| Concurrency | At most one open thread per direction. |
| Storage | `~/.pair/<repo>-<hash>/` (or `$PAIR_HOME`). The hash comes from `git rev-parse --git-common-dir`, so worktrees share a channel. |
| Format | Markdown files with flat YAML frontmatter that the CLI writes. Findings go in the body. |

## Layout

```
~/.pair/<repo>-<hash>/
  claude-to-codex/            # claude is the author
    001-request.md
    002-review.md             # round 1, verdict changes
    003-response.md           # round 2
    004-review.md             # round 2, verdict approve, status approved
  codex-to-claude/
  archive/<ts>-<thread>-<approved|escalated>/
```

Each message has this frontmatter, written by the CLI: `from`, `type`, `round`, `verdict` (reviews only), and `status` (`open`/`approved`/`escalated`).
The CLI writes to a dotfile first and then renames it, so readers never see a partial message.

## Protocol

The thread state comes from the last message, so there is no separate state file:

| Last message | State | Whose turn |
|---|---|---|
| none | idle | author may `send request` |
| request / response | awaiting-review | reviewer: `send review --verdict …` |
| review, status open | awaiting-response | author: `send response` |
| review, approved/escalated | closed | author reads it with `wait`, then it's archived |

`pair wait --as X` returns the first message where it is X's turn, in either thread. It
prints the message and a `next:` line telling the agent what to do. Calling `wait` again before
acting returns the same message, because X still owes a reply.

## Usage

```
npm install && npm run build && npm link     # provides `pair`
cd <repo> && pair init                        # installs the skill and AGENTS.md section, prints sandbox config
```

Then add the printed paths to both sandboxes: Codex `writable_roots`, Claude
`sandbox.filesystem.allowWrite`. In the reviewer terminal say "be my reviewer". In the author
terminal, finish a task and say "ask for review".

```
pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <file|->
pair wait --as <agent> [--timeout s]
pair status
pair init
```

## Known limits

- Polling, not fs events. A 1s delay is fine for chat between agents.
- Archiving a thread while the partner is polling it is safe: a thread directory that disappears reads as idle, and a second archive of it is skipped. There's no automated test for this race because it depends on timing.
- Codex's shell tool needs `timeout_ms` of at least 600000 for `pair wait`. The prompt says so, but whether Codex follows it hasn't been tested with a live session yet.
