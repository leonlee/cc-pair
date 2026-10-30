# cc-pair

**Abstract.** `pair` lets Claude Code and Codex review each other's work. One agent authors a change,
the other reviews it, and they exchange messages through files in a shared directory. Roles are
symmetric. Reviews run either between two sessions you start yourself (manual mode) or with pair
launching the reviewer for each round (auto mode).

```
terminal A: claude                         terminal B: codex ("be my reviewer")
  finish task
  pair send request ──▶ ~/.pair/<repo>-<hash>/claude-to-codex/<thread>/001-request.md
  pair wait  ⏳                              pair wait ◀── picks it up
                    002-review.md ◀── pair send review --verdict changes
  verify findings, fix
  pair send response ──▶ 003-response.md
  pair wait  ⏳                              pair wait ◀── re-checks fixes
                    004-review.md ◀── pair send review --verdict approve
  done ✓
```

The key words MUST, MUST NOT, SHOULD and MAY are used as described in RFC 2119.
[DESIGN.md](DESIGN.md) specifies the protocol, storage layout and known limits.

## 1. Terminology

- **Channel**: the directory `~/.pair/<repo>-<hash>/` (under `$PAIR_HOME` if set). Each git
  worktree has its own channel, derived from its root.
- **Lane**: one direction within a channel, `claude-to-codex/` or `codex-to-claude/`, named by
  the author.
- **Thread**: one review, stored as numbered messages: `request`, then alternating `review` and
  `response`. It closes when the reviewer approves. If findings remain open after
  `PAIR_MAX_ROUNDS` rounds (default 3), it is **escalated** and both agents stop and ask the user.

## 2. Installation

```sh
npm install -g claude-codex-pair     # Node 22 or later; installs the `pair` command
```

From source: clone the repository and run `npm install && npm link`. A source install made before
the package was renamed MUST be removed first with `npm uninstall -g cc-pair`, or the install fails
with `EEXIST` on `bin/pair`.

## 3. Setup

Run once in each worktree:

```sh
pair init
```

`init` writes the agent instructions: `.claude/skills/pair/SKILL.md` for Claude Code and a marked
section of `AGENTS.md` for Codex. Claude Code 2.1.277 and later also reads `AGENTS.md`; the section
tells any agent other than Codex to ignore it.

Both agents' sandboxes MUST be able to write the channel root. `init` prints the snippets with your
actual path; for the default root they are:

```toml
# ~/.codex/config.toml
[sandbox_workspace_write]
writable_roots = ["/Users/you/.pair"]
```

```jsonc
// ~/.claude/settings.json
"sandbox": { "filesystem": { "allowWrite": ["~/.pair"] } }
```

Restart agent sessions that were open before setup.

### 3.1. Waking Codex (manual mode)

A finished background command does not resume Codex, and a polling `pair wait` costs a model call
per check. Codex therefore never polls: pair's MCP server wakes it when a message arrives. Register
the server once; `init` prints the command with your paths:

```sh
codex mcp add --env 'PAIR_CODEX=/opt/homebrew/bin/codex' pair -- '/path/to/node_modules/claude-codex-pair/dist/pair.js' mcp
```

Codex then runs `pair register` and calls the `pair_listen` tool before waiting. When a message for
it is pending, the server runs `codex queue` with a fixed note that never contains message text.

- The command SHOULD point at the installed package, not at a checkout you edit.
- `PAIR_CODEX` pins the `codex` executable, since the server runs outside Codex's sandbox and does
  not search `PATH`. `init` refuses to pin a `codex` in, or linked into, the worktree, the channel or
  a temp directory.
- Codex passes MCP servers only a few environment variables. `init` adds `PAIR_HOME` and
  `XDG_STATE_HOME` to the command when set; after changing them, run `codex mcp remove pair` and add
  the server again.
- `pair_listen` needs MCP tool approval: the `never` approval policy is unsupported. With
  `on-request`, approve the first call.
- Notifications stop after `pair unregister` ("stop as reviewer"), or when Codex's background service
  unloads the session, about 1–2 minutes after its last window closes. A message in that gap still
  starts a turn with no window attached.
- Without the server, Codex checks once, says it cannot be woken, and checks again only when asked
  ("check pair").
- The server writes only to `~/.local/state/pair/<repo>-<hash>/codex.listen.log` (under
  `$XDG_STATE_HOME` if absolute), rotated at 256 KB. `pair status` shows the registration and the
  last listener event.

Verified with Codex CLI 0.162.1 and 0.163.0 and the ChatGPT desktop app; IDE sessions are untested.
See DESIGN.md.

## 4. Manual mode

Start Claude Code and Codex in separate terminals in the same worktree.

1. In the reviewer's terminal, say **"be my reviewer"**. Claude waits on `pair wait` in a background
   command; Codex registers and ends its turn until woken.
