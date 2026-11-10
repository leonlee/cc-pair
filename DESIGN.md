# cc-pair design

Claude Code and Codex review each other's work, or their own, talking through a shared directory
that works like a chat channel. In manual mode, each runs as a live session in its own terminal. In
auto mode, `pair start` runs the author interactively and starts the reviewer for each round.

## Decisions

| Topic | Choice |
|---|---|
| Topology | Manual mode uses two live sessions. Opt-in `pair start <author-cli> [<reviewer-cli>]` owns an interactive author and starts a headless reviewer for each round. |
| Roles | Symmetric. Either agent can author or review. |
| Participants | A participant is a name (`^[a-z][a-z0-9_]{0,31}$`, no dashes, so lane names parse); the CLI that runs it is a property of the session, never stored in a message or lane. `claude` and `codex` are the default names and each other's default partner, so existing channels and commands are unchanged. Self comes from `--as`/`PAIR_AGENT`; a new request's partner from `--to`, `PAIR_PARTNER` or the default partner; a reply's from `--to`, as the `== next:` line names it, never guessed. Specified in [docs/specs/participants.md](docs/specs/participants.md). |
| Interface | One `pair` CLI (Node/TS). The agents learn it from a thin prompt: a Claude skill and an AGENTS.md section for Codex. |
| Waiting | Manual mode. `pair wait` checks the files every second and returns as soon as a message arrives. By default it gives up after 540s, printing `no message … yet` and exiting 0 (agent UIs show any non-zero exit as a failure), which keeps a foreground run under Claude Code's 10-minute Bash cap. Interactive Claude Code sessions run `pair wait --timeout 3600` as a background command and spend no model turns until it exits. Codex can't do the same, because a finished background command doesn't resume it. Instead, pair's MCP server queues a fixed note into the Codex session when a message is pending (see Notifications), so an idle Codex makes no model calls. Codex never polls, because each check of a running command is a model call: without the MCP server it checks once and the user asks it to check again. Headless runs wait in the foreground. |
| Pickup | Manual mode: the reviewer waits in a loop ("be my reviewer"), Claude on a background `pair wait`, Codex woken by `pair mcp`. Auto mode: the launcher starts a reviewer for each round. |
| Request | The author's summary plus a list of files. The reviewer reads the files from the shared repo. |
| Review | Numbered findings with severity, and a verdict of `approve` or `changes`. Multiple rounds. |
| Specs | A spec or plan, in any format, is reviewed in an ordinary thread: the request names its paths and commit, and the instructions give the reviewer a spec checklist. An implementation's request can cite the approved thread under `## Spec`; the reviewer reads it with `pair history` and reports departures. Pair parses neither, so no message field or version boundary is needed, and the Claude reviewer's allowlist includes `pair history`. |
| Brainstorms | `pair send request --brainstorm` opens a thread for ideas in the author's lane. The reviewer replies `continue` or `complete` instead of `approve` or `changes`. Its statuses are `brainstorming` and `completed`, and the kind comes from the status, so pair ≤ 0.7.4 rejects the request as corrupt and can't review it as code; both agents need 0.8.0. The request stores `budget:`, `PAIR_MAX_ROUNDS` when it opened, so the agents' shells can't disagree on it; on the last round `continue` is refused. It never escalates. |
| Disputes | Cap of 3 rounds (`PAIR_MAX_ROUNDS`). A review that still says `changes` at the cap marks the thread `escalated`, and both agents stop to ask the user. |
| Concurrency | At most one open thread per lane, so a participant has at most one with each partner. |
| Delegation | A subagent inherits the author's pair environment, so the instructions make the parent own the pair loop: subagents return changes without running pair, the parent integrates them (or reviews separate PRs one at a time) in the session's worktree and keeps it stable during each round. Several threads per lane wouldn't stop files moving under a reviewer. With `pair start --serve-worktrees`, one owner also serves subagents' own worktrees (see Served worktrees). |
| Storage | `~/.pair/<repo>-<hash>/` (or `$PAIR_HOME`). The hash comes from `git rev-parse --show-toplevel`, so each worktree gets its own channel. A reviewer reads the author's files, so both agents must run in the same worktree, and parallel pairs in different worktrees stay isolated. |
| Format | Markdown files with flat YAML frontmatter that the CLI writes. Findings go in the body. |

