# Spec: named participants, roles independent of vendor

Status: draft for review. Design thread: `pair history b14c32` (same-vendor pairs). The user chose
the full model over the auto-only v1 that thread recommended: identities independent of the CLI,
same-vendor pairs in manual and auto mode, and arbitrary named participants.

## Goal

Any two participants can pair, whatever CLI runs them: Claude reviewing Claude, Codex reviewing
Codex, or the cross-vendor pairs of today, in manual and auto mode. A participant is a name; the
CLI that runs it (its backend) is a property of the session, not of the name. Existing channels,
commands and instructions keep working unchanged.

Out of scope: more than two participants in one thread, group reviews, a participant registry,
renaming or migrating existing lanes and archives.

## Model

- **Participant.** A name matching `^[a-z][a-z0-9_]{0,31}$`: lowercase letters, digits and
  underscores, no dashes, so lane names parse unambiguously. `claude` and `codex` are participants
  like any other; they are the defaults.
- **Backend.** `claude` (Claude Code) or `codex` (Codex CLI): the CLI a session runs. Pair needs it
  only to launch a managed agent, choose its arguments, permissions and output parsing, and to wake
  a Codex session. It is never stored in a message or a lane.
- **Roles.** Author and reviewer, per thread, as today: a participant authors in its own lanes and
  reviews in others'. Any two distinct participants can pair; a participant never reviews itself.
- **Lane.** `<author>-to-<reviewer>/` in the channel, for any two distinct names. Today's
  `claude-to-codex/` and `codex-to-claude/` are two such lanes. Message `from` fields keep their
  rule: the lane's author for requests and responses, its reviewer for reviews.

## Who is who: identity and partner

Every command that acts as a participant resolves:

- **Self**: `--as NAME`, else `PAIR_AGENT`. Required, as today.
- **Partner**: `--to NAME`, else `PAIR_PARTNER`, else the default partner, which exists only for the
  two defaults: `claude` pairs with `codex` and `codex` with `claude`. Any other name without a
  partner fails: "pass --to NAME or set PAIR_PARTNER".

Self and partner must differ. `send request`/`send response` write to `<self>-to-<partner>`;
`send review` answers in `<partner>-to-<self>`.

**Replies go to the lane the message came from.** A participant can have several lanes open, and
the message `wait` delivered may come from someone other than its configured partner. So:

- The `== next:` line `wait` prints always names the counterpart of the delivered lane:
  `pair send review --as bob --to carol --verdict …`, `pair send response --as alice --to bob -`.
- The instructions tell agents to send replies exactly as the `== next:` line says, and to pass
  `--to` on every `send`. `PAIR_PARTNER` and the default partner only choose whom a new request
  goes to; they are never used to guess which lane a reply belongs to.
- `send review` and `send response` without `--to` fall back to the default partner for the two
  default names only, as today, so existing instructions keep working.

**Manual `wait`.** `wait --as NAME` doesn't need a partner: it looks for NAME's duties in every
lane. Author duties come first (reviews waiting in `NAME-to-*`), then reviewer duties (requests
and responses waiting in `*-to-NAME`). Within each, the oldest pending message comes first.

**Managed sessions stay on their own lane.** In auto mode, nothing reads other lanes:

- The author's `send request`, `send response`, its retry `wait`, and the inline result they print
  read only the session's lane, `<author>-to-<reviewer>`.
- A managed reviewer's `wait` and `send review` act only on its assigned message
  (`PAIR_AUTO_MESSAGE`) in `<author>-to-<reviewer>`, as today.
- Unrelated pending or unread closed threads in other lanes are left for manual use. They are never
  delivered to a managed author or reviewer. `status`, `history`, `reset`
and `clean` enumerate the lanes present in the channel instead of the two fixed ones.
`reset --as NAME` resets the lanes NAME authored; without `--as`, all lanes.

One open thread per lane stays the rule, so a participant may have one open thread with each
partner.

## Manual mode

Each session learns its name and partner in one of two ways:

1. **Environment, at launch** (recommended for same-vendor pairs):
   ```sh
   PAIR_AGENT=alice PAIR_PARTNER=bob claude     # terminal A
   PAIR_AGENT=bob PAIR_PARTNER=alice claude     # terminal B
   ```
2. **From the user, in words**: "you are bob; your partner is alice". The agent then passes `--as`
   and `--to` on every command.

With neither, a Claude session is `claude` and a Codex session is `codex`, partnered as today.

**Codex wake-ups.** `pair register --as NAME` records the Codex session for that participant. The
default participant `codex` keeps the existing `codex.session` file. Any other name uses
`sessions/NAME.json`, with the same content and validation. `pair_listen` finds which participant
its Codex session registered as, checks NAME's pending duties, and queues a fixed note naming that
participant: "pair: a message is waiting for you. Run `pair wait --as NAME --timeout 5`, …". The
name is validated, so the note still carries no channel content. `unregister --as NAME` removes it.
`status` lists each registration with its participant.

## Auto mode

