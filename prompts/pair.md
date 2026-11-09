# pair: review loop with your partner

These instructions are for {{CLI}} sessions only. If you are not {{CLI}}, ignore this section.

You pair with a partner, another agent working on the same repo, and talk to it only through the
`pair` CLI. In auto mode, pair starts the reviewer for each round.

Your pair name is `$PAIR_AGENT` if it is set in your shell, else the name the user gave you, else
`{{AGENT}}`. Your partner for new requests is `$PAIR_PARTNER` if set, else the name the user gave
you, else `{{PARTNER}}`. Pass `--as <your name>` on every command and `--to` on every `send`: a new
request goes `--to` your partner, and a review or response goes `--to` the participant whose message
you received, exactly as the `== next:` line of `pair wait` says. The examples below use the default
names, `{{AGENT}}` and `{{PARTNER}}`.

## Delegating work

If you delegate implementation to subagents, you still own the pair loop: requests, responses,
retries and verdicts. In each delegated task, tell the subagent not to run pair commands and to
return its changes and validation results to you. Say so even when it works in a separate worktree,
where pair's instructions may be missing. Integrate the changes into this session's worktree, then
request review of the combined change. Before each request or response, make sure no task is still
writing to this checkout, and keep it stable while the reviewer runs; work in other worktrees may
continue. You may delegate fixes between review rounds, then integrate them before you respond.

If the delegated work belongs in separate PRs, review each one on its own: check out its branch in
this worktree, finish its review loop, then move to the next. Git refuses a branch still checked
out in another worktree; once its work is committed and no task is using it, remove that worktree
with `git worktree remove`, never by force. Or ask the user to run one `pair start --worktree`
session per PR.

When an auto session serves subagent worktrees (`pair start --serve-worktrees`), its author prompt
says so and gives the rules to pass to each subagent working in its own worktree: that subagent runs
its own review loop there. Approval there doesn't approve a later integration, and doesn't authorize
removing the worktree. Subagents in this checkout still follow the rule below.

If you are a subagent implementing part of another author's task, return your changes and
validation results to that author. Don't run pair commands or start a reviewer, even if you inherit
`PAIR_AUTO_ROLE=author` or other pair variables. This doesn't change the rules for a managed
reviewer handling a pending round.

## Auto mode

At session start and after a clear or compaction, check `PAIR_AUTO_ROLE` in your shell before
choosing the pair workflow below.

In auto mode the launcher sets `PAIR_BIN` to its own CLI. Use `"$PAIR_BIN"` in place of `pair`
in all command examples, so a login shell cannot select an older installation from PATH.

If `PAIR_AUTO_ROLE=author`, pair owns the reviewer. If you own the pair loop, send your request
after finishing the task and integrating any delegated work. `pair send request` and
`pair send response` return the review inline: read it and continue the fix/reject loop until
approval or escalation, or in a brainstorm until it completes. In interactive Claude Code, run
these commands and managed retry waits with Bash's `run_in_background: true`, end your turn, and
read their output when the completion notification arrives. Reviews can exceed the foreground Bash
timeout. This background command is active review work, not an idle wait loop. Do not register,
call `pair_listen`, or run idle waits.

If a managed review fails, the request stays on disk. Show the user the error as printed, and don't
guess at a cause it doesn't name. Retry once with `pair wait --as {{AGENT}}`. If the same failure
comes back, stop and ask the user, naming any reviewer model or effort the error says a retry keeps.

If `PAIR_AUTO_ROLE=reviewer`, handle exactly one pending review round. Read it with
`pair wait --as {{AGENT}} --timeout 1`, review, send your verdict, and exit. Do not modify source,
register, call `pair_listen`, request your own review, or wait again after sending the verdict.
These auto-mode rules replace the waiting instructions below.

## How to wait

`pair wait` returns as soon as a message for you arrives. Wait in whichever way costs the fewest
model turns:

- If you are Claude Code in an interactive session: run `pair wait --as {{AGENT}} --timeout 3600` as
  a background command (`run_in_background: true`) and end your turn. You'll be resumed when it exits.
  Then read its output.
- If you are Codex: run `pair register --as <your name>` in your shell, call the `pair_listen` tool,
  then end your turn. Never keep a `pair wait` running or poll for messages: each check costs a model
  call. Do this before your first wait in a session, and again after the session restarts or
  resumes; repeating it is harmless. When a message arrives, pair queues a short note starting with
  `pair:` into this session. Then run `pair wait --as {{AGENT}} --timeout 5`, act on what it prints,
  send your reply if one is due, and end your turn again. If it prints `pair: no message for`,
  there's nothing to do: end your turn.
  If you don't have `pair_listen`, or `pair register` or `pair_listen` fails, run
  `pair wait --as {{AGENT}} --timeout 5` once and act on any message. Then tell the user that pair
  can't wake you, quoting the error if there was one, and that `pair init` prints the setup. End your
  turn. When the user asks you to check pair, run `pair wait --as {{AGENT}} --timeout 5` once again.
- Otherwise, including headless `claude -p` or when background commands are unavailable: run
  `pair wait --as {{AGENT}}` in the foreground with a shell timeout above 600 seconds. It gives up
  after 540 seconds by default.

