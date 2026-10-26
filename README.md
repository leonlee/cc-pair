# cc-pair

Claude Code and Codex review each other's work. Each runs as a live session in its own terminal,
and they talk through a shared directory on disk.

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

Roles are symmetric: Codex can ask Claude for a review the same way.

Pair also has an opt-in auto mode: open one interactive agent, and pair starts its partner for
each review round. The existing two-terminal workflow remains available.

## Install

```sh
npm install -g claude-codex-pair
```

Requires Node 22 or later. This installs the `pair` command.

To install from source, clone the repo, then run `npm install && npm link` inside it.

If you installed from source before the package was renamed to `claude-codex-pair`, run
`npm uninstall -g cc-pair` first. Otherwise the install fails with `EEXIST` on `bin/pair`.

## Setup (once per repo)

```sh
cd your-repo
pair init
```

`init` writes a Claude Code skill (`.claude/skills/pair/SKILL.md`) and a section in `AGENTS.md`
for Codex. Both explain the protocol to the agent.

Claude Code 2.1.277 and later can also read `AGENTS.md`. The pair section there starts by telling
any agent other than Codex to ignore it, so Claude keeps its own role. If you ran `pair init` with
an earlier version of this package, run it again to refresh both files.

Both agents' sandboxes must be able to write to `~/.pair`, or `$PAIR_HOME` if set. `pair init`
prints the configuration snippets with your actual path; add them to the corresponding configs.
For the default directory, they look like this:

```toml
# ~/.codex/config.toml
[sandbox_workspace_write]
writable_roots = ["/Users/you/.pair"]
```

```jsonc
// ~/.claude/settings.json
"sandbox": { "filesystem": { "allowWrite": ["~/.pair"] } }
```

### Let pair wake Codex (needed for automatic pickup)

Codex can't wait in the background the way Claude Code does: a finished background command doesn't
resume it, and keeping a `pair wait` running costs a model call for every check. So Codex doesn't
poll. Pair's MCP server wakes it when a message arrives. Without the server, Codex checks once, tells
you it can't be woken, and checks again only when you ask ("check pair"). Register the server once;
`pair init` prints this command with your actual paths:

```sh
codex mcp add --env 'PAIR_CODEX=/opt/homebrew/bin/codex' pair -- '/path/to/node_modules/claude-codex-pair/dist/pair.js' mcp
```

Codex then runs `pair register` in its shell and calls the `pair_listen` tool before it waits. The
MCP server watches the channel and runs `codex queue` with a fixed note when a message for Codex is
pending. The note never contains message text. Codex reads the message itself with `pair wait`.

- Point the command at the installed package, not at a checkout you edit. `PAIR_CODEX` pins the
  `codex` executable the server runs. The server runs outside Codex's sandbox, so it never looks
  `codex` up on `PATH`. It only reads the channel and keeps its own writes in a state directory
  (see below). `pair init` won't pin a
  `codex` that is in, or links into, the worktree, the channel directory, or a temp directory,
  because agents can write there.
- Codex starts MCP servers with only a few variables from your shell, such as `HOME` and `PATH`.
  If you set `PAIR_HOME` or `XDG_STATE_HOME`, `pair init` adds them to the command. If you change
  them later, run `codex mcp remove pair` and add the server again.
- `pair_listen` needs MCP tool approval, so Codex's `never` approval policy is unsupported. With
  `on-request`, approve the first call.
- Notifications stop when Codex runs `pair unregister` ("stop as reviewer"), or when Codex's
  background service unloads the session, which happened 1–2 minutes after the last window on it
  closed. A message that arrives in that gap still starts a turn with no window attached, and so does
  a note that pair already queued. Say "stop as reviewer" before closing Codex if that matters.
- Verified end to end with Codex CLI 0.162.1 on the shared app-server daemon. A registered session
  that ended its turn was woken by the note about 1s after Claude's request, and it reviewed and
  replied in one turn. These also behaved as described:
  - a message that arrived while Codex was closed was delivered right after resume;
  - `pair unregister` stopped notifications;
  - a forked session took over the registration;
  - two windows on one session got one note;
  - two worktrees each woke only their own Codex;
  - with Codex as the author, a `changes` review and the final approval each woke it once, and its
    `pair wait` archived the approved thread;
  - the `never` approval policy failed;
  - with Codex CLI 0.163.0, a session idle for about 2 hours was still woken 0.9s after the request
    and replied 9s after it.

  Codex in the ChatGPT desktop app works too: the app starts its own `pair mcp`, and in daily use
  with Codex as the author, each review woke it and it replied. IDE sessions are untested.
