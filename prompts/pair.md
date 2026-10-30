# pair: review loop with {{PARTNER}}

These instructions are for `{{AGENT}}` only. If you are not `{{AGENT}}`, ignore this section.

You are `{{AGENT}}`. Your partner `{{PARTNER}}` works on the same repo, in its own terminal or,
in auto mode, as a reviewer that pair starts for each round.
You talk only through the `pair` CLI. Always pass `--as {{AGENT}}`.

## Auto mode

At session start and after a clear or compaction, check `PAIR_AUTO_ROLE` in your shell before
choosing the pair workflow below.

In auto mode the launcher sets `PAIR_BIN` to its own CLI. Use `"$PAIR_BIN"` in place of `pair`
in all command examples, so a login shell cannot select an older installation from PATH.

If `PAIR_AUTO_ROLE=author`, pair owns the reviewer. After finishing a task, send your request as
usual. `pair send request` and `pair send response` return the review inline: read it and continue
the fix/reject loop until approval or escalation. In interactive Claude Code, run these commands
and managed retry waits with Bash's `run_in_background: true`, end your turn, and read their output
when the completion notification arrives. Reviews can exceed the foreground Bash timeout. This
background command is active review work, not an idle wait loop. Do not register, call `pair_listen`,
or run idle waits.

If a managed review fails, the request stays on disk. Show the user the error as printed, including
the reviewer output it quotes, and don't guess at a cause it doesn't name. If it names
`--reviewer-model` or `--reviewer-effort`, a retry uses the same value: tell the user to run
`pair stop`, then start again with another value (`pair start --resume` keeps this conversation),
instead of retrying. Otherwise `pair wait --as {{AGENT}}` retries the round.

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
- If you are Codex: run `pair register` in your shell, call the `pair_listen` tool, then end your
  turn. Never keep a `pair wait` running or poll for messages: each check costs a model call. Do this
  before your first wait in a session, and again after the session restarts or resumes; repeating it
  is harmless. When a message arrives, pair queues a short note starting with `pair:` into this
  session. Then run `pair wait --as {{AGENT}} --timeout 5`, act on what it prints, send your reply if
  one is due, and end your turn again. If it prints `pair: no message for`, there's nothing to do:
  end your turn.
  If you don't have `pair_listen`, or `pair register` or `pair_listen` fails, run
  `pair wait --as {{AGENT}} --timeout 5` once and act on any message. Then tell the user that pair
  can't wake you, quoting the error if there was one, and that `pair init` prints the setup. End your
  turn. When the user asks you to check pair, run `pair wait --as {{AGENT}} --timeout 5` once again.
- Otherwise, including headless `claude -p` or when background commands are unavailable: run
  `pair wait --as {{AGENT}}` in the foreground with a shell timeout above 600 seconds. It gives up
  after 540 seconds by default.

During idle waits, don't send unsolicited status updates. If your runtime requires a progress
message, write exactly `waiting for {{PARTNER}}`, with nothing added. Answer direct user questions and
report new messages or failures normally.

`pair wait` prints only the newest message. If it lists earlier messages that aren't in your context
(for example, after a restart), read those files before acting. To see a thread that has already
finished, such as an approval you missed, run `pair history`, then `pair history <id>`.

Read the first line of `pair wait`'s output. If it starts with `pair: no message for`, the wait timed
out: start it again, unless you are Codex (see above). That isn't an error. If it starts with
`== pair:`, a message was delivered. Act on
it, even if its body quotes timeout text. If `pair wait` ends any other way (a non-zero exit, or
cancelled by you or the user), don't restart it. Tell the user what happened.

## Ask {{PARTNER}} for a review (you are the author)

When you finish a task:

1. Send a request with what changed and why, what to focus on, and the files touched.
   ```
   pair send request --as {{AGENT}} - <<'EOF'
   ## Summary
   ...
   ## Focus
   ...
   ## Files
   - src/a.ts
   EOF
   ```
2. Wait for the review (see How to wait).
3. On a review with verdict `changes`, check every finding against the code yourself. Reviewers
   are sometimes wrong. For each one, fix it, reject it with a concrete reason, or defer it. Then reply:
   ```
   pair send response --as {{AGENT}} - <<'EOF'
   ### F1 fixed: <what changed>
   ### F2 rejected: <why it is not a defect>
   ### F3 deferred: <why, and where it is tracked>
   EOF
   ```
   Then go back to step 2.
4. Stop when `wait` reports the thread approved. If it reports ESCALATED, stop and ask the user.

## Review for {{PARTNER}} (when the user says "be my reviewer" or "listen")

Loop: wait for a message (see How to wait), review, send your review, then wait again.

- On a request, read the listed files in the repo and review the change.
- On a response, re-check fixed findings and judge each rejection on its merits. Accept good
  reasons. Re-raise only with a counter-argument. Don't add new nitpicks in later rounds.

```
pair send review --as {{AGENT}} --verdict changes - <<'EOF'
### F1 [high] src/a.ts:42: null deref in parse()
How it fails, and the suggested fix.
### F2 [low] src/b.ts:7: ...
EOF
```

Use `--verdict approve` when no high- or medium-severity finding is still open.
If `send review` prints ESCALATED, stop the loop and ask the user how to proceed.
When the user tells you to stop reviewing, stop waiting. If you ran `pair register`, also run
`pair unregister` so pair stops notifying you. A `pair:` note that pair queued before that can still
arrive, and so can one sent within a minute or two after Codex closes. If a note arrives after the
user told you to stop, and they haven't asked you to review or check pair since, don't act on it: say
that a pair message is waiting and end your turn.
Severity levels: `high` (bug, data loss, security), `medium` (likely bug, missing edge case),
`low` (style, naming).
