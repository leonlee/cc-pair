# cc-pair design

Claude Code and Codex review each other's work. Each runs as a live session in its own terminal,
and they talk through a shared directory that works like a chat channel.

## Decisions

| Topic | Choice |
|---|---|
| Topology | Manual mode uses two live sessions. Opt-in `pair start --as <author>` owns an interactive author and starts a headless reviewer for each round. |
| Roles | Symmetric. Either agent can author or review. |
| Interface | One `pair` CLI (Node/TS). The agents learn it from a thin prompt: a Claude skill and an AGENTS.md section for Codex. |
| Waiting | `pair wait` checks the files every second and returns as soon as a message arrives. By default it gives up after 540s, printing `no message … yet` and exiting 0 (agent UIs show any non-zero exit as a failure), which keeps a foreground run under Claude Code's 10-minute Bash cap. Interactive Claude Code sessions run `pair wait --timeout 3600` as a background command and spend no model turns until it exits. Codex can't do the same, because a finished background command doesn't resume it. Instead, pair's MCP server queues a fixed note into the Codex session when a message is pending (see Notifications), so an idle Codex makes no model calls. Codex never polls, because each check of a running command is a model call: without the MCP server it checks once and the user asks it to check again. Headless runs wait in the foreground. |
| Pickup | The reviewer waits in a loop ("be my reviewer"): Claude on a background `pair wait`, Codex woken by `pair mcp`. |
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

${XDG_STATE_HOME:-~/.local/state}/pair/<repo>-<hash>/   # written only by pair mcp, outside agent sandboxes
  codex.listen.log                    # what the MCP listener did, newest last; .1 holds the previous 256 KB
  claims/<thread>.<message file>.<session id>
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
The comparison ignores the `<!-- pair x.y.z -->` stamp that records which version wrote a file.

`send`, `wait`, `history`, `clean`, `register` and `unregister` run the same check once at startup,
not on each poll, and rewrite stale files. They skip files stamped by a newer pair, so worktrees
shared by two versions don't flip back and forth. A write failure is a warning on stderr, so a
read-only sandbox still delivers messages. `status` stays read-only, and `mcp` never refreshes:
it runs unsandboxed and only reads. `status` and `init` also report a newer npm version. They check
at most once a day, cache the answer under the state directory, and stay quiet on failure.
`init` also keeps files a newer pair wrote; deleting them is the way to downgrade. The refresh note goes
to stderr after the command's own output, so `pair wait`'s first line is still the delivery or
timeout line agents read. `pair upgrade` installs with npm, then runs the `init` of the package it
just installed (found with `npm root --global`), not the first `pair` on PATH, because both this
process and an older copy on PATH would write the old templates. It asks `npm view` first, so it uses
the same registry as the install. Already on the latest version, it only runs the in-process
refresh. If the check fails, it goes ahead with the install, which reports the actual npm error.

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

Before sending, a server creates a claim file for the message and session, using an exclusive
create, and writes `sending` in it. Only the server that creates it sends the note, so
two Codex processes attached to one session, or a repeated `pair_listen`, don't send it twice. After
`codex queue` succeeds, the claim says `sent`. Other servers then treat the message as notified.
While it says `sending`, they wait. If `codex queue` fails, the claim is removed, so the retry can
claim it again. If a claim still says `sending` after 60s, twice the queue timeout, its sender died
mid-send, and the next server takes it over. Two servers taking over at the same moment can both
send, which costs one extra short turn. A queue call that accepted the note but timed out before
exiting can also be retried and send one extra note. Claims older than 7 days are deleted when a
session starts listening.

The server runs outside both sandboxes, and agents can write the channel. An agent could replace a
file there, or a whole directory on the path to it, with a symlink, and could do it between any
check and the write that follows. So `pair mcp` never writes in a channel. Its log and claims live
in `${XDG_STATE_HOME:-~/.local/state}/pair/`; relative `XDG_STATE_HOME` values are ignored. Agent
sandboxes cannot write there by default. The server still reads the channel, opening those files
with `O_NOFOLLOW`. It runs `PAIR_CODEX`, an absolute path set when the server is registered, never
`codex` from `PATH`, because an agent-writable `PATH` entry would turn the fixed call into
unsandboxed code execution.