2. In the author's terminal, finish a task and say **"ask codex for a review"** (or "ask claude").
3. The author verifies each finding, then fixes it or rejects it with a reason, and replies.
4. The thread ends on approval or escalation.

## 5. Auto mode

Supported on macOS and Linux. Both CLIs MUST be installed and signed in. `pair start` MUST be run
in your own terminal, outside an agent session. If the session's checkout lacks pair's instructions,
`pair start` runs `pair init` there first:

```sh
pair start --as claude    # interactive Claude, automatic Codex reviewer
pair start --as codex     # interactive Codex, automatic Claude reviewer
```

`pair start` first prints where the session will run, the author's conversation and the reviewer's
settings. In a terminal it then waits for Enter; anything else, Ctrl-C or end of input cancels
before anything is created. `-y` starts without waiting.

Give the author a task as usual. Each request or response it sends starts the partner as a
non-interactive reviewer for one round, and the review is returned inline to the author's
`pair send`. Follow-up rounds resume the reviewer's saved session; new threads start fresh ones.
Round limits and escalation are as in manual mode. Auto mode needs neither the MCP server nor a
second terminal.

### 5.1. Options

| Option | Default | Meaning |
|---|---|---|
| `--worktree NAME` | current worktree | Run in a dedicated worktree (§5.2) |
| `-y`, `--yes` | wait for Enter | Start without waiting for Enter |
| `--reviewer-model MODEL` | CLI default | Reviewer model ID or alias |
| `--reviewer-effort LEVEL` | CLI default | Codex: `none` `minimal` `low` `medium` `high` `xhigh` `max` `ultra`; Claude: `low` `medium` `high` `xhigh` `max` `ultracode` |
| `--reviewer-args="ARGS"` | none | More reviewer options, space-separated (§5.3) |
| `--claude PATH`, `--codex PATH` | first on `PATH` | Absolute path to each executable |
| `--timeout SECONDS` | 900 (max 86400) | Limit per review round; the author has none |
| `--grace SECONDS` | 2 (max 30) | Wait between termination and forced termination |
| `-- ARGS...` | none | Options for the interactive author (§5.3) |

```sh
pair start --as claude --worktree feature/login --reviewer-effort high -- --model opus
pair start --as codex --reviewer-model opus --reviewer-args="--max-budget-usd 2"
```

Reviewer overrides apply to every round, including resumed ones. Pair edits no CLI configuration.
`pair status` and `pair ps` show the requested overrides, with `CLI default` for omitted ones. An
unsupported model/effort combination fails the round and keeps the request.

### 5.2. Worktrees

`--worktree NAME` runs the session in the git worktree `../<repo>-NAME` (slashes become dashes):

- If the path does not exist, pair creates it on branch `NAME` with `git worktree add`. An existing
  local branch is checked out. A branch found only on remotes is created to track it: on one
  remote, that remote; on several, the one named by `checkout.defaultRemote`, and pair refuses if
  none is. Otherwise a new branch starts at `HEAD`, so uncommitted changes stay in the current
  checkout. A tag named `NAME` is never checked out instead.
- If the path exists, it MUST be a worktree of this repository. The session runs on whatever it
  has checked out, a branch that need not be `NAME` (it may have been renamed) or a detached
  `HEAD`; the summary shows which.
  Pair never switches it, and refuses to start if it changes while the summary waits for Enter.
- If the worktree lacks pair's instructions (a new branch has only what was committed), pair runs
  `pair init` there. The current checkout is left alone.
- The channel, author and reviewer all belong to the worktree. `pair status` and `pair stop` MUST be
  run there. The worktree remains after the session; remove it with `git worktree remove`.

All other options are validated before anything is created. The agents' own directory and worktree
options are refused (§5.3); use `--worktree` instead.

### 5.3. Forwarded arguments

Arguments after `--` are passed to the author before pair's own arguments; `--reviewer-args` are
passed to every reviewer round. `--reviewer-args` MUST be written with `=`, because its value starts
with a dash. Each list accepts only the options below, each with at most one value; repeat an
option for more. Anything else is refused with the supported list.

