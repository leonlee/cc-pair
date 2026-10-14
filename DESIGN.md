# cc-pair design

Claude Code and Codex review each other's work. Each runs as a live session in its own terminal,
and they talk through a shared directory that works like a chat channel.

## Decisions

| Topic | Choice |
|---|---|
| Topology | Two live sessions. No headless spawning. |
| Roles | Symmetric. Either agent can author or review. |
| Interface | One `pair` CLI (Node/TS). The agents learn it from a thin prompt: a Claude skill and an AGENTS.md section for Codex. |
| Waiting | `pair wait` checks the files every second and returns as soon as a message arrives. By default it gives up after 540s, printing `no message … yet` and exiting 0 (agent UIs show any non-zero exit as a failure), which keeps a foreground run under Claude Code's 10-minute Bash cap. Interactive Claude Code sessions run `pair wait --timeout 3600` as a background command and spend no model turns until it exits. Codex can't do the same, because a finished background command doesn't resume it. Instead, pair's MCP server queues a fixed note into the Codex session when a message is pending (see Notifications), so an idle Codex makes no model calls. Without the MCP server, Codex starts one `pair wait --timeout 3600` and checks on it about once a minute, as its runtime limits each check. Headless runs wait in the foreground. |
| Pickup | The reviewer runs `pair wait` in a loop ("be my reviewer"). |
| Request | The author's summary plus a list of files. The reviewer reads the files from the shared repo. |
| Review | Numbered findings with severity, and a verdict of `approve` or `changes`. Multiple rounds. |
| Disputes | Cap of 3 rounds (`PAIR_MAX_ROUNDS`). A review that still says `changes` at the cap marks the thread `escalated`, and both agents stop to ask the user. |
| Concurrency | At most one open thread per direction. |
| Storage | `~/.pair/<repo>-<hash>/` (or `$PAIR_HOME`). The hash comes from `git rev-parse --show-toplevel`, so each worktree gets its own channel. A reviewer reads the author's files, so both agents must run in the same worktree, and parallel pairs in different worktrees stay isolated. |
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
  codex.session                       # Codex session that pair_listen may notify (pair register)
  codex.listen.log                    # what the MCP listener did, newest last
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
acting returns the same message, because X still owes a reply. If the thread already has earlier
messages, `wait` also lists their files. An agent that lost its context, for example after a
restart, can then read the history instead of seeing only "F1 fixed".

Finished threads go to `archive/`. Whenever a thread finishes, `pair` deletes all but the `PAIR_KEEP`
most recently finished ones (100 by default; `all` keeps everything; `0` keeps none). "Most recently
finished" means by when the thread's last message landed, not when it started, so a thread that just
finished always survives when `PAIR_KEEP` is at least 1. An invalid `PAIR_KEEP` makes `send` and `wait`
fail before they touch any thread. If automatic cleanup itself fails (for example, an undeletable
directory), `pair` prints a warning and still delivers the result or writes the request.
`pair history` lists finished threads, most recently finished first, and
`pair history <id>` prints one transcript. `pair clean --keep N` deletes all but the N newest right
away. The flag is required, so a bare `clean` deletes nothing. Neither kind of cleanup touches
active threads.

`pair status` adds the canonical worktree root, installed package version, and instruction
freshness to the channel and lane states. Freshness compares the marked pair section in
`AGENTS.md` and the generated Claude skill against the same templates used by `init`. It is
read-only and describes files on disk, not instructions already loaded into a running session.
The check runs only on `status`, not during polling or message delivery.

Channel operations report `EACCES` and `EPERM` with the affected path and the sandbox
configuration printed by `init`. Either ordinary permissions or sandbox restrictions can
cause these failures. Input message files, instruction files, and installed assets are handled
separately. Automatic pruning still warns and continues; its diagnostics follow the delivered
message so `wait` keeps its protocol header first even when stdout and stderr are merged.

## Notifications

`codex queue --thread <id> --message <text>` starts a turn in an idle Codex session, and queues
behind a busy one. It works only outside both sandboxes, because it opens Codex's state databases
under `~/.codex` read-write. Claude's sandbox can't run it unless it's given write access to
`~/.codex`, which holds Codex's own config. So `send` doesn't call it. Instead, `pair mcp` runs as
a stdio MCP server that Codex starts outside its shell sandbox.