A message is announced once. A failed `codex queue` is retried with backoff up to 60s. If a message
is still pending 10 minutes after its note, the server logs a stall warning and doesn't announce it
again: the turn may have failed or been cancelled, may be waiting for an approval, or the review may
just be long. Watches live in the MCP process. Codex's app-server daemon starts it and ends it when it unloads
the session, which took 1–2 minutes after the last TUI on that session quit. Until then, a new
message still starts a turn with no TUI attached. `pair unregister` stops notifications right away.
A note already accepted by the daemon still runs either way, so the prompt tells Codex to ignore a
note that arrives after the user said stop. A repeated note costs one short
turn: `pair wait --timeout 5` prints `no message` and Codex ends its turn.

## Auto sessions

`pair start` runs in the user's terminal outside agent sandboxes. It resolves both CLI executables
once, binds a private Unix control socket for this worktree/channel/state-directory combination,
and forks an IPC guardian. A second launcher cannot bind that socket. `pair status` and `pair stop`
contact the live owner; persisted PIDs are diagnostic only. State and rotating reviewer logs are
kept beside the existing listener state. The short socket path is under a private
`/tmp/pair-auto-<uid>/` directory (or `PAIR_AUTO_SOCKET_DIR`) because macOS limits Unix socket path
length. The path is canonicalized, and a Claude author receives an exact, per-session
`sandbox.network.allowUnixSockets` entry through `--settings`. No global settings file is edited.

The guardian owns the interactive author and each bounded reviewer in separate Unix process groups.
The author inherits the terminal streams; the guardian forwards resize signals. Since `setsid`
removes its controlling terminal, `/dev/tty` consumers and Ctrl+Z job control are unsupported.
The launcher saves tty state and restores it during cleanup, and the guardian does so if the
launcher dies. Reviewers stream
JSON events into the launcher, which records their session IDs. Each request/response from the auto
author asks the owner to run one review round and waits for its result over the control socket.
The owner validates that the message is pending in its author's lane. Duplicate requests for the
same running message share the job. A saved session is resumed only within the same review thread;
no `--last` session lookup is used.

Optional `--reviewer-model` and `--reviewer-effort` overrides are applied on every reviewer launch,
including resume. Codex receives `--model` and `--config model_reasoning_effort="LEVEL"`; Claude
receives `--model` and `--effort`. Overrides never enter the interactive author's arguments or
persist to either CLI's config. The live state reports these requested overrides and labels
omitted values as `CLI default`, since the launcher does not resolve inherited provider settings.
Known effort names are checked for the reviewer backend before startup; each CLI/model validates
whether it supports the selected combination.

The reviewer receives instructions to read one message, send one verdict, and exit. Its CLI role
and expected message are also checked by `pair send`/`wait`, avoiding an unrelated pending author
duty in the opposite lane. Reviewer exits are checked against the on-disk verdict, not just the
process exit code. Successful verdicts are returned through the author's original `send`, using
the existing message formatting and archive behavior. This replaces idle model waits and MCP
notifications in auto mode. An explicit author `wait` retries a failed pending round. Interactive
Claude runs these blocking review commands as background Bash tasks and reads their completion
output, avoiding the foreground tool timeout. Its author instructions are appended to the system
prompt; generated instructions also tell agents to check their role after clear/compaction.

A failed round's error includes the last error string the reviewer reported in its JSON stream
(Codex `error` or `turn.failed`, Claude `result` with `is_error`). It is capped at 4000 characters,
control characters are escaped, and it is labeled as reviewer output; the verdict on disk still
decides whether the round succeeded. When a model or effort override was set, the error names it
and says that `pair wait` retries with it, since only a new `pair start` can change it.

Before it creates anything (a worktree, instruction files, the author record, the socket),
`pair start` prints the plan: the worktree, the author's conversation and the reviewer's settings.
With a terminal on stdin and stdout and no `--yes`, it then waits for Enter; readline releases
stdin before the guardian launches the author. The launcher then changes to the session's worktree,
so `pair ps` groups it there.

A Claude author's conversation ID is recorded only when it is known before launch: pair passes
`--session-id` to a new conversation and keeps the ID of `--resume <uuid>`. `--continue`,
`--fork-session` and a `--resume` name or search term stay unknown, and pair refuses `--continue`
together with `--resume`. `author.json` in the state directory (written atomically, mode 0600) keeps
the last known ID and a restart command that starts with `cd` to the worktree. It survives
`pair stop`, and it is presented as recovery data, never as proof that the conversation still
exists. Claude records a conversation's system prompt on its first request and reuses it on resume,
so the author prompt names `"$PAIR_BIN"` rather than the run directory. Every launch also sends a
first user message that names `"$PAIR_BIN"`, for conversations whose instructions were recorded by
an older pair. The Claude reviewer keeps the absolute wrapper path, because its `--allowedTools`
rules match the literal command, and its sessions are resumed only within one run.

