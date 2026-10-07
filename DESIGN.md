# cc-pair design

Claude Code and Codex review each other's work. Each runs as a live session in its own terminal,
and they talk through a shared directory that works like a chat channel.

## Decisions

| Topic | Choice |
|---|---|
| Topology | Two live sessions. No headless spawning. |
| Roles | Symmetric. Either agent can author or review. |
| Interface | One `pair` CLI (Node/TS). The agents learn it from a thin prompt: a Claude skill and an AGENTS.md section for Codex. |
| Waiting | `pair wait` checks the files every second and returns as soon as a message arrives. By default it gives up after 540s (exit 2), which keeps a foreground run under Claude Code's 10-minute Bash cap. Interactive Claude Code sessions run `pair wait --timeout 3600` as a background command and spend no model turns until it exits. Codex checks on it with long wait windows, which cuts idle wake-ups (about 12 an hour at the default 5-minute maximum) but doesn't remove them. Headless runs wait in the foreground. |
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
  claude-to-codex/                    # lane where claude is the author
    <iso-ts>-<rand>/                  # one directory per thread; a path is never reused
      001-request.md
      002-review.md                   # round 1, verdict changes
      003-response.md                 # round 2
      004-review.md                   # round 2, verdict approve, status approved
  codex-to-claude/
  archive/<iso-ts>-<rand>-<lane>-<approved|escalated>/
```

Each message has this frontmatter, written by the CLI: `from`, `type`, `round`, `verdict` (reviews only), and `status` (`open`/`approved`/`escalated`).
The CLI writes to a dotfile first and then renames it, so readers never see a partial message.
When the CLI reads a message, it checks every field and fails with `corrupt message <path>: …` if anything is invalid. It doesn't guess.

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
npm install && npm link                       # npm install builds via prepare; npm link provides `pair`
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

- A lane still in the old flat layout (before 1c588ed) isn't migrated. Commands fail with a hint to move its files into a subdirectory, and the messages are left untouched.
- Polling, not fs events. A 1s delay is fine for chat between agents.
- Archiving is safe against concurrent readers and stale `wait`s. A thread disappearing mid-read counts as closed. A stale archive can only target its own, already-archived directory, so it never touches a newer thread.
- Completion-driven waiting is verified only for interactive Claude Code sessions, with waits of up to a few minutes. A full hour is untested. Headless `claude -p` ends background commands after its final result, so the prompt falls back to a foreground wait. Codex's idle cost depends on the longest wait window its runtime allows. Its own instructions may cap that below a minute. Whether Codex resumes automatically after ending its turn is unverified.
