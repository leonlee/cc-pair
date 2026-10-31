# cc-pair design

Claude Code and Codex review each other's work, talking through a shared directory that works like
a chat channel. In manual mode, each runs as a live session in its own terminal. In auto mode,
`pair start` runs the author interactively and starts the reviewer for each round.

## Decisions

| Topic | Choice |
|---|---|
| Topology | Manual mode uses two live sessions. Opt-in `pair start --as <author>` owns an interactive author and starts a headless reviewer for each round. |
| Roles | Symmetric. Either agent can author or review. |
| Interface | One `pair` CLI (Node/TS). The agents learn it from a thin prompt: a Claude skill and an AGENTS.md section for Codex. |
| Waiting | Manual mode. `pair wait` checks the files every second and returns as soon as a message arrives. By default it gives up after 540s, printing `no message … yet` and exiting 0 (agent UIs show any non-zero exit as a failure), which keeps a foreground run under Claude Code's 10-minute Bash cap. Interactive Claude Code sessions run `pair wait --timeout 3600` as a background command and spend no model turns until it exits. Codex can't do the same, because a finished background command doesn't resume it. Instead, pair's MCP server queues a fixed note into the Codex session when a message is pending (see Notifications), so an idle Codex makes no model calls. Codex never polls, because each check of a running command is a model call: without the MCP server it checks once and the user asks it to check again. Headless runs wait in the foreground. |
| Pickup | Manual mode: the reviewer waits in a loop ("be my reviewer"), Claude on a background `pair wait`, Codex woken by `pair mcp`. Auto mode: the launcher starts a reviewer for each round. |
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

${XDG_STATE_HOME:-~/.local/state}/pair/<repo>-<hash>/   # written by pair mcp and pair start, outside agent sandboxes
  codex.listen.log                    # what the MCP listener did, newest last; .1 holds the previous 256 KB
  claims/<thread>.<message file>.<session id>
  auto.json                           # the live auto session's state; removed when it ends
  auto.log                            # reviewer output, rotated at 256 KB
  author.json                         # the author's last known conversation; survives pair stop
  auto-<run>/bin/pair                 # the run's CLI wrapper ($PAIR_BIN); removed when it ends
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
If `wait` delivers a closed thread but can't archive it, for example from a sandbox that can read
the channel but not write it, it warns and still exits 0; the thread stays closed in its lane, so
the next `wait` delivers it again and the first one that can write archives it.
Archiving is safe against concurrent readers and stale `wait`s. A thread disappearing mid-read
counts as closed, and a stale archive can only target its own, already-archived directory, so it
never touches a newer thread.
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

`pair start` runs in the user's terminal outside agent sandboxes. The launcher owns a private Unix
control socket for the worktree and forks an IPC guardian, which owns the interactive author and
each bounded reviewer.

### Startup

The checks run first: options, the forwarded argument allowlists, both executables, the
`--worktree` name and target, and the `--resume` record. The only thing prepared before
confirmation is the private socket directory, which is created if missing so its ownership and
mode can be checked. Pair then prints the plan: the worktree, the author's
conversation and the reviewer's settings. With a terminal on stdin and stdout and no `--yes`, it
waits for Enter; readline releases stdin before the guardian launches the author.

A new `--worktree` is created on branch `NAME`, and pair verifies `refs/heads/NAME` afterwards, so
a tag named `NAME` can't win. A reused one only has to belong to the repository (same top level and
`--git-common-dir`); its HEAD, the full ref or the commit when detached, is shown in the summary and
compared again after Enter, so pair never starts on a target other than the one confirmed. The
agents follow pair's instructions for findings, severity and verdicts, so pair runs `pair init` in
the session's checkout when either instruction file is missing there. The launcher then changes to
that checkout, so `pair ps` groups it there, and binds the socket. A second launcher can't bind it;
`pair status` and `pair stop` contact the live owner, and persisted PIDs are diagnostic only.

The socket lives under a private `/tmp/pair-auto-<uid>/` (or `PAIR_AUTO_SOCKET_DIR`) because macOS
limits Unix socket path length. The path is canonicalized, and a Claude author receives an exact,
per-session `sandbox.network.allowUnixSockets` entry through `--settings`; no settings file is
edited. A Codex author always gets `--cd <worktree>`, because a resumed Codex session otherwise uses,
or offers, the directory it was recorded in. If the author can't be spawned at all, pair says why.

### Review rounds

Each request or response from the author asks the owner, over the socket, to run one review round,
and waits for its result. The owner checks that the message is pending in its author's lane;
duplicate requests for the same running message share the job. The reviewer is told to read one
message, send one verdict and exit, and `pair send`/`wait` also check its role and expected message,
so an unrelated author duty in the opposite lane can't be picked up. The verdict on disk decides
success, not the exit code. A successful verdict returns through the author's original `send`, with
the usual formatting and archiving; this replaces idle waits and MCP notifications. Interactive
Claude runs these blocking commands as background Bash tasks, avoiding the foreground tool timeout.