| | Author (`-- ARGS`) | Reviewer (`--reviewer-args`) |
|---|---|---|
| Claude | `--model`, `--effort`, `--permission-mode`, `--add-dir`, `--allowedTools`, `--disallowedTools`, `--mcp-config`, `--strict-mcp-config`, `--agent`, `--plugin-dir`, `-r`/`--resume`, `-c`/`--continue`, `--fork-session`, `-n`/`--name`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--verbose`, `--ide`, `--chrome`, `--no-chrome` | `--fallback-model`, `--max-budget-usd`, `--strict-mcp-config` |
| Codex | `-m`/`--model`, `-c`/`--config`, `-p`/`--profile`, `-s`/`--sandbox`, `-a`/`--ask-for-approval`, `--add-dir`, `-i`/`--image`, `--enable`, `--disable`, `--local-provider`, `--search`, `--oss`, `--no-alt-screen`, `--dangerously-bypass-approvals-and-sandbox` | `-c`/`--config` with a `model_*` key other than `model_reasoning_effort` |

The lists are allowlists because unlisted options can turn the author into a print or background
session (`-p`, `--bg`), select a Codex subcommand, move the author away from its channel (`--cd`,
`--worktree`), or replace settings pair passes. The reviewer list excludes everything that changes
its tools, permissions or sandbox (§10). Codex reviewer options must also work with `exec resume`.

A Codex author resumes a conversation with `-- resume <UUID> [options]`, by ID only; `resume`
MUST come first. Pair records the author's conversation ID when it knows it. A new Claude
conversation gets an ID pair picks (`--session-id`), and a resumed one keeps the ID it was given.
Otherwise (a new Codex conversation, or Claude's `--continue`, `--fork-session`, or `--resume` with
a name or search term), the CLI picks the conversation, and pair learns its ID from the author's
first review request, which carries the ID the CLI sets for the author's commands
(`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`). `--continue` picks the newest conversation in the
directory the session runs in, which is the worktree, not where you typed the command. `--continue`
and `--resume` together are refused.

### 5.4. Control and recovery

From another terminal in the session's worktree:

```sh
pair status    # lanes, auto session state, last failure, log location
pair ps -v     # pair processes by worktree, with full commands
pair stop      # stop the author, its reviewers and their tools
```

- At most one launcher owns a worktree. A registered manual Codex session blocks `pair start`
  until `pair unregister`.
- A failed launch, missing verdict or timeout keeps the request. The error includes the reviewer's
  own error message, shortened and with control characters escaped. The author retries the round
  with `pair wait --as <author>` in the same session, with the same reviewer settings. To change
  `--reviewer-model` or `--reviewer-effort`, stop the session and start it again.
- `pair status` and `pair stop` show the author's last known conversation ID (§5.3) and a command
  that starts the session again in this worktree and resumes it, for example
  `cd /path/to/worktree && pair start --as claude -- --resume <id>`, or `-- resume <id>` for Codex.
  Change any option in it before running it. This is recovery data: pair does not check that the
  conversation still exists.
- If the author can't be started at all, `pair start` says why and exits 1.
- Exiting the author stops its managed processes. If every supervising process is force-killed, a
  stale socket can remain; `pair status` names it, and it MUST be inspected and removed by hand.
- The author has the terminal's streams but no controlling terminal: programs that need `/dev/tty`,
  and Ctrl+Z, do not work in auto mode.
- Agents receive this run's CLI as `PAIR_BIN`. An interactive Claude author runs managed commands
  in the background, since a review can outlast the foreground tool timeout.
- Claude reuses a resumed conversation's recorded instructions, so the author's instructions name
  `"$PAIR_BIN"`, not a path. Instructions recorded by pair 0.6.1 or earlier name a path that is
  deleted when the session stops. Each launch's first message tells the author to use
  `"$PAIR_BIN"` instead; if it still runs the old path, tell it to.

Process supervision is specified in DESIGN.md.

## 6. Worktrees in manual mode

Each worktree has its own channel, so pairs in different worktrees run in parallel without seeing
each other's messages. Both agents MUST start in the same worktree:

```sh
git worktree add ../your-repo-feature -b feature/x
cd ../your-repo-feature
pair init     # unless AGENTS.md and .claude/skills/pair/ are committed on this branch
```

If messages do not arrive, compare the `channel:` line of `pair status` in each agent. Removing a
worktree leaves its channel; delete the directory that `pair status` reports.

## 7. Commands

Agents run `send` and `wait`; users mostly run `init`, `start`, `status`, `history`, `clean` and
`upgrade`. `pair help <command>` describes each command and its options.

```
pair init | uninit | upgrade
pair start --as <claude|codex> [options] [-- AUTHOR_ARGS...]     # §5
pair stop
pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <file|->
pair wait --as <claude|codex> [--timeout seconds]   # default 540; prints "no message … yet"
pair status
pair history [thread-id]     # finished threads, newest first, or one thread by any unique part of its id
pair clean --keep N          # delete all but the N newest finished threads
pair reset [--as <claude|codex>] [--dry-run]                     # §8.1
pair register | unregister   # run by Codex: let pair_listen notify this session
pair mcp                     # MCP server for Codex (§3.1)
pair ps [-v]
pair help [command]          # same as pair <command> --help
```

`pair status` reports the channel, worktree, version, each lane's state, and the instruction files
on disk:

```
channel: /Users/you/.pair/your-repo-12345678
worktree: /Users/you/your-repo
version: claude-codex-pair 0.5.2
claude-to-codex: idle
codex-to-claude: idle
instructions on disk (does not verify what running agents loaded):
  AGENTS.md (pair section): current
  .claude/skills/pair/SKILL.md: current