> **Revised before 0.10.0 shipped** (brainstorm thread `2026-11-09T23-52-41-797Z-06665a`): the
> CLIs became words, `pair start [AUTHOR_CLI [REVIEWER_CLI]] [--as NAME] [--reviewer NAME]`, and
> `--cli` and `--reviewer-cli` were dropped. A name defaults to its CLI's (`<cli>_reviewer` for a
> reviewer that would get the author's) and never chooses a CLI, except `--as claude|codex` in the
> form without CLIs. README §4 and DESIGN.md describe the current rules; the text below is the
> original spec.

```sh
pair start --as alice --cli claude --reviewer bob --reviewer-cli claude
pair start --as claude                     # as today: reviewer codex, CLI codex
pair start --as codex --reviewer-cli codex # reviewer name defaults to codex_reviewer
```

- `--as NAME` is the author participant. `--cli` is its backend, defaulting to NAME when NAME is
  `claude` or `codex`, and required otherwise.
- `--reviewer NAME` is the reviewer participant. It defaults to the default partner of the author
  for `claude`/`codex` authors whose `--reviewer-cli` differs or is omitted. If the author and
  reviewer backends are the same, it defaults to `<backend>_reviewer`. Otherwise it is required.
- `--reviewer-cli` is the reviewer's backend: by default the other backend when the reviewer is a
  default name, otherwise required.
- The pair (author, reviewer) and both backends are fixed for the session, shown in the summary and
  `pair status`, written into the restart command, and passed to served worktrees. The author and
  its subagents get `PAIR_AGENT` and `PAIR_PARTNER`. The reviewer gets its own name as `PAIR_AGENT`
  with the author as `PAIR_PARTNER`.
- Launch arguments, the Claude tool allowlist, session-ID and error parsing, and
  `--reviewer-model`/`--reviewer-effort` validation follow the reviewer's backend. A same-backend
  reviewer gets a fresh conversation per thread, kept across that thread's rounds, never the
  author's.
- Only the executables of the two chosen backends are resolved; a one-CLI install works.
- `pair reviewer` (model and effort) works as today. The reviewer's name and backend can't change
  while the session runs.

## Instructions

The templates stay per CLI (the Claude skill and the Codex `AGENTS.md` section). The vendor
guard moves from the name to the CLI ("These instructions are for Codex sessions only…"), and the
identity becomes a rule instead of a fixed word:

> Your pair name is `$PAIR_AGENT` if set, else the name the user gave you, else `codex`. Your
> partner for new requests is `$PAIR_PARTNER` if set, else the name the user gave you, else
> `claude`. Pass `--as <your name>` on every command and `--to` on every `send`. A new request
> goes `--to` your partner. A review or response goes `--to` the participant whose message you
> received: copy the `== next:` line.

Headings and examples say "your partner" instead of naming a vendor. The managed reviewer prompt
already carries the rendered reviewer rules. It now names the reviewer's participant and its
partner explicitly.

## Compatibility

- **On disk.** Existing lanes, messages, archives, `codex.session` and the state directory are
  valid as they are; nothing is rewritten. New names only add lanes and files.
- **Older CLIs.** An older pair rejects any name but `claude` and `codex` (`--as must be one of
  claude, codex`) and has no `--to`. So a conversation between new participants can only be carried
  on by the new CLI, on both sides. An older CLI's `status`/`history`/`reset` simply doesn't see
  other lanes. That is documented, not refused. An older `pair mcp` only wakes the participant
  `codex`; Codex must restart with the new MCP server for other names.
- **Archives.** `<id>-<author>-to-<reviewer>-<outcome>` with the new name rule; the old regex
  ignores new names.

## Tests

- **Routing:** `send`/`wait`/`history`/`status`/`reset`/`clean` with names other than the defaults;
  a same-vendor pair (alice, bob) through request, changes, response, approve; a brainstorm; `wait`
  priorities across several lanes; one open thread per lane with two partners.
- **Identity resolution:** `--as`/`PAIR_AGENT`, `--to`/`PAIR_PARTNER`, the default partners, a
  missing partner, self as partner, invalid names.
- **Reply addressing:**
  - identity given only in words (no environment variables): every command passes `--as` and `--to`;
  - bob, with `PAIR_PARTNER=alice`, receives carol's request and answers it in `carol-to-bob`, following the `== next:` line;
  - an author with two open outgoing lanes responds to the right one;
  - every `== next:` line names the delivered lane's counterpart.
- **Manual Codex wake-ups:** two registrations in one channel, each woken with its own name; the
  default `codex.session` unchanged.
- **Auto mode:**
  - all four backend combinations, with named and default participants;
  - auto mode started while unrelated lanes hold pending threads and an unread closed one, including an approval older than the session's current `changes` verdict: the author's inline result is its own lane's verdict, and the reviewer sees only its assigned message;
  - a one-CLI install;
  - a fresh reviewer conversation per thread;
  - restart command and served worktrees carrying the pair;
  - reviewer guards (role, message, identity).
- **Compatibility:** an existing claude/codex channel works unchanged; legacy archives listed; the
  default `codex.session` registration works.
