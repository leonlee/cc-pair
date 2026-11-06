# Spec: serving subagent worktrees with a session reviewer pool

Status: draft for review. Design threads (`pair history <id>`): 1887a1 (parallel work), 33039d
(option 3: one owner serving subagent worktrees), 86f267 (global pool: rejected for a session pool).

## Goal

An auto author delegates separate PRs to subagents, each in its own git worktree. Each subagent
runs its own review loop with the session's reviewer while the others keep working, and up to N
reviews run at once. Without the opt-in, behavior is exactly 0.8.1.

Out of scope: a global pool or daemon, a cross-session concurrency cap, reviews that outlive the
author, creating, merging or deleting worktrees, nested owners, several threads per lane, recovering
subagent conversations, a persisted queue, detaching one worktree, manual mode.

## Terms

- **Owner**: the `pair start` launcher. **Root**: the worktree it was started in.
- **Target**: a worktree the owner serves: the root, or an enrolled child.
- **Child**: a worktree of the same repository, other than the root, enrolled by this owner.
- **Entry**: one queued or running review round, keyed by target and pending message file.

## CLI

- `pair start --serve-worktrees` enables child service for the session. `--reviewers N` (1–8,
  default 1) is the number of review rounds that may run at once across all targets; it requires
  `--serve-worktrees`, since the root alone never has more than one pending round. Both flags are
  repeated in the restart command that `pair stop` and `pair status` print.
- The pre-launch summary adds a line, for example `pair:   serves subagent worktrees · 2 reviewers`.
- No other new commands. `pair reviewer` gains child targets (see Corrections).

## Routing

- The owner sets `PAIR_AUTO_OWNER=<owner state dir>` in the author's environment; subagents inherit
  it. It is a locator, not a credential: the owner still requires this run's `PAIR_AUTO_RUN`.
- `managedReview` dials `autoSocketPath(PAIR_AUTO_OWNER)` when set, otherwise `stateDir(channel)`
  as today, and sends `{action: "review", run, file, root}`, where `root` is the caller's own
  canonical worktree root. The author ID (`author`) is sent only when `root` is the owner's root.
- The owner treats `root` and `file` as values to compare, never as paths to open or launch in
  before validation succeeds.
- A request without `root`, as an older CLI (0.8.1 and earlier) sends it, selects the owner's root
  only, with the existing run and exact-message checks. It never enrolls a child.
- Without `--serve-worktrees`, a request whose `root` isn't the owner's root fails with: "this auto
  session doesn't serve other worktrees; integrate the work into <root>, or start the session with
  --serve-worktrees". The request stays on disk.

## Enrollment

On the first request from a non-root `root`, the owner enrolls the target, then handles the request.
Enrollment validates, in order:

1. `root` is the realpath of an existing directory, and `git -C root rev-parse --show-toplevel`
   returns it.
2. Its `--git-common-dir` (absolute, realpath) equals the root's.
3. It appears in `git -C <owner root> worktree list --porcelain`.
4. Its channel, computed by the owner as `channelDir(root)` under the owner's PAIR_HOME, is recorded.
5. No manual Codex session is registered in that channel (`readRegistration`).
6. The owner claims the child's auto socket, `autoSocketPath(stateDir(child channel), true)`, by
   listening on it. `EADDRINUSE` fails with "another auto session or a reset owns <root>".
7. The child's lane has a pending request or response equal to `file`.

The owner records the target's identity: canonical root, `--absolute-git-dir`, the root
directory's `dev`/`ino`, and the channel. A failure releases only what this attempt acquired and
enrolls nothing. Two concurrent first contacts for one root share one enrollment attempt and then
the same entry. The owner tells the guardian each claimed socket path, and the guardian removes
them under the same conditions as the owner's own socket. Targets stay enrolled until the owner
exits; claims are released then, never removed as stale by a later run.

The claim socket answers `status` with the serving owner (root, run, pid) and this target's entry
and failure, and `reviewer` (see Corrections). It answers `stop` and `review` with an error naming
the owner's root: stopping from a child would stop the whole session, so `pair stop` is run in the
root. Because the child's socket is claimed, `pair start` and `pair reset` in that worktree are
refused while it is served.

## Validation at each step

The target's identity is its realpath, `dev`/`ino` and git dir, as recorded at enrollment.

- **Request and launch:** the identity matches, and `file` is the target's pending request or
  response. A request whose `file` isn't pending, and has no review after it, is rejected; the owner
  never substitutes another message.
- **While running:** every second (on the existing heartbeat tick), the owner re-checks the identity
  of each running child target. On a mismatch it tells the guardian to stop that job's process group
  (a new `stop` IPC message with the job ID, handled like the existing per-job stop), and fails that
  entry with "worktree <root> was removed or replaced". Other entries keep running.
- **Completion, and a retry after it:** the identity still matches, and the message `file` has a
  review after it in the target's lane. That review is the round's result.

A failed check fails only that entry, with the reason. A verdict written for a target that then
failed its identity check is never reported as success, and a replaced checkout never inherits the
old target's sessions or settings.

## Queue and pool

- One FIFO holds entries for every target, the root included. At most one entry exists per target:
  a request for the same target and file attaches to the existing entry (queued or running), and
  never launches a second reviewer.
- Up to N entries run at once. When a slot is free, the oldest queued entry is revalidated and
  launched. An entry that fails revalidation is settled with its error, and the next one is tried.
- A caller that disconnects or times out doesn't cancel its entry. A later request or `pair wait`
  retry for the same file attaches to it, or returns the verdict if it has finished (completion
  validation above).
