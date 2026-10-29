# Changelog

## Unreleased

`pair help <command>` and `pair <command> --help` explain each command and its options, and
`pair --help` also lists the environment variables.

`pair start --as claude|codex -- ARGS...` passes the arguments after `--` to the interactive
author, for example `-- --model opus`, and `--reviewer-args="ARGS"` passes options to every
reviewer round. Each accepts a listed set of options with at most one value each. The author's
list excludes print, background, subcommand and directory-switching options; the reviewer's
excludes anything that changes its tools, permissions or sandbox.

`pair start --worktree NAME` runs the auto session in the git worktree `../<repo>-NAME` on branch
`NAME`, creating both on first use and running `pair init` there, and reuses it later.

## 0.5.2 (2026-10-27)

Auto mode hardening. In a managed reviewer, pair refuses every command except `wait`, `send`,
`status` and `history`, and the Claude reviewer's tool allowlist permits only `wait` and
`send review`. This guards against mistakes and casual prompt injection in review material; it is
not a security boundary, since the Codex reviewer's sandbox can still write the channel and
worktree. A managed reviewer no longer refreshes instruction files in the worktree. A corrupt or unreadable verdict, or an
unwritable state directory, now fails only that review round instead of crashing the launcher
and its author. An existing Codex registration blocks `pair start --as codex` as well as
`--as claude`, and a managed `send` reports a review that another `pair wait` took. `pair init`
reports an invalid `PAIR_AUTO_SOCKET_DIR` instead of crashing after writing its files.
A reviewer's session is recorded for the review it started, even if its lane can't be read or its
verdict lands first, and a failed kill during emergency cleanup is reported on stderr and in
`auto.log` instead of crashing the launcher.

## 0.5.1 (2026-10-26)

Version 0.5.0 was briefly published and then unpublished. This release uses a new version number
because npm does not allow a published version to be reused.

Opt-in auto mode: `pair start --as claude|codex` opens an interactive author and manages its
reviewer automatically. Reviewers run one bounded round, resume their saved session for follow-ups,
and return verdicts inline to the author's `send`. `pair stop`, `status`, and `ps` expose lifecycle
control and diagnostics. A guardian cleans up owned process groups on exit, timeout, interruption,
or launcher failure; cleanup never kills processes from persisted PIDs. Auto mode currently
supports macOS and Linux.

`pair start` accepts `--reviewer-model` and `--reviewer-effort` to override the automatic reviewer's
settings on fresh and resumed rounds. Status and process listings show the requested overrides;
omitted values continue to inherit the CLI defaults. Author settings and CLI config files are
left alone.

`pair reset` clears stale pending requests in this worktree by moving the selected lanes into a
timestamped backup, preserving source files and finished history. `--as claude|codex` selects the
request author; `--dry-run` previews the reset. Reset refuses an active auto session and handles
malformed or legacy requests without parsing them.

## 0.4.1 (2026-10-22)

`pair upgrade` asks npm for the latest version first. When you're already on it, it installs
nothing and prints `already up to date`. After an install it shows only the files the new
`pair init` wrote or kept, not the sandbox and `codex mcp add` setup, and names the version it
upgraded to.

## 0.4.0 (2026-10-22)

`pair upgrade` installs the latest version from npm, then runs the new `pair init` in the current
worktree. `pair send`, `wait`, `history`, `clean`, `register` and `unregister` refresh stale
instructions on their own and say so on stderr. `pair status` stays read-only. Instructions now
carry the pair version that wrote them, so an older pair never rolls back a newer one's, and status
reports those as `newer`. `pair status` and `pair init` print a line when npm has a newer version.
They check at most once a day, and `PAIR_NO_UPDATE_CHECK` turns the check off.

From 0.3.x, upgrade this once with `npm install -g claude-codex-pair`. After that, use `pair upgrade`;
worktrees refresh their instructions on the next `pair send` or `wait`.

## 0.3.1 (2026-10-21)

`pair ps` groups processes by worktree: each block shows the worktree's registered Codex session (when found) and
when pair last woke it, then one line per process with its age and a short host name (`Codex CLI 0.163.0`,
`ChatGPT app`, `Claude Code (worktree leak)`). A session whose worktree was deleted shows as `(deleted)`, and
one whose parent exited as `⚠ parent gone`. `pair ps -v` adds each host's full command. `lsof` warnings no
longer leak into the output. The README no longer lists the ChatGPT desktop app as untested: waking Codex there works.

## 0.3.0 (2026-10-20)

`pair ps` lists every running `pair mcp` and `pair wait` on the machine, with its directory and the
process that started it (the Codex daemon, the ChatGPT app, or a Claude Code session). It needs `ps`,
which agent sandboxes often block, so run it in your own terminal.

## 0.2.0 (2026-10-14)

Codex now uses `pair mcp` to wake an idle session when a review message arrives. It no longer keeps
a long `pair wait` running. Claude Code's background wait remains available.
The release adds `pair register`, `pair unregister`, `pair mcp`, and `pair uninit` (which undoes
`pair init` in a worktree, including files written by 0.1.x, and keeps history); `pair status` shows Codex
notification state, and `pair init` prints the `codex mcp add` command.

If you are upgrading from 0.1.x, run `npm install -g claude-codex-pair`, run `pair init` in each
worktree, run the printed `codex mcp add` command once, and restart Codex with an approval policy
that permits MCP tools. With the `never` policy, `pair_listen` fails; `-a on-request` worked in the
live test. Without the MCP server, Codex checks once and then only checks again when asked to
"check pair".

The timeout line from `pair wait` no longer tells every agent to run it again. Each agent's generated
instructions now decide whether to wait again.

A relative `PAIR_HOME` now resolves against the worktree root instead of the current directory, so
every subdirectory of a worktree uses one channel. An empty `PAIR_HOME` now means the default.
