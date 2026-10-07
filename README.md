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

After setup, start Claude Code and Codex in separate terminals in the same worktree of this repo. Each
worktree has its own channel, so an agent started in another checkout won't see the messages. Restart any sessions
that were already open so they load the new instructions and sandbox settings.

## Use

1. In the reviewer's terminal, say **"be my reviewer"**. The agent loops on `pair wait`.
2. In the author's terminal, finish a task and say **"ask codex for a review"** (or "ask claude").
3. Watch them go back and forth. The author verifies each finding before fixing it, and can reject
   one with a reason.
4. The thread ends when the reviewer approves. If findings are still open after 3 rounds, the thread
   is **escalated** and both agents stop and ask you.

## Commands

The agents run `send` and `wait` themselves. You'll mostly use `init`, `status`, `history` and `clean`.

```
pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <file|->
pair wait --as <claude|codex> [--timeout seconds]   # prints "no message … yet" on timeout: run again
pair status
pair history [thread-id]   # list finished threads (latest first), or print one (any unique part of its id)
pair clean --keep N        # delete all but the N newest finished threads
pair init
```

| Env var | Default | Meaning |
|---|---|---|
| `PAIR_HOME` | `~/.pair` | Root directory for channels |
| `PAIR_AGENT` | (none) | Default for `--as` |
| `PAIR_MAX_ROUNDS` | `3` | Number of review rounds before escalation |
| `PAIR_KEEP` | `100` | Finished threads to keep, by finish time. Older ones are deleted whenever a thread finishes. `all` keeps everything, `0` keeps none |

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
