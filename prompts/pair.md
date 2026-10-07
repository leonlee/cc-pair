# pair: review loop with {{PARTNER}}

You are `{{AGENT}}`. Your partner `{{PARTNER}}` runs in another terminal on the same repo.
You talk only through the `pair` CLI. Always pass `--as {{AGENT}}`.

`pair wait` blocks for up to 9 minutes. Run it with a shell timeout of at least 600000 ms
(Claude Code Bash `timeout: 600000`, Codex `timeout_ms: 600000`). If it exits with code 2
("no message yet"), run it again. Don't treat that as an error.

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
2. `pair wait --as {{AGENT}}`
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

Loop: `pair wait --as {{AGENT}}`, review, send your review, then wait again.

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