- `pair status` shows the registered session and the listener's last event. The full log is
  `~/.local/state/pair/<repo>-<hash>/codex.listen.log` (under `$XDG_STATE_HOME` if it is absolute).
  The server writes only there, never in the channel, which agents can write. At 256 KB it becomes
  `codex.listen.log.1`, replacing the previous one.

### Start the agents

For auto mode, see below. For the manual workflow, start both agents yourself:

After setup, start Claude Code and Codex in separate terminals in the same worktree of this repo. Each
worktree has its own channel, so an agent started in another checkout won't see the messages
(see [Worktrees](#worktrees)). Restart any sessions that were already open so they load the new
instructions and sandbox settings.

### Auto mode (macOS and Linux)

Install and sign in to both Claude Code and Codex first. After `pair init`, run either command in
your own terminal, outside an agent session:

```sh
pair start --as claude    # interactive Claude, automatic Codex reviewer
pair start --as codex     # interactive Codex, automatic Claude reviewer
```

Give the interactive agent a task as usual. When it sends a review request, pair starts the partner
in non-interactive mode in the same worktree. Each reviewer handles one round and exits. Follow-up
rounds resume that reviewer's saved session; new threads start fresh sessions. Requests and responses
return the review inline, so auto mode does not require pair's Codex MCP notification server or a
second terminal. The author still verifies findings and fixes or rejects them. The existing round
cap and escalation rules apply.

Auto mode uses a CLI wrapper belonging to this run. Agents receive its absolute path as `PAIR_BIN`,
so a login shell cannot accidentally use an older pair installation. The launcher passes the role
instructions at startup; the generated instructions from `pair init` also describe auto mode.
Claude receives them through `--append-system-prompt` so they survive a clear. Interactive Claude
runs managed `send` and retry commands in the Bash tool's background mode, then reads their output
on completion; a review can take longer than the foreground tool timeout.

For a Claude author, the launcher passes `sandbox.network.allowUnixSockets` through `--settings`,
allowing only this worktree's exact control socket for that session. It prints the path at startup,
uses the canonical `/private/tmp` path on macOS, and leaves your settings files unchanged. Existing
allowlist entries merge with this one. If managed policy still denies the connection, the failed
request names the required setting and stays on disk. See [Claude's sandbox documentation](https://code.claude.com/docs/en/sandboxing).

Use another terminal in this worktree to inspect or stop the session:

```sh
pair status
pair ps -v
pair stop                # stops the author and all managed reviewers/tools
```

Exiting the author also stops its managed workers. Pair uses separate process groups, a guardian
with a private parent connection and heartbeat, and termination followed by forced termination
after a grace period. The guardian cleans up if the launcher is force-killed. Cleanup covers
ordinary descendants that remain in their process group; deliberately detached descendants or
simultaneously killing both the launcher and guardian require OS-level supervision for stronger
guarantees. Pair never signals a process based on a saved PID or its executable name.
The heartbeat uses monotonic time so clock corrections and suspended wall-clock time do not expire
the session. Pair saves and restores terminal settings on exit, including after forced author
termination. Process-group isolation gives the author inherited terminal streams but no controlling
terminal: programs that require `/dev/tty` (such as some password prompts) and Ctrl+Z job control are
not supported in this mode. Run those operations from your own terminal.

Only one auto launcher can own a worktree at a time. Stop a manual reviewer before switching to
auto mode; an existing Codex registration blocks automatic Codex reviewer startup until you run
`pair unregister`. If all supervising processes are forcibly killed, a stale socket may remain.
`pair status` names it; inspect it before removing it and restarting. Pair does not automatically
take over stale sockets or kill the PIDs in old state files.

Reviewers use saved CLI authentication. Codex runs with its workspace-write sandbox and explicit
channel access. Its worktree is writable, for example for test artifacts; source edits are prohibited
by its instructions rather than an OS read-only boundary. Claude runs with `dontAsk`, its configured tool permissions, and additional allow
rules for reading/searching and the pair CLI; commands requiring other permission approval are
denied. Auto mode does not enable either CLI's permission-bypass flags. Keep the sandbox paths from
`pair init` configured for the author. A failed launch, missing verdict, or timeout preserves the
request. The author can run `pair wait --as <author>` inside the same auto session to retry that
round. `pair status` reports the last failure and the bounded log location.

Optional launch settings:

```sh
pair start --as claude --reviewer-model CODEX_MODEL_ID --reviewer-effort high
pair start --as codex --reviewer-model opus --reviewer-effort high
pair start --as claude --timeout 900 --grace 2
pair start --as codex --claude /absolute/path/to/claude --codex /absolute/path/to/codex
```

`--timeout` limits each reviewer round (default 900 seconds, maximum 86400); `--grace` is the wait
between termination and forced termination (default 2 seconds, maximum 30). Executables are
resolved once at startup. The interactive author is not subject to the reviewer timeout.

`--reviewer-model` accepts the partner CLI's model ID or alias. `--reviewer-effort` sets the
reviewer's reasoning effort. These overrides apply to every review round, including resumed
sessions, and leave the interactive author's settings alone. Either flag can be omitted; each
omitted setting inherits the reviewer CLI's normal defaults. No CLI configuration files are edited.

For Codex, effort is passed as `--config model_reasoning_effort="LEVEL"`; recognized levels are
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. For Claude, it is passed as
`--effort LEVEL`; recognized levels are `low`, `medium`, `high`, `xhigh`, `max`, and `ultracode`.
The installed CLI and selected model must support the requested combination; an unsupported
combination fails the review round and keeps the request available for recovery.

`pair status` and `pair ps` display the requested model and effort overrides. An omitted override
is shown as `CLI default`; pair does not claim to resolve the provider's inherited settings.

## Upgrading from 0.1.x

Codex no longer keeps a long `pair wait` running. To keep automatic pickup after upgrading, install
the new package with `npm install -g claude-codex-pair`, run `pair init` in each worktree, run the
printed `codex mcp add` command once, and restart Codex with an approval policy that permits MCP
tools (`-a on-request` worked in the live test). Without the MCP server, Codex checks once and then
checks again only when you ask it to "check pair", whether it is the author or reviewer.

## Use

1. In the reviewer's terminal, say **"be my reviewer"**. Claude waits on `pair wait` in a background
   command. Codex registers with pair's MCP server and ends its turn until a message wakes it.
2. In the author's terminal, finish a task and say **"ask codex for a review"** (or "ask claude").
3. Watch them go back and forth. The author verifies each finding before fixing it, and can reject
   one with a reason.
4. The thread ends when the reviewer approves. If findings are still open after 3 rounds, the thread
   is **escalated** and both agents stop and ask you.

## Worktrees

The channel comes from the worktree root, so each git worktree gets its own. You can run one pair
per worktree in parallel without them seeing each other's messages.

```sh
git worktree add ../your-repo-feature -b feature/x
cd ../your-repo-feature
pair init     # needed unless AGENTS.md and .claude/skills/pair/ are committed on this branch
pair status   # worktree: /Users/you/your-repo-feature
```

Then start Claude Code and Codex in `../your-repo-feature`, not in the main checkout. If one agent
never receives the other's messages, ask each agent to run `pair status` and compare the `channel:`
lines. Pair needs no extra sandbox config, because every channel lives under `~/.pair` (or `$PAIR_HOME`).

`git worktree remove` leaves the worktree's channel in `~/.pair`. To delete it too, run
`pair status` in the worktree first to get its `channel:` path, then remove that directory.

## Commands

The agents run `send` and `wait` themselves. You'll mostly use `init`, `status`, `history`, `clean` and `upgrade`.

```
pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <file|->
pair start --as <claude|codex> [--reviewer-model MODEL] [--reviewer-effort LEVEL]
           [--claude /path] [--codex /path] [--timeout seconds] [--grace seconds]
pair stop                  # stop this worktree's auto launcher and its managed agents
pair wait --as <claude|codex> [--timeout seconds]   # prints "no message … yet" on timeout
pair status
pair history [thread-id]   # list finished threads (latest first), or print one (any unique part of its id)
pair clean --keep N        # delete all but the N newest finished threads
pair init
pair upgrade               # install the latest pair from npm, then refresh this worktree's instructions
pair uninit                # undo pair init in this worktree (keeps history; see "Uninstall")
pair register | unregister # run by Codex in its shell: let pair_listen notify this session
pair mcp                   # stdio MCP server for Codex (see "Let pair wake Codex")
pair ps [-v]               # pair processes by worktree, including auto launchers/guardians (-v: full commands)
```

`pair status` shows the channel, worktree root, installed package version, and each lane's turn.
It also checks the generated instructions on disk:

```
channel: /Users/you/.pair/your-repo-12345678
worktree: /Users/you/your-repo
version: claude-codex-pair 0.2.0
claude-to-codex: idle
codex-to-claude: idle
instructions on disk (does not verify what running agents loaded):
  AGENTS.md (pair section): current
  .claude/skills/pair/SKILL.md: current
codex notifications: session 01a13922-c08f-79e3-a41f-6780876fd9c5, registered 2026-10-14T08:00:00.000Z
  last listener event: 2026-10-14T08:05:12.345Z notified 01a13922-… about /Users/you/.pair/…/001-request.md
```

Instruction states are `current`, `stale`, `newer`, `missing`, or `unreadable`. The check compares only
the marked pair section in `AGENTS.md`, so your other instructions don't affect it. Status
doesn't change files. Run `pair init` to refresh missing or stale instructions, then reload
agent sessions; fix access to unreadable files first. Current files on disk don't guarantee
that a running agent has loaded them. `newer` means a newer pair wrote them: run `pair upgrade`.

`pair status` and `pair init` also print a line when npm has a newer version. They check at most
once a day and cache the answer in `~/.local/state/pair/latest.json`. The check stays quiet when
offline or sandboxed.

## Upgrading

Run `pair upgrade` in your own terminal, not through an agent: agent sandboxes block the network and
global installs. If npm has a newer version, it runs `npm install -g claude-codex-pair@latest`, then
the new `pair init` in the current worktree if pair is set up there, and prints only the files that
`init` wrote or kept. Already on the latest version, it installs nothing and only refreshes this
worktree's stale instructions. Other worktrees refresh their instructions on the next
`pair send`, `wait`, `history` or `clean`. pair owns these files, so edits inside them are
overwritten. pair, including `pair init`, never rewrites instructions that a newer pair wrote, so
worktrees shared by different versions don't flip back and forth. To downgrade, delete them first. Restart Claude Code and Codex afterwards. Running
sessions keep the instructions they loaded at start, and Codex keeps its old `pair mcp` until
it restarts.

If a channel read or write fails with `EACCES` or `EPERM`, the command names the path and prints
sandbox configuration snippets using your actual channel directory. Check ordinary filesystem
permissions as well as sandbox settings. Automatic archive cleanup failures remain warnings,
so a cleanup problem doesn't prevent delivering a review or starting the next thread.

| Env var | Default | Meaning |
|---|---|---|
| `PAIR_HOME` | `~/.pair` | Root directory for channels. A relative path resolves against the worktree root; empty means the default |
| `PAIR_AGENT` | (none) | Default for `--as` |
| `PAIR_MAX_ROUNDS` | `3` | Number of review rounds before escalation |
| `PAIR_KEEP` | `100` | Finished threads to keep, by finish time. Older ones are deleted whenever a thread finishes. `all` keeps everything, `0` keeps none |
| `PAIR_NO_UPDATE_CHECK` | (none) | Any value turns off the daily npm version check |
| `PAIR_AUTO_SOCKET_DIR` | `/tmp/pair-auto-<uid>` | Optional absolute private directory for auto-mode sockets; keep it short for Unix socket path limits |

## Uninstall

In each worktree where you ran `pair init`:

```sh
pair uninit
```

This removes three things: `.claude/skills/pair/SKILL.md`, the pair section of `AGENTS.md` (or the
whole file, if it held nothing else), and the Codex session registration. It also cleans up files
written by older versions, and it leaves your own content alone: text outside the pair section stays
as it was, and a `SKILL.md` you edited is kept and reported. Message history stays in
`~/.pair/<repo>-<hash>/` and `~/.local/state/pair/<repo>-<hash>/`; `pair uninit` prints the
`rm -rf` command to delete it. Once no repo uses pair, also run:

```sh
codex mcp remove pair
npm uninstall -g claude-codex-pair
```

Then remove `~/.pair` from the sandbox settings you added during setup.

## Example review

These are messages from a real run, shortened. The bug in round 1 was planted on purpose.

```
== pair: review from codex · claude-to-codex · round 1 · verdict changes ==
### F1 [medium] src/paginate.js:8: Partial last pages are omitted from the page count
`totalPages(5, 2)` returns 2 ... Use `Math.ceil(count / pageSize)`.
### F2 [medium] src/paginate.js:2: Invalid pagination inputs produce unrelated items
`paginate([1, 2, 3, 4, 5], 1, -2)` returns `[1, 2, 3]` ...

== pair: review from codex · claude-to-codex · round 2 · verdict approve ==
F1 and F2 are fixed. I re-read src/paginate.js and ran 41 assertions ... All passed.
```

See [DESIGN.md](DESIGN.md) for the protocol, storage layout, and known limits.