## Layout

```
~/.pair/<repo>-<hash>/
  claude-to-codex/                    # lane <author>-to-<reviewer>: here claude authors, codex reviews
    <iso-ts>-<rand>/                  # one directory per thread; a path is never reused
      001-request.md
      002-review.md                   # round 1, verdict changes
      003-response.md                 # round 2
      004-review.md                   # round 2, verdict approve, status approved
  codex-to-claude/
  alice-to-bob/                       # any two other participants
  archive/<iso-ts>-<rand>-<lane>-<approved|escalated|completed>/
  codex.session                       # Codex session that pair_listen may notify for codex (pair register)
  sessions/<name>.json                # the same, for any other participant (pair register --as NAME)

${XDG_STATE_HOME:-~/.local/state}/pair/<repo>-<hash>/   # written by pair mcp and pair start, outside agent sandboxes
  codex.listen.log                    # what the MCP listener did, newest last; .1 holds the previous 256 KB
  claims/<thread>.<message file>.<session id>
  auto.json                           # the live auto session's state; removed when it ends
  auto.log                            # reviewer output, rotated at 256 KB
  author.json                         # the author's last known conversation; survives pair stop
  auto-<run>/bin/pair                 # the run's CLI wrapper ($PAIR_BIN); removed when it ends
```

Each message has this frontmatter, written by the CLI: `from`, `type`, `round`, `verdict` (reviews only), and `status` (`open`/`approved`/`escalated`, or `brainstorming`/`completed` in a brainstorm). A brainstorm request also has `budget`.
The CLI writes to a dotfile first and then renames it, so readers never see a partial message.
When the CLI reads a message, it checks every field and fails with `corrupt message <path>: …` if anything is invalid. It doesn't guess.

## Protocol

The thread state comes from the last message, so there is no separate state file:

| Last message | State | Whose turn |
|---|---|---|
| none | idle | author may `send request` |
| request / response | awaiting-review | reviewer: `send review --verdict …` |
| review, status open/brainstorming | awaiting-response | author: `send response` |
| review, approved/escalated/completed | closed | author reads it with `wait`, then it's archived |

`pair wait --as X` returns the first message where it is X's turn, in any lane: X's author duties
(reviews in `X-to-*`) first, then its reviewer duties (requests and responses in `*-to-X`), oldest
first within each. It prints the message and a `next:` line telling the agent what to do, with
`--to` naming the delivered lane's counterpart, so a reply never goes to a configured partner by
mistake. Calling `wait` again before
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
`pair history <id>` prints one transcript. It reads this worktree's channel and, read-only, those of
the repository's other existing worktrees from `git worktree list`, found with the caller's
PAIR_HOME, so a spec reviewed in one worktree can be cited from another. Their threads are marked
with their worktree, and an unreadable one is skipped with a warning. Archiving and cleanup stay
per worktree. `pair clean --keep N` deletes all but the N newest right
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

1. Codex runs `pair register --as NAME` in its shell. The CLI writes the registration with
   `CODEX_THREAD_ID`, which Codex sets in its shell environment, into the channel of that shell's
   worktree: `codex.session` for `codex`, `sessions/NAME.json` for any other name. One Codex
   session registers as one participant; `sessions` must be a real directory, never a symlink, so
   `register`, `unregister` and `uninit` can't write or delete through it.
2. Codex calls `pair_listen`, which takes no arguments. The server reads the session id from the
   call's `_meta.threadId`, which Codex sets, and requires exactly one registration, across channels
   and names, that names that id. A corrupt or refused registration is skipped, not fatal to the
   others. The model supplies no id or path, and the server's own cwd is never used.
3. Every second, the server reads `pendingFor(channel, NAME)`. It never calls `wait`, so it
   never archives anything. When the newest pending message file differs from the last one it
   announced, it runs `codex queue` with a fixed note telling Codex to run
   `pair wait --as NAME --timeout 5`. The name is validated and message text never goes into the
   note, so the partner's words never arrive as user input. Before every dispatch it checks that the
   registration still names its session. `pair unregister` or a
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