Reviewers stream JSON events into the launcher, which records their session IDs. A saved session is
resumed only within the same review thread; no `--last` lookup is used. `--reviewer-model` and
`--reviewer-effort` apply to every launch, including resume: Codex receives `--model` and
`--config model_reasoning_effort="LEVEL"`, Claude `--model` and `--effort`. They never reach the
author or either CLI's config. Status shows the requested values, with `CLI default` for omitted
ones, since the launcher does not resolve inherited settings. Effort names are checked per backend
before startup; each CLI decides whether it supports the combination.

A failed round keeps the request, and an explicit author `wait` retries it. Its error includes the
last error the reviewer reported in its JSON stream (Codex `error` or `turn.failed`; Claude's failed
`result`, from `errors[]` and `result`), capped at 4000 characters, with control characters escaped
and labeled as reviewer output. When a model or effort override is set, the error names it and says
that a retry keeps it, since only a new `pair start` can change it.

### Author conversations

Pair records the author's conversation so a restart can resume it. The ID is known before launch
when pair can set or read it: pair passes `--session-id` to a new Claude conversation, and keeps the
ID of Claude's `--resume <uuid>` or Codex's `resume <uuid>`. Codex is resumed only by ID, since a
name, a search or `--last` could pick another directory's conversation. In every other case (a new
Codex conversation, `--continue`, `--fork-session`, a `--resume` name or search term), the author's
review request carries the ID its CLI sets for the commands it runs, `CLAUDE_CODE_SESSION_ID` or
`CODEX_THREAD_ID`. The owner accepts it only as a UUID with this run's ID, and the launcher removes
both variables from the author's inherited environment so a stale value can't be reported. This
also follows the author through a `/clear`. `--continue` together with `--resume` is refused.

`author.json` (written atomically, mode 0600, validated on read) keeps the last known ID, how it was
learned, and a restart command that starts with `cd` to the worktree and drops `--worktree`. It
survives `pair stop` and is presented as recovery data, never as proof that the conversation still
exists. `pair start --resume` is the explicit way to use it: it adds the recorded ID as the author's
selector only when the record is valid, is for the same CLI and has a known ID, and it refuses
author arguments that already select a conversation. A plain `pair start`, or one with
`--continue`, never resumes the record by itself.

Claude records a conversation's system prompt on its first request and reuses it on resume, so the
author prompt names `"$PAIR_BIN"` rather than the run directory. Every launch also sends a first
user message naming `"$PAIR_BIN"`, for conversations whose instructions an older pair recorded. The
Claude reviewer keeps the absolute wrapper path, because its `--allowedTools` rules match the literal
command, and its sessions are resumed only within one run.

### Supervision

The guardian runs the author and each reviewer in separate Unix process groups. The author inherits
the terminal streams, and the guardian forwards resize signals. Since `setsid` removes its
controlling terminal, `/dev/tty` consumers and Ctrl+Z job control are unsupported. The launcher saves
the tty state and restores it during cleanup, and the guardian does so if the launcher dies.

Every termination path stops accepting jobs, terminates owned groups, escalates to SIGKILL after the
grace period, and observes the CLI exit and stream closure. Even a successful CLI exit triggers
cleanup of the rest of its group. A private IPC disconnect cleans up if the launcher dies; a
monotonic heartbeat deadline covers a hung launcher without counting wall-clock jumps or suspended
time. The guardian exits after its jobs are collected, and the launcher tracks live child identities
for emergency cleanup if the guardian fails. No cleanup loads a PID from disk and signals it, and no
command kills by agent name.

This is process-group supervision on macOS and Linux, not OS containment: descendants that create
their own sessions or groups can escape it, and killing both supervisors can leave a stale control
socket. Stale sockets are reported for manual inspection, never silently replaced. Windows auto mode
is not supported.

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

## Known limits

- A lane still in the old flat layout (before 1c588ed) isn't migrated. Commands fail with a recovery hint; `pair reset` can back up and clear it without parsing the old files.
- Polling, not fs events. A 1s delay is fine for chat between agents.
- Notifications were verified end to end with Codex CLI 0.162.1 and 0.163.0 on the shared app-server daemon, and with the ChatGPT desktop app, which runs its own app-server and starts its own `pair mcp` (with `PAIR_CODEX` pointing at the separately installed CLI). IDE sessions, `--no-daemon` and `--remote` are untested.
- Approval policy `never` makes `pair_listen` fail; Codex reports it and stops without polling.
- The MCP server is a child of the app-server daemon, not of the TUI, so notifications continue for 1–2 minutes after the last TUI on a session quits, until the daemon unloads it. A message in that gap starts a turn with no TUI attached.
- Completion-driven waiting is verified only for interactive Claude Code sessions. Headless `claude -p` ends background commands after its final result, so the prompt falls back to a foreground wait. A finished background command doesn't resume Codex, and a long `pair wait` that Codex keeps checking costs a model call per check, which is why Codex uses `pair mcp`.
