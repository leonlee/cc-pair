# cc-pair

**Abstract.** `pair` lets Claude Code and Codex review each other's work. One agent authors a change,
the other reviews it, and they exchange messages through files in a shared directory. Roles are
symmetric. In auto mode, `pair start` opens the author and runs the other agent as the reviewer for
each round. In manual mode, you run both agents yourself.

A review thread, as it looks in manual mode (in auto mode, pair starts the reviewer for each round):

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
[DESIGN.md](DESIGN.md) specifies the protocol, storage layout, supervision and known limits.

## 1. Terminology

- **Channel**: the directory `~/.pair/<repo>-<hash>/` (under `$PAIR_HOME` if set). Each git
  worktree has its own channel, derived from its root.
- **Lane**: one direction within a channel, `claude-to-codex/` or `codex-to-claude/`, named by
  the author.
- **Thread**: one review, stored as numbered messages: `request`, then alternating `review` and
  `response`. It closes when the reviewer approves. If findings remain open after
  `PAIR_MAX_ROUNDS` rounds (default 3), it is **escalated** and both agents stop and ask the user.
- **Auto session**: one `pair start` run: the interactive author, the reviewer it starts for each
  round, and the processes that supervise them.

<a id="2-installation"></a>
<a id="3-setup"></a>
## 2. Installation and setup

```sh
npm install -g claude-codex-pair     # Node 22 or later; installs the `pair` command
```

From source: clone the repository and run `npm install && npm link`.

Both agents' sandboxes MUST be able to write the channel root. `pair init` prints these snippets
with your actual path; for the default root they are:

```toml
# ~/.codex/config.toml
[sandbox_workspace_write]
writable_roots = ["/Users/you/.pair"]
```

```jsonc
// ~/.claude/settings.json
"sandbox": { "filesystem": { "allowWrite": ["~/.pair"] } }
```

The agents learn pair from instructions in the worktree: `.claude/skills/pair/SKILL.md` for
Claude Code and a marked section of `AGENTS.md` for Codex. Claude Code also reads `AGENTS.md`; the
section tells any agent other than Codex to ignore it. `pair start` writes them where the session
runs if they are missing. For manual mode, run `pair init` once in each worktree. Restart agent
sessions that were open before setup.

<a id="5-auto-mode"></a>
## 3. Auto mode

