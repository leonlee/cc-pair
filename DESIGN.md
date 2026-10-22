# cc-pair design

Claude Code and Codex review each other's work. Each runs as a live session in its own terminal,
and they talk through a shared directory that works like a chat channel.

## Decisions

| Topic | Choice |
|---|---|
| Topology | Two live sessions. No headless spawning. |
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
process and an older copy on PATH would write the old templates.

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
pair uninit
pair register | unregister
pair mcp
```

## Known limits

- A lane still in the old flat layout (before 1c588ed) isn't migrated. Commands fail with a hint to move its files into a subdirectory, and the messages are left untouched.
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