1. Codex runs `pair register` in its shell. The CLI writes `codex.session` with `CODEX_THREAD_ID`,
   which Codex sets in its shell environment, into the channel of that shell's worktree.
2. Codex calls `pair_listen`, which takes no arguments. The server reads the session id from the
   call's `_meta.threadId`, which Codex sets, and requires exactly one channel whose `codex.session`
   names that id. The model supplies no id or path, and the server's own cwd is never used.
3. Every second, the server reads `pendingFor(channel, "codex")`. It never calls `wait`, so it
   never archives anything. When the newest pending message file differs from the last one it
   announced, it runs `codex queue` with a fixed note telling Codex to run `pair wait --timeout 5`.
   Message text never goes into the note, so the partner's words never arrive as user input. Before
   every dispatch it checks that `codex.session` still names its session. `pair unregister` or a
   newer `pair register` stops it.

Before sending, a server creates `.<message file>.<session id>.notified` next to the message, using
an exclusive create, and writes `sending` in it. Only the server that creates it sends the note, so
two Codex processes attached to one session, or a repeated `pair_listen`, don't send it twice. After
`codex queue` succeeds, the claim says `sent`. Other servers then treat the message as notified.
While it says `sending`, they wait. If `codex queue` fails, the claim is removed, so the retry can
claim it again. If a claim still says `sending` after 60s, twice the queue timeout, its sender died
mid-send, and the next server takes it over. Two servers taking over at the same moment can both
send, which costs one extra short turn. The claim lives in the thread directory and is archived with
the thread. The server runs `PAIR_CODEX`, an absolute path set when the server is registered,
never `codex` from `PATH`, because a `PATH` entry an agent can write would turn the fixed call into
unsandboxed code execution.

A message is announced once. A failed `codex queue` is retried with backoff up to 60s. If a message
is still pending 10 minutes after its note, the server logs a stall warning and doesn't announce it
again: the turn may have failed or been cancelled, may be waiting for an approval, or the review may
just be long. Watches live in the MCP process, which Codex ends with the session, so notifications
stop with it. A note already accepted by Codex's daemon still runs. A repeated note costs one short
turn: `pair wait --timeout 5` prints `no message` and Codex ends its turn.

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
pair history [thread-id]
pair clean --keep N
pair init
pair register | unregister
pair mcp
```

## Known limits

- A lane still in the old flat layout (before 1c588ed) isn't migrated. Commands fail with a hint to move its files into a subdirectory, and the messages are left untouched.
- Polling, not fs events. A 1s delay is fine for chat between agents.
- Archiving is safe against concurrent readers and stale `wait`s. A thread disappearing mid-read counts as closed. A stale archive can only target its own, already-archived directory, so it never touches a newer thread.
- Notifications aren't verified end to end yet. With Codex CLI 0.162.1, only the parts were measured: queue wake-up from a plain shell, an MCP server outside the shell sandbox, `_meta.threadId`, and the server exiting with the TUI. A real registered session woken by `pair mcp` is the release check, followed by resume, two worktrees, fork, a second attached TUI, and unregister. Desktop and IDE sessions, `--no-daemon`, and `--remote` are untested. Approval policy `never` makes the `pair_listen` call fail.
- Completion-driven waiting is verified only for interactive Claude Code sessions, with waits of up to a few minutes. A full hour is untested. Headless `claude -p` ends background commands after its final result, so the prompt falls back to a foreground wait. Codex's built-in instructions (observed in these sessions: no blocking sleep or wait call over 60 seconds, and a progress update at least every minute) outrank a repo prompt, so the prompt leaves the length of each check to those instructions and only fixes the command's lifetime. Two earlier versions got this wrong. One asked for a 5-minute check window, which conflicted with the cap. The next applied the cap to the command itself (`--timeout 55`), so Codex restarted `pair wait` every minute and each run showed up as a separate entry. Whether Codex resumes automatically after ending its turn is unverified.