Auto mode runs on macOS and Linux. Both CLIs MUST be installed and signed in, and `pair start`
MUST be run in your own terminal, outside an agent session. On Windows, or to run both agents
yourself, use [manual mode](#4-manual-mode).

```sh
pair start --as claude    # interactive Claude, automatic Codex reviewer
pair start --as codex     # interactive Codex, automatic Claude reviewer
```

Give the author a task as usual. Each request or response it sends starts the other agent as a
non-interactive reviewer for one round, and the review comes back inline to the author's
`pair send`. Follow-up rounds resume the reviewer's session; a new thread starts a fresh one.
Round limits and escalation are as in manual mode. Auto mode needs neither the MCP server nor a
second terminal.

Before it creates anything, `pair start` prints where the session will run, the author's
conversation, the reviewer's settings, and whether it will run `pair init` there:

```
pair: start auto mode in /Users/you/your-repo-feat (new worktree, branch feat); pair init runs there if its branch lacks the instructions
pair:   author claude · session 3f6c2a1e-5b7d-4c1f-9a2e-0d8b4e6f1a73 (new)
pair:   reviewer codex · model CLI default · effort CLI default
Start? [Y/n]
```

In a terminal it waits for Enter; anything else, Ctrl-C or end of input cancels before anything is
created. `-y` starts without waiting.

<a id="51-options"></a>
### 3.1. Options

| Option | Default | Meaning |
|---|---|---|
| `--worktree NAME` | current worktree | Run in the worktree `../<repo>-NAME` ([Worktrees](#5-worktrees)) |
| `--resume` | new conversation | Resume the author conversation pair last recorded there ([Author conversations](#33-author-conversations)) |
| `-y`, `--yes` | wait for Enter | Start without waiting for Enter |
| `--reviewer-model MODEL` | CLI default | Reviewer model ID or alias, passed as given (Codex IDs are case-sensitive) |
| `--reviewer-effort LEVEL` | CLI default | Codex: `none` `minimal` `low` `medium` `high` `xhigh` `max` `ultra`; Claude: `low` `medium` `high` `xhigh` `max` `ultracode` |
| `--reviewer-args="ARGS"` | none | More reviewer options, space-separated ([Forwarded arguments](#32-forwarded-arguments)) |
| `--claude PATH`, `--codex PATH` | first on `PATH` | Absolute path to each executable |
| `--timeout SECONDS` | 900 (max 86400) | Limit per review round; the author has none |
| `--grace SECONDS` | 2 (max 30) | Wait between termination and forced termination |
| `-- ARGS...` | none | Options for the interactive author ([Forwarded arguments](#32-forwarded-arguments)) |

```sh
pair start --as claude --worktree feature/login --reviewer-effort high -- --model opus
pair start --as codex --reviewer-model opus --reviewer-args="--max-budget-usd 2"
pair start --as claude --worktree feature/login --resume
```

Reviewer overrides apply to every round, including resumed ones; pair edits no CLI configuration.
`pair status` and `pair ps` show them, with `CLI default` for omitted ones. A model or effort the
reviewer rejects fails the round and keeps the request ([Control and recovery](#34-control-and-recovery)).

<a id="53-forwarded-arguments"></a>
### 3.2. Forwarded arguments

Arguments after `--` are passed to the author before pair's own arguments; `--reviewer-args` are
passed to every reviewer round. `--reviewer-args` MUST be written with `=`, because its value starts
with a dash. Each list accepts only the options below, each with at most one value; repeat an
option for more. Anything else is refused with the supported list.

| | Author (`-- ARGS`) | Reviewer (`--reviewer-args`) |
|---|---|---|
| Claude | `--model`, `--effort`, `--permission-mode`, `--add-dir`, `--allowedTools`, `--disallowedTools`, `--mcp-config`, `--strict-mcp-config`, `--agent`, `--plugin-dir`, `-r`/`--resume`, `-c`/`--continue`, `--fork-session`, `-n`/`--name`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--verbose`, `--ide`, `--chrome`, `--no-chrome` | `--fallback-model`, `--max-budget-usd`, `--strict-mcp-config` |
| Codex | `resume <id>` (first), `-m`/`--model`, `-c`/`--config`, `-p`/`--profile`, `-s`/`--sandbox`, `-a`/`--ask-for-approval`, `--add-dir`, `-i`/`--image`, `--enable`, `--disable`, `--local-provider`, `--search`, `--oss`, `--no-alt-screen`, `--dangerously-bypass-approvals-and-sandbox` | `-c`/`--config` with a `model_*` key other than `model_reasoning_effort` |

The lists are allowlists because unlisted options can turn the author into a print or background
session (`-p`, `--bg`), select a Codex subcommand, move the author away from its channel (`--cd`,
`--worktree`; use pair's `--worktree` instead), or replace settings pair passes. The reviewer list
excludes everything that changes its tools, permissions or sandbox
([Security considerations](#9-security-considerations)). Codex reviewer options must also work with
`exec resume`.

### 3.3. Author conversations

`pair start` opens a new author conversation unless told otherwise:

| To continue | Claude author | Codex author |
|---|---|---|
| A specific conversation | `-- --resume <id>` | `-- resume <id>` |
| The newest conversation in the session's worktree | `-- --continue` | not supported |
| The conversation pair last recorded for the worktree | `--resume` | `--resume` |

Codex is resumed by ID only, with `resume` as the first author argument. `--continue` picks the
newest conversation in the worktree the session runs in, not where you typed the command.
`--continue` and `--resume` cannot be combined.

Pair records the author's conversation ID for the worktree. It knows the ID at launch for a new
Claude conversation (pair picks it) and for a resume by ID. Otherwise, for a new Codex conversation,
`--continue`, `--fork-session`, or a resume by name or search term, the CLI picks the conversation
and pair learns its ID from the author's first review request. Until then, `pair status` shows it
as unknown.

`pair status` and `pair stop` show the last recorded ID and a command that starts the session again
in its worktree and resumes it, for example
`cd /path/to/worktree && pair start --as claude -- --resume <id>`. Change any option in it before
running it.

`pair start --resume` uses that record without copying the ID. The record MUST be for the same
CLI and have a known ID, the worktree MUST already exist, and the author arguments MUST NOT select
a conversation themselves. Only the conversation is reused: every other option comes from the
command line. The record is recovery data; pair does not check that the conversation still exists.

A conversation started with pair 0.6.1 or earlier may still name an old run's pair command in its
recorded instructions. Each launch tells the author to use `"$PAIR_BIN"` instead; if it still runs
the old path, tell it to.

<a id="54-control-and-recovery"></a>
### 3.4. Control and recovery

From another terminal in the session's worktree:

```sh
pair status    # lanes, auto session state, author conversation, last failure, log location
pair ps -v     # pair processes by worktree, with full commands
pair stop      # stop the author, its reviewers and their tools
```

- At most one launcher owns a worktree. A registered manual Codex session blocks `pair start`
  until `pair unregister`.
- A failed launch, missing verdict or timeout keeps the request, and the error includes the
  reviewer's own message. The author retries the round with `pair wait --as <author>`, with the
  same reviewer settings. To change `--reviewer-model` or `--reviewer-effort`, stop the session and
  start it again; `--resume` keeps the author's conversation.
- Exiting the author stops its managed processes. If every supervising process is force-killed, a
  stale socket can remain; `pair status` names it, and it MUST be inspected and removed by hand.
- The author has the terminal's streams but no controlling terminal: programs that need `/dev/tty`,
  and Ctrl+Z, do not work in auto mode.
- Agents receive this run's CLI as `PAIR_BIN`. An interactive Claude author runs managed commands
  in the background, since a review can outlast the foreground tool timeout.

Process supervision is specified in DESIGN.md.

## 4. Manual mode

Start Claude Code and Codex in separate terminals in the same worktree, after `pair init`.

1. In the reviewer's terminal, say **"be my reviewer"**. Claude waits on `pair wait` in a background
   command; Codex registers and ends its turn until woken ([Waking Codex](#41-waking-codex)).
2. In the author's terminal, finish a task and say **"ask codex for a review"** (or "ask claude").
3. The author verifies each finding, then fixes it or rejects it with a reason, and replies.
4. The thread ends on approval or escalation.

<a id="31-waking-codex-manual-mode"></a>
### 4.1. Waking Codex

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

<a id="52-worktrees"></a>
<a id="6-worktrees-in-manual-mode"></a>
## 5. Worktrees

Each worktree has its own channel, so pairs in different worktrees run in parallel without seeing
each other's messages. The author and reviewer MUST run in the same worktree, since the reviewer
reads the author's files.

In auto mode, `--worktree NAME` runs the session in the git worktree `../<repo>-NAME` (slashes
become dashes):

- If the path does not exist, pair creates it on branch `NAME` with `git worktree add`. An existing
  local branch is checked out. A branch found only on remotes is created to track it: on one
  remote, that remote; on several, the one named by `checkout.defaultRemote`, and pair refuses if
  none is. Otherwise a new branch starts at `HEAD`, so uncommitted changes stay in the current
  checkout. A tag named `NAME` is never checked out instead.
- If the path exists, it MUST be a worktree of this repository. The session runs on whatever it has
  checked out, which may be a renamed branch or a detached `HEAD`; the summary shows which. Pair
  never switches it, and refuses to start if it changes while the summary waits for Enter.
- If the worktree lacks the instructions, pair runs `pair init` there; the current checkout is left
  alone.
- `pair status` and `pair stop` MUST be run in the worktree. It remains after the session; remove it
  with `git worktree remove`.

The agents' own directory and worktree options are refused ([Forwarded arguments](#32-forwarded-arguments)).

In manual mode, start both agents in the worktree:

```sh
git worktree add ../your-repo-feature -b feature/x
cd ../your-repo-feature
pair init     # unless AGENTS.md and .claude/skills/pair/ are committed on this branch
```

If messages do not arrive, compare the `channel:` line of `pair status` in each agent. Removing a
worktree leaves its channel; delete the directory that `pair status` reports.

<a id="7-commands"></a>
## 6. Commands

Agents run `send` and `wait`; users mostly run `start`, `stop`, `status`, `history` and `upgrade`.
`pair help <command>` describes each command and its options.

```
pair start --as <claude|codex> [options] [-- AUTHOR_ARGS...]     # auto mode
pair stop
pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <file|->
pair wait --as <claude|codex> [--timeout seconds]   # default 540; prints "no message … yet"
pair status
pair history [thread-id]     # finished threads, newest first, or one thread by any unique part of its id
pair clean --keep N          # delete all but the N newest finished threads
pair reset [--as <claude|codex>] [--dry-run]
pair init | uninit | upgrade
pair register | unregister   # run by Codex: let pair_listen notify this session
pair mcp                     # MCP server for Codex (manual mode)
pair ps [-v]
pair help [command]          # same as pair <command> --help
```

`pair status` reports the channel, the worktree, the version, each lane's state, the instruction
files on disk, the Codex registration and the auto session:

```
channel: /Users/you/.pair/your-repo-12345678
worktree: /Users/you/your-repo
version: claude-codex-pair 0.7.2
claude-to-codex: awaiting-review (round 1, codex's turn)
codex-to-claude: idle
instructions on disk (does not verify what running agents loaded):
  AGENTS.md (pair section): current
  .claude/skills/pair/SKILL.md: current
codex notifications: no session registered
auto mode: claude author, codex reviewer · reviewing · owner 65158
  author session: 41646e9e-f45c-4c57-9ff4-d549cfdfc761 (resumed)
  reviewer model override: CLI default
  reviewer effort override: CLI default
  reviewer pid: 66012
  log: /Users/you/.local/state/pair/your-repo-12345678/auto.log
```

Instruction states are `current`, `stale`, `missing`, `unreadable`, or `newer` (written by a newer
pair; run `pair upgrade`). Run `pair init` for `missing` or `stale`, then reload the agents. `status`
and `init` also report a newer npm release, checked at most daily.

A channel access failure (`EACCES`, `EPERM`) names the path and prints the sandbox snippets for it.

<a id="8-maintenance"></a>
## 7. Maintenance

<a id="81-reset"></a>
### 7.1. Reset

`pair reset` clears stale pending requests by moving whole lanes to
`<channel>/resets/<reset-id>/` and printing the path.

```sh
pair reset --dry-run      # preview
pair reset                # both lanes
pair reset --as claude    # only requests Claude authored
```

Manual sessions SHOULD be stopped first. Reset refuses while an auto session owns the worktree
(`--dry-run` still works). Backups keep every file, including malformed or partial ones, plus
`reset.json`; unread verdicts in a reset lane are no longer delivered. Source files, history and
registrations are unchanged. `history` and `clean` ignore backups; delete them by hand. A partial
failure names the backup already written.

<a id="82-upgrade"></a>
### 7.2. Upgrade

Run `pair upgrade` in your own terminal; agent sandboxes block the network and global installs. It
installs the latest release and refreshes this worktree's instructions. Other worktrees refresh
on their next `send`, `wait`, `history` or `clean`. Instruction files are owned by pair and
overwritten, except files a newer pair wrote. Restart Claude Code and Codex afterwards; an auto
session restarts with `pair stop`, then `pair start --resume`.

<a id="83-uninstall"></a>
### 7.3. Uninstall

Run `pair uninit` in each worktree. It removes the skill (unless edited), the pair section of
`AGENTS.md` (or the file, if nothing else remains) and the Codex registration, and prints the
command to delete message history. Then:

```sh
codex mcp remove pair
npm uninstall -g claude-codex-pair
```

and remove `~/.pair` from the sandbox settings.

<a id="9-environment"></a>
## 8. Environment

| Variable | Default | Meaning |
|---|---|---|
| `PAIR_HOME` | `~/.pair` | Channel root. Relative paths resolve against the worktree root |
| `PAIR_AGENT` | none | Default for `--as` |
| `PAIR_MAX_ROUNDS` | `3` | Rounds before escalation |
| `PAIR_KEEP` | `100` | Finished threads kept; `all` keeps every thread, `0` none |
| `PAIR_NO_UPDATE_CHECK` | unset | Any value disables the npm release check |
| `PAIR_AUTO_SOCKET_DIR` | `/tmp/pair-auto-<uid>` | Private absolute directory for auto-mode sockets; keep it short |

<a id="10-security-considerations"></a>
## 9. Security considerations

- **Managed reviewers.** Codex runs with its `workspace-write` sandbox plus channel access; source
  edits are forbidden by its instructions, not by the OS. Claude runs with `dontAsk`, so beyond your
  configured permissions it may only read, search, and run `pair wait` and `pair send review`. Pair
  itself refuses every reviewer command except `wait`, `send`, `status` and `history`, and a
  reviewer never refreshes instruction files. These guard against mistakes and casual prompt
  injection, not a determined agent: the role comes from an environment variable, and the Codex
  sandbox can write the channel.
- **No loosening.** Auto mode passes neither CLI's permission-bypass flags to reviewers, and
  `--reviewer-args` cannot change their tools, permissions or sandbox. `--mcp-config` is excluded
  because MCP servers start outside tool permissions.
- **Claude author socket.** Pair grants a Claude author only this session's control socket, through
  `--settings`; your settings files are unchanged. If managed policy denies it, the request fails
  with the required setting named and stays on disk.
- **Reviewer output.** A failed round's error quotes the reviewer's own message, shortened, with
  control characters escaped and labeled as reviewer output rather than instructions.
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