Every termination path stops accepting jobs, terminates owned groups, escalates to SIGKILL after
the configured grace period, and observes the CLI exit and stream closure. Even a successful CLI
exit triggers cleanup of remaining group members. A private IPC disconnect cleans up if the
launcher dies; a monotonic heartbeat deadline covers a hung launcher without counting wall-clock
jumps or suspended wall-clock time. The guardian itself exits after its
jobs are collected. The launcher also tracks live child identities for emergency cleanup if the
guardian fails. No cleanup loads a PID from disk and signals it, and no command kills by agent name.

This is process-group supervision on macOS/Linux, not OS containment: descendants that create their
own sessions/groups can escape it, and killing both supervisors can leave a stale control socket.
Stale sockets are reported for manual inspection, never silently replaced. Windows auto mode is
not yet supported. Manual mode and its notification lifecycle remain unchanged.

## Manual reset

`pair reset` moves whole pending lanes into `resets/<reset-id>/` in the current channel, leaving
source files, archived history, and session registrations untouched. `--as` selects the lane's
author; omitting it resets both, independent of `PAIR_AGENT`. Moving whole lanes also handles
legacy flat files, malformed messages, partial writes, and older thread directories without
requiring successful protocol parsing. A small `reset.json` records the time, worktree and planned
lanes. Reset backups are deliberately outside archive retention and `pair history`.
Both preview and reset output show best-effort lane states. Unread closed threads still in their
lanes are included in the backup; only already-archived history is left in `pair history`.

Each lane rename is atomic. If a later rename fails, the command reports which lanes moved and
where their backup is; it never deletes or rolls back over new data. Manual agents must be stopped
before reset. On macOS/Linux, reset exclusively binds the auto-mode control socket until it finishes,
so it refuses live or stale ownership and serializes with `pair start`. `--dry-run` only inspects
the pending lanes and creates neither backups nor an ownership socket, even while auto mode runs.

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
pair reset [--as <agent>] [--dry-run]
pair init
pair uninit
pair register | unregister
pair mcp
```

## Known limits

- A lane still in the old flat layout (before 1c588ed) isn't migrated. Commands fail with a recovery hint; `pair reset` can back up and clear it without parsing the old files.
- Polling, not fs events. A 1s delay is fine for chat between agents.
- Archiving is safe against concurrent readers and stale `wait`s. A thread disappearing mid-read counts as closed. A stale archive can only target its own, already-archived directory, so it never touches a newer thread.
- Notifications are verified end to end with Codex CLI 0.162.1 on the shared app-server daemon. A registered session that had ended its turn was woken about 1s after Claude's request, then reviewed and replied in one turn. Other cases also verified:
  - A message sent while Codex was closed was queued about 1s after `pair_listen` on resume.
  - `pair unregister` stopped the watch.
  - A fork's `register` stopped the original session's watch within 40ms.
  - Two TUIs on one session share one MCP process and got one note.
  - Two worktrees each woke only their own session.
  - With Codex as the author, a `changes` review and the final approval each woke it once, and its `pair wait` archived the approved thread.
  - Approval policy `never` makes `pair_listen` fail, and Codex reports it and stops without polling.
- The MCP server is a child of the app-server daemon, not of the TUI. After the last TUI on a session quit, it ran 1–2 more minutes, until the daemon unloaded the session. A message in that gap still wakes the session with no TUI attached. The ChatGPT desktop app runs its own app-server, which starts its own `pair mcp`; waking its sessions worked, with `PAIR_CODEX` pointing at the separately installed CLI. IDE sessions, `--no-daemon`, and `--remote` are untested.
- Completion-driven waiting is verified only for interactive Claude Code sessions, with waits of up to a few minutes. A full hour is untested. Headless `claude -p` ends background commands after its final result, so the prompt falls back to a foreground wait. Codex was tried with one long `pair wait` that it kept checking. Its built-in instructions cap each check at about 60 seconds, so an idle Codex made a model call every minute, enough to run a workspace out of credits. A finished background command doesn't resume Codex (measured with CLI 0.162.1), which is why Codex uses `pair mcp` instead.