The session's pairing is fixed at startup: the author's name and CLI, and the reviewer's name and
CLI. The words after `start` choose the CLIs (the reviewer's defaults to the other one), and `--as`
and `--reviewer` the names. Each name defaults to its CLI's, or to `<cli>_reviewer` for a reviewer
that would get the author's. Names never choose CLIs, except in the 0.9 form without CLIs, where
`--as claude|codex` (or `PAIR_AGENT`) is also the author's CLI; with a CLI, `PAIR_AGENT` is
ignored. Each agent gets its own name as `PAIR_AGENT`, the other's as `PAIR_PARTNER`, and its CLI
as `PAIR_AUTO_CLI`, which picks the session-ID variable it reports. Launch arguments, tool allowlist, output parsing and effort names
follow each side's CLI, so a same-CLI reviewer is launched like any other, with its own
conversation per thread. Only the CLIs the pairing uses are resolved. The restart command starts
with the author's CLI and adds only what the defaults wouldn't give back, so it reproduces the
pairing in any shell.

### Startup

When the command doesn't name the author's CLI and stdin and stdout are terminals (no `--yes`),
pair asks first: a resume when this checkout (or the given `--worktree`) has a usable record, which
also fixes the author's CLI and the location, then the CLIs, the location with a resume for that
worktree's record, and the reviewer's model and effort, skipping whatever the command line gave. Its answers become ordinary
arguments inserted after the `start` word. Pair prints the resulting command and runs `main` again
with it, so a guided start is parsed, validated, summarized and confirmed exactly like a typed one.
The questions use only read-only facts (installed CLIs, `planWorktree`, the author record, the
models to offer), and cancelling one stops before anything else runs. The models are Claude's aliases,
or the ones Codex's picker lists in its `$CODEX_HOME/models_cache.json`. That file is Codex's internals, so
pair uses it only to offer choices and to question a typed Codex model that it doesn't list,
hidden ones included: any model ID can still be used, and without the file the question is free
text.

The checks run first: options and the pairing, the forwarded argument allowlists, the executables, the
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
and waits for its result. The owner checks that the message is pending in the session's lane,
`<author>-to-<reviewer>`; the author's inline result and retry `wait` read only that lane, so
pending or unread threads in other lanes are left for manual use;
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
ones, since the launcher does not resolve inherited settings. After each round it reads what the
reviewer actually ran with from the CLI's own session file and shows it where it differs:
Codex's last `turn_context` in `$CODEX_HOME/sessions/…/rollout-…-<id>.jsonl`, and Claude's last
main-thread assistant entry in `$CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`. These files are
the CLIs' internals, so this is display only: nothing depends on it, and a missing or changed file
just leaves the requested values. The line for new threads shows the latest round's values only
when that round was given the same settings. Effort names are checked per backend
before startup and on every change; each CLI decides whether it supports the combination.

`pair reviewer` changes the settings on the live owner, over the control socket, without a restart.
A thread takes a snapshot of the settings at its first launch and keeps it for its follow-up rounds
and retries, so by default a change applies to new threads; the restart command `pair stop` prints
uses the current ones. `--thread current|ID` changes one thread instead, and only the pending one
whose last round failed: the owner checks that no round is reserved (a launch reserves the round
before its process exists, so a missing PID doesn't count), that the failed message is still the one
waiting, and that it has no verdict, then changes the snapshot in the same synchronous step, so a
concurrent retry either launches first, making the change fail, or uses the new settings. The
change drops the thread's saved reviewer session, since a conversation may not resume under another
model; the next round starts a new one, which reads the earlier messages. The change doesn't retry
by itself, and a failed attempt doesn't count as a round. The CLI refuses `pair reviewer` from the
author or a reviewer (`PAIR_AUTO_ROLE`), so an author can't choose the reviewer that judges it. This
is workflow discipline, not a security boundary: the author can reach the socket.

A failed round keeps the request, and an explicit author `wait` retries it. Its error includes the
last error the reviewer reported in its JSON stream (Codex `error` or `turn.failed`; Claude's failed
`result`, from `errors[]` and `result`), capped at 4000 characters, with control characters escaped
and labeled as reviewer output. When a model or effort override is set, the error names it, says
that a retry keeps it, and names `pair reviewer --thread current` to change it first.

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
user message naming `"$PAIR_BIN"` and the launch's pairing (`--as`, `--to`), for conversations whose
instructions an older pair, or another pairing, recorded. The
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

### Served worktrees

`pair start --serve-worktrees` lets one owner review its subagents' own git worktrees, as specified
in [docs/specs/serve-worktrees.md](docs/specs/serve-worktrees.md). The author's environment carries
`PAIR_AUTO_OWNER`, the owner's state directory. A subagent inherits it, so its `pair send`, run in
its own worktree and channel, reaches the owner's socket, the only one a Claude author's sandbox
allows, with its worktree root and this run's ID. A request without a root, from an older CLI, is
the root's.

The first request from another worktree enrolls it. The owner checks that it is the canonical top
of a git worktree of the same repository, listed by `git worktree list`, with no manual Codex
session registered in its channel, which the owner computes under its own PAIR_HOME. It then claims
that worktree's auto socket and checks that the requested message is the one pending. Simultaneous
first contacts share one attempt. The claim keeps `pair start` and `pair reset` out of the
worktree, answers `pair status` and `pair reviewer --thread` there, and refuses `pair stop`. The
guardian removes claimed sockets with the owner's if the owner dies.

Rounds wait in one FIFO across all targets, the root included, with at most one entry per target. A
second request for the same message attaches to it, and a caller's disconnect doesn't cancel it. Up
to `--reviewers N` run at once (default 1). Each launch, completion and retry re-checks the
target's identity: its path, inode and git admin directory. A running child's identity is also
checked on each heartbeat, and on a mismatch the owner asks the guardian to stop that one job.
Failures, settings snapshots and reviewer sessions are kept per target and thread. A child's
requests never change the root's resume record, and nothing pair runs writes into a child: its
commands skip the instruction refresh, and every managed prompt carries the reviewer rules rendered
from `prompts/pair.md`.

## Manual reset

`pair reset` moves whole pending lanes into `resets/<reset-id>/` in the current channel, leaving
source files, archived history, and session registrations untouched. `--as` selects the lanes that
participant authored; omitting it resets every lane, independent of `PAIR_AGENT`. Moving whole
lanes also handles legacy flat files, malformed messages, partial writes, and older thread
directories without requiring successful protocol parsing. A small `reset.json` records the time, worktree and planned
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
- An author can't close a brainstorm; it asks the reviewer to complete, which costs a turn. A `## Spec` section's commit is the author's claim, which a managed Claude reviewer can't check, since it has no git access.
- Names other than `claude` and `codex` need this version on both sides. An older CLI refuses them, its `status`, `history` and `reset` don't see their lanes, and an older `pair mcp` wakes only `codex`.
- Polling, not fs events. A 1s delay is fine for chat between agents.
- Notifications were verified end to end with Codex CLI 0.162.1 and 0.163.0 on the shared app-server daemon, and with the ChatGPT desktop app, which runs its own app-server and starts its own `pair mcp` (with `PAIR_CODEX` pointing at the separately installed CLI). IDE sessions, `--no-daemon` and `--remote` are untested.
- Approval policy `never` makes `pair_listen` fail; Codex reports it and stops without polling.
- A Codex TUI started without config overrides can run its session on Codex's shared app-server daemon, whose commands get the daemon's environment, not the terminal's. `pair start` therefore also passes the author's `PAIR_*` variables as `-c shell_environment_policy.set.NAME=…` (any override also keeps the session in the TUI's own process, verified with Codex 0.167.0), and manual users set them the same way or name the participant in words. A managed Codex reviewer runs `codex exec`, which runs its commands itself.
- The MCP server is a child of the app-server daemon, not of the TUI, so notifications continue for 1–2 minutes after the last TUI on a session quits, until the daemon unloads it. A message in that gap starts a turn with no TUI attached.
- Completion-driven waiting is verified only for interactive Claude Code sessions. Headless `claude -p` ends background commands after its final result, so the prompt falls back to a foreground wait. A finished background command doesn't resume Codex, and a long `pair wait` that Codex keeps checking costs a model call per check, which is why Codex uses `pair mcp`.
