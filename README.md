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
  - the `never` approval policy failed.

  Desktop and IDE sessions are untested.
- `pair status` shows the registered session and the listener's last event. The full log is
  `~/.local/state/pair/<repo>-<hash>/codex.listen.log` (under `$XDG_STATE_HOME` if it is absolute).
  The server writes only there, never in the channel, which agents can write. At 256 KB it becomes
  `codex.listen.log.1`, replacing the previous one.

### Start the agents

After setup, start Claude Code and Codex in separate terminals in the same worktree of this repo. Each
worktree has its own channel, so an agent started in another checkout won't see the messages
(see [Worktrees](#worktrees)). Restart any sessions that were already open so they load the new
instructions and sandbox settings.

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

The agents run `send` and `wait` themselves. You'll mostly use `init`, `status`, `history` and `clean`.

```
pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <file|->
pair wait --as <claude|codex> [--timeout seconds]   # prints "no message … yet" on timeout
pair status
pair history [thread-id]   # list finished threads (latest first), or print one (any unique part of its id)
pair clean --keep N        # delete all but the N newest finished threads
pair init
pair uninit                # undo pair init in this worktree (keeps history; see "Uninstall")
pair register | unregister # run by Codex in its shell: let pair_listen notify this session
pair mcp                   # stdio MCP server for Codex (see "Let pair wake Codex")
```

`pair status` shows the channel, worktree root, installed package version, and each lane's turn.
It also checks the generated instructions on disk:

```
channel: /Users/you/.pair/your-repo-12345678
worktree: /Users/you/your-repo
version: claude-codex-pair 0.1.0
claude-to-codex: idle
codex-to-claude: idle
instructions on disk (does not verify what running agents loaded):
  AGENTS.md (pair section): current
  .claude/skills/pair/SKILL.md: current
codex notifications: session 01a13922-c08f-79e3-a41f-6780876fd9c5, registered 2026-10-14T08:00:00.000Z
  last listener event: 2026-10-14T08:05:12.345Z notified 01a13922-… about /Users/you/.pair/…/001-request.md
```

Instruction states are `current`, `stale`, `missing`, or `unreadable`. The check compares only
the marked pair section in `AGENTS.md`, so your other instructions don't affect it. Status
doesn't change files. Run `pair init` to refresh missing or stale instructions, then reload
agent sessions; fix access to unreadable files first. Current files on disk don't guarantee
that a running agent has loaded them.

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