codex notifications: session 01a13922-c08f-79e3-a41f-6780876fd9c5, registered 2026-10-14T08:00:00.000Z
```

Instruction states are `current`, `stale`, `missing`, `unreadable`, or `newer` (written by a newer
pair; run `pair upgrade`). Run `pair init` for `missing` or `stale`, then reload the agents. `status`
and `init` also report a newer npm release, checked at most daily.

A channel access failure (`EACCES`, `EPERM`) names the path and prints the sandbox snippets for it.

## 8. Maintenance

### 8.1. Reset

`pair reset` clears stale pending requests by moving whole lanes to
`<channel>/resets/<reset-id>/` and printing the path.

```sh
pair reset --dry-run      # preview
pair reset                # both lanes
pair reset --as claude    # only requests Claude authored
```

Manual sessions SHOULD be stopped first. Reset refuses while an auto session owns the worktree
(`--dry-run` still works).
Backups keep every file, including malformed or partial ones, plus `reset.json`; unread verdicts
in a reset lane are no longer delivered. Source files, history and registrations are unchanged.
`history` and `clean` ignore backups; delete them by hand. A partial failure names the backup
already written.

### 8.2. Upgrade

Run `pair upgrade` in your own terminal; agent sandboxes block the network and global installs. It
installs the latest release and refreshes this worktree's instructions. Other worktrees refresh
on their next `send`, `wait`, `history` or `clean`. Instruction files are owned by pair and
overwritten, except files a newer pair wrote. Restart Claude Code and Codex afterwards.

From 0.1.x, also run `pair init` in each worktree, register the MCP server (§3.1), and restart
Codex with an approval policy that permits MCP tools.

### 8.3. Uninstall

Run `pair uninit` in each worktree. It removes the skill (unless edited), the pair section of
`AGENTS.md` (or the file, if nothing else remains) and the Codex registration, and prints the
command to delete message history. Then:

```sh
codex mcp remove pair
npm uninstall -g claude-codex-pair
```

and remove `~/.pair` from the sandbox settings.

## 9. Environment

| Variable | Default | Meaning |
|---|---|---|
| `PAIR_HOME` | `~/.pair` | Channel root. Relative paths resolve against the worktree root |
| `PAIR_AGENT` | none | Default for `--as` |
| `PAIR_MAX_ROUNDS` | `3` | Rounds before escalation |
| `PAIR_KEEP` | `100` | Finished threads kept; `all` keeps every thread, `0` none |
| `PAIR_NO_UPDATE_CHECK` | unset | Any value disables the npm release check |
| `PAIR_AUTO_SOCKET_DIR` | `/tmp/pair-auto-<uid>` | Private absolute directory for auto-mode sockets; keep it short |

## 10. Security considerations

- **Managed reviewers.** Codex runs with its `workspace-write` sandbox plus channel access; source
  edits are forbidden by its instructions, not by the OS. Claude runs with `dontAsk`, so beyond your
  configured permissions it may only read, search, and run `pair wait` and `pair send review`. Pair itself refuses every reviewer command
  except `wait`, `send`, `status` and `history`, and a reviewer never refreshes instruction files.
  These guard against mistakes and casual prompt injection, not a determined agent: the role comes
  from an environment variable, and the Codex sandbox can write the channel.
- **No loosening.** Auto mode passes neither CLI's permission-bypass flags to reviewers, and
  `--reviewer-args` cannot change their tools, permissions or sandbox. `--mcp-config` is excluded
  because MCP servers start outside tool permissions.
- **Claude author socket.** Pair grants a Claude author only this session's control socket, through
  `--settings`; your settings files are unchanged. If managed policy denies it, the request fails
  with the required setting named and stays on disk.
- **MCP server.** `pair mcp` runs outside Codex's sandbox, so it only reads the channel, writes only
  its state directory, and never forwards message text.
- **Processes.** Pair never signals a process by a saved PID or by executable name.

## Appendix A. Example review

Messages from a real run, shortened. The round-1 bug was planted.

```
== pair: review from codex · claude-to-codex · round 1 · verdict changes ==
### F1 [medium] src/paginate.js:8: Partial last pages are omitted from the page count
`totalPages(5, 2)` returns 2 ... Use `Math.ceil(count / pageSize)`.
### F2 [medium] src/paginate.js:2: Invalid pagination inputs produce unrelated items
`paginate([1, 2, 3, 4, 5], 1, -2)` returns `[1, 2, 3]` ...

== pair: review from codex · claude-to-codex · round 2 · verdict approve ==
F1 and F2 are fixed. I re-read src/paginate.js and ran 41 assertions ... All passed.
```