- The reviewer timeout (`--timeout`) counts from launch, not from enqueue.
- A failed round frees its slot; its retry is a new request and joins the back of the queue.
- Stop (and guardian exit) rejects every queued and running entry with "auto mode stopped; review
  request remains on disk", stopping running reviewers through the guardian as today.
- The single `active` round, `failed` message and `workerPid`/`session`/`thread` status fields
  become per-entry and per-target state. Reviewer sessions, settings snapshots and failures are keyed
  by target and thread. A settings snapshot is taken at an entry's first launch, as today.

## Reviewer launch

For an entry, the owner launches the reviewer with `cwd` = the target's root, Codex
`--add-dir <target channel>`, `PAIR_AUTO_MESSAGE = file`, and the same model and effort rules,
reviewer arguments and Claude tool allowlist as today. The reviewer's environment is built fresh
and has no `PAIR_AUTO_OWNER`, so its `wait`, `send review` and `history` act on the target's
channel.

Child worktrees may lack pair's instruction files, and nothing writes them. So every managed
prompt, root rounds included, contains the reviewer rules rendered from `prompts/pair.md` (the
"Review for …" section, including brainstorm and severity rules) for the reviewing agent, ahead of
the existing one-round instructions. Repository instructions that exist still apply.

## No writes into child worktrees

Nothing pair runs writes files into a child worktree: no `pair init`, and no instruction refresh. A
command run by a child author (`PAIR_AUTO_ROLE=author` with `PAIR_AUTO_OWNER` set to a different
state dir than its own channel's) skips `refreshInstructions`, so a tracked `AGENTS.md` with a pair
section, stale or not, is left unchanged. The root keeps today's refresh.

## Author instructions

- With `--serve-worktrees`, the author prompt adds: subagents in their own git worktrees may run
  their own review loop; give each one the child-loop rules below in its task. Subagents in this
  checkout still return their work without running pair.
- Child-loop rules, given in the delegated task: from your worktree, send requests and responses
  with `"$PAIR_BIN" send request|response --as <agent> -`, each run as a background command; each
  returns the review inline, possibly after waiting its turn. Keep the worktree unchanged while a
  review is queued or running, fix between rounds, and finish the loop. Don't remove the worktree.
  Report the outcome to the parent: approved, escalated, or the failure as printed.
- `prompts/pair.md` Delegating work says that when the session serves subagent worktrees, its
  author prompt says so and gives the rules to pass on; otherwise the 0.8.1 rules apply. Approval in
  a child doesn't approve a later integration, and doesn't authorize removing the worktree.

## Corrections

`pair reviewer --thread current|ID` changes one failed thread's settings, as today, per target:

- In the root, `current` is the root's failed thread. An `ID` (or unique part) may name any target's
  failed thread; an ambiguous or unknown one is refused.
- In a child worktree, the claim socket handles it: `current` is that child's failed thread.
- Refused while that target's entry is queued or running; other targets' rounds don't block it.
- Without `--thread`, `pair reviewer` in a child worktree is refused, naming the root, where it
  changes the defaults for new threads.

## Status

`pair status` in the root adds, when serving:

```
  serves subagent worktrees · reviewers 2 · running 1 · queued 1
  running: /path/repo-a (thread 2026-…-1a2b3c, pid 4242, round 2)
  queued:  /path/repo-b (thread 2026-…-4d5e6f)
  failed:  /path/repo-c thread 2026-…-7a8b9c: <error>
```

`pair status` in a child prints its own lanes and: `auto mode: served by the session in <root>
(owner <pid>)`, plus its own entry and failure. `pair ps` is unchanged.

## Compatibility

- No message or channel format change. `auto.json` gains diagnostic fields only. An older CLI
  shows less in status. Its review requests carry no `root` and are served as the root's (Routing).
- An older owner sets no `PAIR_AUTO_OWNER`, so a new CLI behaves as today against it.
- Claimed child sockets make older `pair start` and `pair reset` refuse those worktrees too.

## Tests

- Opt-in off: a child request is refused with the message above; the root works as today.
- Old client: a request without `root` against a new owner, with and without `--serve-worktrees`,
  is served as the root's and never enrolls a child.
- Completion: a successful round is accepted (its message is no longer pending, and a review
  follows it); a retry after the verdict returns it without launching.
- Enrollment: validation failures (not a worktree, another repository, a registered manual
  session, a claimed socket); two simultaneous first contacts make one enrollment and one entry.
- Queue: FIFO across root and children with N=1 and N=2; dedupe while queued and while running;
  disconnect, then retry before and after the verdict; timeout counted from launch.
- Failure isolation: child A fails while B succeeds; `pair reviewer --thread` in A's worktree
  corrects it; A's retry joins the back of the queue.
- Identity: a target removed or replaced while queued fails only itself; while running, its
  reviewer's process group is stopped within a few seconds, the entry fails with the reason, and a
  sibling's running review completes normally.
- Stop and guardian exit with running and queued entries; claimed sockets released, and removed by
  the guardian when the owner dies.
- Launch: cwd, `--add-dir`, environment (no `PAIR_AUTO_OWNER`), settings and rendered reviewer
  rules for both reviewer types; the root's resume record never changes from a child request.
- No writes: a fresh child and a child with a stale tracked `AGENTS.md` are byte-identical after
  a loop.
- Refusals in a child worktree: `pair start`, `pair reset`, `pair stop`, bare `pair reviewer`.
- Live check (manual, recorded in the PR): a real Claude subagent with `isolation: "worktree"`
  runs a loop through the root's owner, with the background send, the rules from its task, and its
  worktree kept.