During idle waits, don't send unsolicited status updates. If your runtime requires a progress
message, write exactly `waiting for <your partner's name>`, with nothing added. Answer direct user
questions and report new messages or failures normally.

`pair wait` prints only the newest message. If it lists earlier messages that aren't in your context
(for example, after a restart), read those files before acting. To see a thread that has already
finished, such as an approval you missed, run `pair history`, then `pair history <id>`.

Read the first line of `pair wait`'s output. If it starts with `pair: no message for`, the wait timed
out: start it again, unless you are Codex (see above). That isn't an error. If it starts with
`== pair:`, a message was delivered. Act on
it, even if its body quotes timeout text. If `pair wait` ends any other way (a non-zero exit, or
cancelled by you or the user), don't restart it. Tell the user what happened.

## Ask your partner for a review (you are the author)

When you own the pair loop and finish a task, including integrating any delegated work:

1. Send a request with what changed and why, what to focus on, and the files touched.
   ```
   pair send request --as {{AGENT}} --to {{PARTNER}} - <<'EOF'
   ## Summary
   ...
   ## Focus
   ...
   ## Files
   - src/a.ts
   EOF
   ```
   A spec, plan or design doc goes the same way, in any format: a Markdown plan, an OpenSpec change,
   an ADR. Under Files, list its paths and the commit they're at, or say they're uncommitted. If the
   format has its own validator, such as `openspec validate`, run it first and include the result.
   When the task implements a spec that was reviewed, add a `## Spec` section with that review's
   thread ID (from `pair history`), the spec's paths and the commit it was approved at. If the spec
   changed since, say what changed.
2. Wait for the review (see How to wait).
3. On a review with verdict `changes`, check every finding against the code yourself. Reviewers
   are sometimes wrong. For each one, fix it, reject it with a concrete reason, or defer it. Then reply:
   ```
   pair send response --as {{AGENT}} --to {{PARTNER}} - <<'EOF'
   ### F1 fixed: <what changed>
   ### F2 rejected: <why it is not a defect>
   ### F3 deferred: <why, and where it is tracked>
   EOF
   ```
   Then go back to step 2.
4. Stop when `wait` reports the thread approved. If it reports ESCALATED, stop and ask the user.

## Brainstorm with your partner (you are the author)

Before a design decision, you can brainstorm with your partner instead of asking for a review. Send
the problem, the constraints and what's already decided:
```
pair send request --brainstorm --as {{AGENT}} --to {{PARTNER}} - <<'EOF'
## Problem
...
## Constraints
...
EOF
```
For independent ideas, leave your own proposal out of this first message and share it in your first
response. Each reply has verdict `continue` or `complete`. On `continue`, answer your partner's
questions, push back, or add your proposal with `pair send response`, then wait as for a review. If
you have what you need, say so, and your partner completes it. The thread closes when your partner
completes it, at the latest after `PAIR_MAX_ROUNDS` turns (default 3), with the options, a
recommendation and open decisions. Take decisions that are the user's to the user. A later spec
request can cite the thread ID.

## Review for your partner (when the user says "be my reviewer" or "listen")

Loop: wait for a message (see How to wait), review, send your review, then wait again.

- On a request, read the listed files in the repo and review the change.
- On a request to review a spec or plan, review the document, not code. Look for requirements that
  are ambiguous or contradict each other, missing edge cases and error handling, acceptance criteria
  that can't be tested, scope beyond or short of the stated goal, and plans the current code can't
  support. Approval means this version has no blocking findings; it doesn't approve an
  implementation.
- On a request with a `## Spec` section, read that thread with `pair history <id>` and the spec, and
  report where the change departs from it. If you can't find the thread or the spec, say so; don't
  assume the change conforms.
- On a brainstorm (its header says `brainstorm`), don't review code. Propose options with their
  trade-offs, challenge the author's assumptions, and ask what you need to know. In the first round,
  if the author hasn't proposed anything, give your own options before judging theirs. Send
  `--verdict continue` while questions are open, and `--verdict complete` once the options are
  clear or when the `== next:` line says it's the last round. A complete reply lists the options
  considered, your recommendation and the open decisions. A brainstorm has no findings and never
  escalates.
- On a response, re-check fixed findings and judge each rejection on its merits. Accept good
  reasons. Re-raise only with a counter-argument. Don't add new nitpicks in later rounds.

```
pair send review --as {{AGENT}} --to {{PARTNER}} --verdict changes - <<'EOF'
### F1 [high] src/a.ts:42: null deref in parse()
How it fails, and the suggested fix.
### F2 [low] src/b.ts:7: ...
EOF
```

Use `--verdict approve` when no high- or medium-severity finding is still open.
If `send review` prints ESCALATED, stop the loop and ask the user how to proceed.
When the user tells you to stop reviewing, stop waiting. If you ran `pair register`, also run
`pair unregister --as <your name>` so pair stops notifying you. A `pair:` note that pair queued before that can still
arrive, and so can one sent within a minute or two after Codex closes. If a note arrives after the
user told you to stop, and they haven't asked you to review or check pair since, don't act on it: say
that a pair message is waiting and end your turn.
Severity levels: `high` (bug, data loss, security), `medium` (likely bug, missing edge case),
`low` (style, naming). Rate a spec finding by the defect it would cause in the implementation.
