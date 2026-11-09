# cc-pair

**Abstract.** `pair` lets Claude Code and Codex review each other's work, or their own: Claude can
review Claude, and Codex can review Codex. One agent authors a change, the other reviews it, and they
exchange messages through files in a shared directory. Roles are symmetric. In auto mode,
`pair start` opens the author and runs a reviewer for each round. In manual mode, you run both
agents yourself.

Features:

- **Two modes.** Auto mode runs the author and starts the reviewer for each round, returning the
  review inline ([Auto mode](#3-auto-mode)). In manual mode you run both agents, and an MCP server
  wakes Codex without polling ([Manual mode](#5-manual-mode)).
- **Any pairing.** Cross-vendor by default; same-vendor pairs and any named participants, such as
  `alice` and `bob`, in either mode ([Participants](#4-participants)).
- **Code review.** Numbered findings with severity and an `approve` or `changes` verdict. Findings
  still open at the round cap escalate to you ([Workflows](#6-workflows)).
- **Spec review.** Plans and design docs in any format, such as a Markdown plan or an OpenSpec
  change; a later code review can cite the approved spec ([Spec review](#61-spec-review)).
- **Brainstorms.** Ideas before there's a design, with a fixed turn budget and a closing summary of
  options and open decisions ([Brainstorms](#62-brainstorms)).
- **Parallel work.** Subagents in their own worktrees, each with its own review loop, up to N
  reviews at once ([Parallel work](#63-parallel-work)).
- **Live reviewer settings.** `pair reviewer` changes the reviewer's model or effort without a
  restart ([Changing the reviewer](#35-changing-the-reviewer)).
- **Worktrees.** One channel per worktree, so pairs run side by side; `pair start --worktree`
  creates or reuses one ([Worktrees](#7-worktrees)).
- **Recovery.** Resumable author conversations, failed rounds that keep the request on disk for a
  retry, history, and reset ([Author conversations](#33-author-conversations),
  [Maintenance](#9-maintenance)).
- **Guard rails.** Reviewers are read-only by instruction, nothing loosens their permissions, and
  the author can't pick its reviewer's model
  ([Security considerations](#11-security-considerations)).
- **Small.** One Node CLI with no runtime dependencies; the agents learn it from a Claude skill and
  an `AGENTS.md` section, and you ask in your own words.

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
- **Participant**: a name for one side of a pair, such as `claude`, `codex` or `alice`. The CLI
  that runs it, Claude Code or Codex, is a property of the session, not of the name
  ([Participants](#4-participants)).
- **Lane**: one direction between two participants, `<author>-to-<reviewer>/`, such as
  `claude-to-codex/`.
- **Thread**: one exchange in a lane, stored as numbered messages: `request`, then alternating
  `review` and `response`. A review closes when the reviewer approves; if findings remain open after
  `PAIR_MAX_ROUNDS` rounds (default 3), it is **escalated** and both agents stop and ask the user. A
  [brainstorm](#62-brainstorms) closes as **completed**.
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

The Codex desktop app gives each session its own sandbox and may not apply `writable_roots`. There,
approve Codex's requests to run pair commands outside the sandbox, or, if the app lets you, give the
session write access to the channel root.

The agents learn pair from instructions in the worktree: `.claude/skills/pair/SKILL.md` for
Claude Code and a marked section of `AGENTS.md` for Codex. Claude Code also reads `AGENTS.md`; the
section tells any agent other than Codex to ignore it. `pair start` writes them where the session
runs if they are missing. For manual mode, run `pair init` once in each worktree. Restart agent
sessions that were open before setup.

<a id="5-auto-mode"></a>
## 3. Auto mode

Auto mode runs on macOS and Linux. The CLIs it runs MUST be installed and signed in, and
`pair start` MUST be run in your own terminal, outside an agent session. On Windows, or to run both
agents yourself, use [manual mode](#5-manual-mode).

```sh
pair start --as claude                        # interactive Claude, automatic Codex reviewer
pair start --as codex                         # interactive Codex, automatic Claude reviewer
pair start --as claude --reviewer-cli claude  # Claude reviewed by Claude (claude_reviewer)
```

Other pairings, and the options that choose them, are in [Participants](#4-participants).

Give the author a task as usual. Each request or response it sends starts the other agent as a
non-interactive reviewer for one round, and the review comes back inline to the author's
`pair send`. Follow-up rounds resume the reviewer's session; a new thread starts a fresh one.
Round limits and escalation are as in manual mode. Auto mode needs neither the MCP server nor a
second terminal.

Before it creates a worktree, writes a file or starts an agent, `pair start` prints where the
session will run, the author's conversation, the reviewer's settings, and whether it will run
`pair init` there:

```
pair: start auto mode in /Users/you/your-repo-feat (new worktree, branch feat); pair init runs there if its branch lacks the instructions
pair:   author claude · session 3f6c2a1e-5b7d-4c1f-9a2e-0d8b4e6f1a73 (new)
pair:   reviewer codex · model CLI default · effort CLI default
Start? [Y/n]
```

In a terminal it waits for Enter; anything else, Ctrl-C or end of input cancels, and nothing is
started. `-y` starts without waiting.

<a id="51-options"></a>
### 3.1. Options

| Option | Default | Meaning |
|---|---|---|
| `--cli`, `--reviewer NAME`, `--reviewer-cli` | from `--as` | The author's CLI, and the reviewer's name and CLI ([Participants](#4-participants)) |
| `--worktree NAME` | current worktree | Run in the worktree `../<repo>-NAME` ([Worktrees](#7-worktrees)) |
| `--resume` | new conversation | Resume the author conversation pair last recorded for the session's worktree ([Author conversations](#33-author-conversations)) |
| `-y`, `--yes` | wait for Enter | Start without waiting for Enter |
| `--reviewer-model MODEL` | CLI default | Reviewer model ID or alias, passed as given (Codex IDs are case-sensitive) |
| `--reviewer-effort LEVEL` | CLI default | Codex: `none` `minimal` `low` `medium` `high` `xhigh` `max` `ultra`; Claude: `low` `medium` `high` `xhigh` `max` `ultracode` |
| `--reviewer-args="ARGS"` | none | More reviewer options, space-separated ([Forwarded arguments](#32-forwarded-arguments)) |
| `--serve-worktrees` | off | Also review subagents' own worktrees of this repository ([Parallel work](#63-parallel-work)) |
| `--reviewers N` | 1 (max 8) | Review rounds at once, across all served worktrees; needs `--serve-worktrees` |
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
reviewer rejects fails the round and keeps the request
([Control and recovery](#34-control-and-recovery)). `pair reviewer` changes them while the session
runs ([Changing the reviewer](#35-changing-the-reviewer)).

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
([Security considerations](#11-security-considerations)). Codex reviewer options must also work with
`exec resume`.

### 3.3. Author conversations

`pair start` opens a new author conversation unless told otherwise:

| To continue | Claude author | Codex author |
|---|---|---|
| A specific conversation | `pair start --as claude -- --resume <id>` | `pair start --as codex -- resume <id>` |
| The newest conversation in the session's worktree | `pair start --as claude -- --continue` | not supported |
| The conversation pair last recorded for the worktree | `pair start --as claude --resume` | `pair start --as codex --resume` |

The last row uses pair's own `--resume`, before `--`; the others pass the CLI's options after `--`.

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
`cd /path/to/worktree && pair start --as claude -- --resume <id>`. You can change its options
before running it.

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
pair reviewer  # change the reviewer's model or effort (Changing the reviewer)
pair stop      # stop the author, its reviewers and their tools
```

- At most one launcher owns a worktree. A registered manual Codex session blocks `pair start`
  until `pair unregister --as NAME`.
- A reviewer that fails to start, ends without a verdict or times out keeps the request, and the
  error includes the reviewer's own message. The author retries the round with
  `pair wait --as <author>`, with the same reviewer settings; to change them first, see
  [Changing the reviewer](#35-changing-the-reviewer).
- With `--serve-worktrees`, `pair stop` in the session's worktree also stops reviews queued or
  running for subagent worktrees; their requests stay on disk ([Parallel work](#63-parallel-work)).
- Exiting the author stops its managed processes. If every supervising process is force-killed, a
  stale socket can remain; `pair status` names it, and it MUST be inspected and removed by hand.
- The author has the terminal's streams but no controlling terminal: programs that need `/dev/tty`,
  and Ctrl+Z, do not work in auto mode.
- Agents receive this run's CLI as `PAIR_BIN`. An interactive Claude author runs managed commands
  in the background, since a review can outlast the foreground tool timeout.

Process supervision is specified in DESIGN.md.

### 3.5. Changing the reviewer

`pair reviewer` changes a running session's reviewer settings without a restart. Run it in your own
terminal, in the session's worktree: the author and its reviewer can't, so neither picks the model
that judges its work. `pair status` shows the current settings.

```sh
pair reviewer --reviewer-model gpt-6.1-sol --reviewer-effort high   # threads opened from now on
pair reviewer --reviewer-effort default                             # back to the CLI's default
pair reviewer --thread current --reviewer-model gpt-6.1-sol         # the thread whose round failed
```

A thread keeps the settings of its first round for its follow-up rounds and retries, so a plain
change applies to new threads and to the restart command that `pair stop` prints.
`--thread current` (or the thread's ID) changes only a pending thread whose last round failed, for
example after a mistyped model. Its next round starts a new reviewer conversation that reads the
thread so far. Then tell the author to retry.

## 4. Participants

A pair is two participants: one authors, the other reviews. `claude` and `codex` are the default
names, each partnered with the other, so nothing changes unless you name others. A name is lowercase
letters, digits and underscores, up to 32 characters, starting with a letter. Each pair of names has
its own lane, so a participant can have one open thread with each partner.

**Auto mode.** `--as` names the author; the options below choose its CLI and its reviewer:

| Option | Default |
|---|---|
| `--cli claude\|codex` | The author's name, if it is `claude` or `codex`; required otherwise |
| `--reviewer-cli claude\|codex` | Without `--reviewer`, the CLI the author doesn't use; with `--reviewer claude` or `codex`, that CLI; required for other reviewer names |
| `--reviewer NAME` | With one CLI on both sides, `<cli>_reviewer`; otherwise the author's default partner (`claude` for `codex`, `codex` for `claude`); required for other authors |

```sh
pair start --as codex --reviewer-cli codex                              # codex reviewed by codex_reviewer
pair start --as alice --cli claude --reviewer bob --reviewer-cli claude  # two Claude participants
```

Only the CLIs the pairing uses must be installed. A same-CLI reviewer gets its own conversation per
thread, never the author's. The summary, `pair status` and the restart command show the pairing; it
can't change while the session runs.

**Manual mode.** Each session needs its name and partner. Set them when you start the agent:

```sh
PAIR_AGENT=alice PAIR_PARTNER=bob claude     # terminal A: the author
PAIR_AGENT=bob PAIR_PARTNER=alice claude     # terminal B: "be my reviewer"
```

A Codex session may run its commands in Codex's shared background service, which doesn't see the
terminal's environment, so give Codex its variables as configuration instead:

```sh
codex -c 'shell_environment_policy.set.PAIR_AGENT="alice"' -c 'shell_environment_policy.set.PAIR_PARTNER="bob"'
```

Or tell the agent in words: "you are bob; your partner is alice". Without either, a Claude session is
`claude` and a Codex session `codex`, as before. The agents pass `--as` on every command and `--to`
on every `send`; a reply goes to whoever sent the message, as the `== next:` line of `pair wait`
says. A Codex participant other than `codex` registers for wake-ups with `pair register --as NAME`.

**Compatibility.** Nothing on disk is renamed: existing lanes, history and registrations work as
they are. Names other than `claude` and `codex` need this version on both sides: an older pair
refuses them, its `status`, `history` and `reset` don't see their lanes, and an older `pair mcp`
wakes only `codex`, so restart Codex after upgrading.

<a id="4-manual-mode"></a>
## 5. Manual mode

Start Claude Code and Codex in separate terminals in the same worktree, after `pair init`.

1. In the reviewer's terminal, say **"be my reviewer"**. Claude waits on `pair wait` in a background
   command; Codex registers and ends its turn until woken ([Waking Codex](#51-waking-codex)).
2. In the author's terminal, finish a task and say **"ask codex for a review"** (or "ask claude",
   or the partner's name).
3. The author verifies each finding, then fixes it or rejects it with a reason, and replies.
4. The thread ends on approval or escalation.

Spec reviews and brainstorms work the same way ([Workflows](#6-workflows)).

<a id="31-waking-codex-manual-mode"></a>
<a id="41-waking-codex"></a>
### 5.1. Waking Codex

A finished background command does not resume Codex, and a polling `pair wait` costs a model call
per check. Codex therefore never polls: pair's MCP server wakes it when a message arrives. Register
the server once; `init` prints the command with your paths:

```sh
codex mcp add --env 'PAIR_CODEX=/opt/homebrew/bin/codex' pair -- '/path/to/node_modules/claude-codex-pair/dist/pair.js' mcp
```

Codex then runs `pair register --as <its name>` and calls the `pair_listen` tool before waiting. When a message for
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
- Notifications stop after `pair unregister --as <its name>` ("stop as reviewer"), or when Codex's background service
  unloads the session, about 1–2 minutes after its last window closes. A message in that gap still
  starts a turn with no window attached.
- Without the server, Codex checks once, says it cannot be woken, and checks again only when asked
  ("check pair").
- The server writes only to `~/.local/state/pair/<repo>-<hash>/codex.listen.log` (under
  `$XDG_STATE_HOME` if absolute), rotated at 256 KB. `pair status` shows the registration and the
  last listener event.

<a id="5-workflows"></a>
## 6. Workflows

Ask the author in your own words; it runs the pair commands. In Claude Code, `/pair <request>`
loads pair's instructions explicitly; Codex always has them in `AGENTS.md`. The examples name codex
as the reviewer; with a Codex author, say claude, or use your partner's name. Every workflow works in
both modes.

| Ask the author | The reviewer | The thread ends |
|---|---|---|
| "ask codex for a review" | reports findings with severity: `approve` or `changes` | approved, or escalated after `PAIR_MAX_ROUNDS` rounds |
| "ask codex to review the plan in docs/plan.md" | checks the document: `approve` or `changes` | the same |
| "brainstorm with codex how to …" | adds options and questions: `continue` or `complete` | completed, at the latest on the last turn |
| "use a subagent per PR, each in its own worktree" (session started with `--serve-worktrees`) | reviews each subagent's worktree, up to `--reviewers N` at once | per subagent, as for a review |

For a larger change, chain them: brainstorm the approach, write a plan and have it reviewed, then
implement it and cite the spec review in the code review.

<a id="51-spec-review"></a>
### 6.1. Spec review

A spec, plan or design doc is reviewed like code, in any format: a Markdown plan, an OpenSpec
change, an ADR. The request names the document's paths and the commit they're at, or says they're
uncommitted, and includes the result of the format's own validator if it has one, such as
`openspec validate`. The reviewer checks the document, not code: ambiguous or contradictory
requirements, missing edge cases and error handling, acceptance criteria that can't be tested,
scope, and plans the current code can't support. Approval covers that version of the document, not an implementation.

When the author implements a reviewed spec, its code-review request cites it:

```
## Spec
Thread 2026-11-06T05-19-31-945Z-da0bac (pair history da0bac).
docs/plan.md, approved at abc1234; unchanged since.
```

The reviewer reads that thread with `pair history` and reports where the code departs from the
spec, or says it can't find it. `pair history` covers the repository's existing worktrees, so a spec
reviewed in one worktree can be cited from another, a served subagent's included; it finds their
channels with the caller's `PAIR_HOME`. Pair parses neither section; this is part of the agents'
instructions.

<a id="52-brainstorms"></a>
### 6.2. Brainstorms

A brainstorm is for ideas before there's a design. The author opens it with
`pair send request --brainstorm`, giving the problem, the constraints and what's decided, and may
leave its own proposal out of the first message to get independent ideas. The reviewer answers with
options, trade-offs and questions and a verdict of `continue` or `complete`, and the author replies
with `pair send response`, as in a review:

```
== pair: brainstorm review from codex · claude-to-codex · round 1 · verdict continue ==
Option A: an in-memory LRU … Option B: HTTP ETags … How stale may a read be?
== next: reply with your answers, objections or your own proposal: pair send response --as claude <file|-> ==
```

The reviewer gets `PAIR_MAX_ROUNDS` turns (default 3), fixed when the brainstorm opens. On the last
one `continue` is refused, and the reviewer completes it with the options considered, a
recommendation and the open decisions. To stop earlier, tell the author you have enough; it asks
the reviewer to complete. A brainstorm never escalates, and `pair history` lists it as `completed`.

Both agents MUST run pair 0.8.0 or later: an older pair rejects a brainstorm as a corrupt message
instead of reviewing it as code.

<a id="53-parallel-work"></a>
### 6.3. Parallel work

An author MAY split work across subagents, in one of three shapes:

- **One change, several subagents.** The author alone runs the pair loop. Its instructions tell it
  to have each subagent return its changes and validation results without running pair commands,
  integrate them into the session's worktree, and request review of the combined change, keeping
  the checkout stable while the reviewer runs. A subagent inherits the author's pair environment,
  so without that rule it could open a thread of its own: in the shared checkout, against files
  others are still editing, or in its own worktree, where no auto session serves the request.
- **Separate PRs, reviewed in turn.** The author checks out each branch in the session's worktree
  and finishes that PR's review loop before the next.
- **Separate PRs, reviewed in parallel.** Run one `pair start --worktree NAME` session per PR
  ([Worktrees](#7-worktrees)), or let one session serve its subagents' worktrees (below).

Approval of separate pieces doesn't cover a later merge of their work; review the integrated result
as well.

#### Serving subagent worktrees

Start the session with `--serve-worktrees`; `--reviewers N` runs up to N reviews at once (default 1,
max 8):

```sh
pair start --as claude --serve-worktrees --reviewers 2
```

Then ask the author for parallel work, for example: *"Use two subagents, each in its own worktree:
one fixes the parser bug, the other adds the CSV export. Each runs its own pair review loop and
reports the outcome."* The author prompt gives the author the rules to pass to each subagent: send
requests and responses from its own worktree in the background, keep the worktree unchanged while a
review is queued or running, finish the loop, leave the worktree in place, and report approval,
escalation or the failure as printed.

- **Enrollment.** A worktree's first request enrolls it, after pair checks that it is a worktree of
  this repository and that the request comes from this session. The session claims that worktree's
  auto-mode socket, so no other session or reset runs there until this one stops.
- **Queue.** Reviews from every worktree, the session's own included, wait in one
  first-come-first-served queue, and up to N run at once. A retry attaches to its waiting or running
  round.
- **Failures.** A failed round affects only its worktree. A worktree that is removed or replaced,
  including a replaced `.git`, fails alone, and its reviewer is stopped.
- **No writes.** Pair writes nothing in a served worktree, not even instruction files: the
  reviewer's rules come in its prompt.

`pair status` in the session's worktree shows the queue:

```
  serves subagent worktrees · reviewers 2 · running 2 · queued 0
  running: /Users/you/your-repo/.claude/worktrees/agent-a0b4 (thread 2026-11-06T13-43-14-155Z-66b9d4, pid 30452)
  running: /Users/you/your-repo/.claude/worktrees/agent-ae4d (thread 2026-11-06T13-43-16-364Z-c9eb51, pid 31639)
```

In a served worktree, `pair status` names the serving session, and `pair reviewer --thread current`
fixes that worktree's failed round. `pair stop`, `pair start` and `pair reset` are refused there;
`pair stop` in the session's worktree stops everything. Worktrees stay served until the session
stops.

Pair never creates, merges or removes worktrees. Claude Code may create subagent worktrees under the
main checkout's `.claude/worktrees/`, based on the default branch rather than the session's branch,
and lock them. After the session, check each one's base and changes before opening its PR, then
`git worktree unlock` and `git worktree remove` it.

<a id="5-worktrees"></a>
<a id="52-worktrees"></a>
<a id="6-worktrees-in-manual-mode"></a>
<a id="6-worktrees"></a>
## 7. Worktrees

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
- `pair status` and `pair stop` MUST be run in the worktree. The worktree remains after the session;
  remove it with `git worktree remove`.

The agents' own directory and worktree options are refused ([Forwarded arguments](#32-forwarded-arguments)).

In manual mode, start both agents in the worktree:

```sh
git worktree add ../your-repo-feature -b feature/x
cd ../your-repo-feature
pair init     # unless AGENTS.md and .claude/skills/pair/ are committed on this branch
```

If messages do not arrive, compare the `channel:` line of `pair status` in each agent. Removing a
worktree leaves its channel; delete the directory that `pair status` reports.

<a id="6-commands"></a>
<a id="7-commands"></a>
## 8. Commands

Agents run `send` and `wait`; users mostly run `start`, `stop`, `status`, `reviewer`, `history` and
`upgrade`.
`pair help <command>` describes each command and its options.

```
pair start --as NAME [--cli CLI] [--reviewer NAME] [--reviewer-cli CLI] [options] [-- AUTHOR_ARGS...]
pair stop
pair reviewer [--reviewer-model MODEL|default] [--reviewer-effort LEVEL|default] [--thread current|ID]
pair send <request|review|response> --as NAME [--to NAME] [--brainstorm] [--verdict VERDICT] <file|->
                             # approve|changes, or continue|complete in a brainstorm
pair wait --as NAME [--timeout seconds]   # default 540; prints "no message … yet"
pair status
pair history [thread-id]     # finished threads in this repository's worktrees, or one by any part of its id
pair clean --keep N          # delete all but the N newest finished threads
pair reset [--as NAME] [--dry-run]
pair init | uninit | upgrade
pair register | unregister [--as NAME]   # run by Codex: let pair_listen notify this session
pair mcp                     # MCP server for Codex (manual mode)
pair ps [-v]
pair help [command]          # same as pair <command> --help
```

`pair status` reports the channel, the worktree, the version, each lane's state (the two default
lanes, and any other lane in the channel), the instruction files on disk, the Codex registrations and
the auto session:

```
channel: /Users/you/.pair/your-repo-12345678
worktree: /Users/you/your-repo
version: claude-codex-pair 0.9.0
claude-to-codex: brainstorm awaiting-review (round 1, codex's turn)
codex-to-claude: idle
instructions on disk (does not verify what running agents loaded):
  AGENTS.md (pair section): current
  .claude/skills/pair/SKILL.md: current
codex notifications: no session registered
auto mode: claude author, codex reviewer · reviewing · owner 41820
  author session: 3f6c2a1e-5b7d-4c1f-9a2e-0d8b4e6f1a73 (resumed)
  reviewer for new threads: model gpt-6.1-sol · effort high
  reviewer for thread 2026-11-06T05-19-31-945Z-da0bac: model CLI default · effort CLI default
  serves subagent worktrees · reviewers 2 · running 1 · queued 0
  running: /Users/you/your-repo (thread 2026-11-06T05-19-31-945Z-da0bac, pid 41907)
  reviewer pid: 41907
  log: /Users/you/.local/state/pair/your-repo-12345678/auto.log
```

Instruction states are `current`, `stale`, `missing`, `unreadable`, or `newer` (written by a newer
pair; run `pair upgrade`). Run `pair init` for `missing` or `stale`, then reload the agents. `status`
and `init` also report a newer npm release, checked at most daily.

A channel access failure (`EACCES`, `EPERM`) names the path and prints the sandbox snippets for it.

<a id="7-maintenance"></a>
<a id="8-maintenance"></a>
## 9. Maintenance

<a id="71-reset"></a>
<a id="81-reset"></a>
### 9.1. Reset

`pair reset` clears stale pending requests by moving whole lanes to
`<channel>/resets/<reset-id>/` and printing the path.

```sh
pair reset --dry-run      # preview
pair reset                # every lane
pair reset --as claude    # only lanes claude authored
```

Manual sessions SHOULD be stopped first. Reset refuses while an auto session owns the worktree
(`--dry-run` still works). Backups keep every file, including malformed or partial ones, plus
`reset.json`; unread verdicts in a reset lane are no longer delivered. Source files, history and
registrations are unchanged. `history` and `clean` ignore backups; delete them by hand. A partial
failure names the backup already written.

<a id="72-upgrade"></a>
<a id="82-upgrade"></a>
### 9.2. Upgrade

Run `pair upgrade` in your own terminal; agent sandboxes block the network and global installs. It
installs the latest release and refreshes this worktree's instructions. Other worktrees refresh
on their next `send`, `wait`, `history` or `clean`. Instruction files are owned by pair and
overwritten, except files a newer pair wrote. Restart Claude Code and Codex afterwards. To restart
an auto session in the same conversation, run `pair stop`, then `pair start --resume`
([Author conversations](#33-author-conversations)).

<a id="73-uninstall"></a>
<a id="83-uninstall"></a>
### 9.3. Uninstall

Run `pair uninit` in each worktree. It removes the skill (unless edited), the pair section of
`AGENTS.md` (or the file, if nothing else remains) and the Codex registrations, and prints the
command to delete message history. Then:

```sh
codex mcp remove pair
npm uninstall -g claude-codex-pair
```

and remove `~/.pair` from the sandbox settings.

<a id="8-environment"></a>
<a id="9-environment"></a>
## 10. Environment

For Codex, set these with `-c 'shell_environment_policy.set.NAME="value"'` rather than in the
terminal ([Participants](#4-participants)); `pair start` does this for the agents it launches.

| Variable | Default | Meaning |
|---|---|---|
| `PAIR_HOME` | `~/.pair` | Channel root. Relative paths resolve against the worktree root |
| `PAIR_AGENT` | none | Your participant name: the default for `--as` |
| `PAIR_PARTNER` | the default partner | Whom a new request goes to without `--to` ([Participants](#4-participants)) |
| `PAIR_MAX_ROUNDS` | `3` | Review rounds before escalation; a brainstorm's turns, fixed when it opens |
| `PAIR_KEEP` | `100` | Finished threads kept; `all` keeps every thread, `0` none |
| `PAIR_NO_UPDATE_CHECK` | unset | Any value disables the npm release check |
| `PAIR_AUTO_SOCKET_DIR` | `/tmp/pair-auto-<uid>` | Private absolute directory for auto-mode sockets; keep it short |

<a id="9-security-considerations"></a>
<a id="10-security-considerations"></a>
## 11. Security considerations

- **Managed reviewers.** Codex runs with its `workspace-write` sandbox plus channel access; source
  edits are forbidden by its instructions, not by the OS. Claude runs with `dontAsk`, so beyond your
  configured permissions it may only read, search, and run `pair wait`, `pair send review` and
  `pair history` (to read a spec review a request cites). Pair itself refuses every reviewer command
  except `wait`, `send`, `status` and `history`, and a reviewer never refreshes instruction files.
  These guard against mistakes and casual prompt injection, not a determined agent: the role comes
  from an environment variable, and the Codex sandbox can write the channel.
- **No loosening.** Auto mode passes neither CLI's permission-bypass flags to reviewers, and
  `--reviewer-args` cannot change their tools, permissions or sandbox. `--mcp-config` is excluded
  because MCP servers start outside tool permissions.
- **Claude author socket.** Pair grants a Claude author only this session's control socket, through
  `--settings`; your settings files are unchanged. If managed policy denies it, the request fails
  with the required setting named and stays on disk.
- **Served worktrees.** With `--serve-worktrees`, the owner reviews a worktree only after checking
  that it is a git worktree of the same repository, that the request carries this run's ID, and
  that the owner can claim its socket. Each round re-checks the worktree's identity. Subagents hold
  the author's environment, so this is workflow routing, not an identity boundary between them.
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
