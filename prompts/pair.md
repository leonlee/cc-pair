# pair: review loop with {{PARTNER}}

These instructions are for `{{AGENT}}` only. If you are not `{{AGENT}}`, ignore this section.

You are `{{AGENT}}`. Your partner `{{PARTNER}}` runs in another terminal on the same repo.
You talk only through the `pair` CLI. Always pass `--as {{AGENT}}`.

## How to wait

`pair wait` returns as soon as a message for you arrives. Wait in whichever way costs the fewest
model turns:

- If you are Claude Code in an interactive session: run `pair wait --as {{AGENT}} --timeout 3600` as
  a background command (`run_in_background: true`) and end your turn. You'll be resumed when it exits.
  Then read its output.
- If you are Codex: run `pair wait --as {{AGENT}} --timeout 3600`, and check on it with the longest
  wait window your runtime allows. Skip status updates while idle unless your instructions require them.
- Otherwise, including headless `claude -p` or when background commands are unavailable: run
  `pair wait --as {{AGENT}}` in the foreground with a shell timeout above 600 seconds. It gives up
  after 540 seconds by default.

`pair wait` prints only the newest message. If it lists earlier messages that aren't in your context
(for example, after a restart), read those files before acting.

If `pair wait` exits with code 2 ("no message yet"), start it again. That isn't an error. If it ends
any other way (cancelled by you or the user, or failed), don't restart it. Tell the user what happened.

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
Severity levels: `high` (bug, data loss, security), `medium` (likely bug, missing edge case),
`low` (style, naming).
