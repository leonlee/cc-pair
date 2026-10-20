# Changelog

## Unreleased

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
