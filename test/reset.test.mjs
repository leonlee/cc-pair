import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { withAutoStopped } from "../dist/auto.js";
// The tests set every pair variable they need; one inherited from a pair session (PAIR_PARTNER, PAIR_AUTO_*) would leak in.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("PAIR_")) {
    delete process.env[name];
  }
}

const CLI = join(import.meta.dirname, "..", "dist", "pair.js");
const exec = promisify(execFile);

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pair-reset-test-")));
  const socketDir = realpathSync(mkdtempSync("/tmp/pair-rs-"));
  const env = {
    ...process.env, PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"),
    PAIR_AUTO_SOCKET_DIR: socketDir, PAIR_NO_UPDATE_CHECK: "1", PAIR_AGENT: "codex",
    PAIR_AUTO_ROLE: "", PAIR_AUTO_RUN: "", CODEX_THREAD_ID: "", CLAUDECODE: "",
  };
  const run = (args, input, extra = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...extra }, input, encoding: "utf8", timeout: 5000 });
    return { code: result.status, out: result.stdout + result.stderr };
  };
  const ok = (args, input, extra) => {
    const result = run(args, input, extra);
    assert.equal(result.code, 0, result.out);
    return result.out;
  };
  const channel = ok(["status"]).match(/^channel: (.+)$/m)[1];
  const stateDir = join(env.XDG_STATE_HOME, "pair", basename(channel));
  const request = (author, body = "Review a.ts") => ok(["send", "request", "--as", author, "-"], body).match(/^sent: (.+)$/m)[1];
  const backup = (output) => output.match(/^saved pending requests: (.+)$/m)[1];
  t.after(() => {
    try { assert.deepEqual(readdirSync(socketDir), [], "reset must release its socket"); }
    finally { rmSync(root, { recursive: true, force: true }); rmSync(socketDir, { recursive: true, force: true }); }
  });
  return { root, socketDir, env, run, ok, channel, stateDir, request, backup };
}

test("reset backs up both pending lanes, preserves finished history and registration, and permits fresh requests", (t) => {
  const f = fixture(t);
  f.request("claude", "Finished task");
  f.ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "Approved");
  f.ok(["wait", "--as", "claude", "--timeout", "1"]);
  const history = f.ok(["history"]);
  const claudeFile = f.request("claude", "Stale Claude task");
  f.ok(["send", "review", "--as", "codex", "--verdict", "changes", "-"], "### F1 [medium] obsolete finding");
  const codexFile = f.request("codex", "Stale Codex task");
  const first = readFileSync(claudeFile, "utf8");
  const second = readFileSync(codexFile, "utf8");
  const source = join(f.root, "a.ts");
  writeFileSync(source, "user source\n");
  f.ok(["register"], undefined, { CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111" });
  const registration = readFileSync(join(f.channel, "codex.session"), "utf8");

  const output = f.ok(["reset"], undefined, { PAIR_KEEP: "0" });
  const saved = f.backup(output);
  assert.match(output, /reset: claude-to-codex/);
  assert.match(output, /reset: codex-to-claude/);
  assert.equal(readFileSync(join(saved, "claude-to-codex", basename(join(claudeFile, "..")), "001-request.md"), "utf8"), first);
  assert.equal(readFileSync(join(saved, "codex-to-claude", basename(join(codexFile, "..")), "001-request.md"), "utf8"), second);
  assert.equal(JSON.parse(readFileSync(join(saved, "reset.json"), "utf8")).worktree, f.root);
  assert.equal(f.ok(["history"]), history, "reset must not prune existing history, even with PAIR_KEEP=0");
  assert.equal(readFileSync(source, "utf8"), "user source\n");
  assert.equal(readFileSync(join(f.channel, "codex.session"), "utf8"), registration);
  assert.match(f.ok(["status"]), /claude-to-codex: idle\ncodex-to-claude: idle/);
  f.request("claude", "Fresh task");
  assert.match(f.ok(["wait", "--as", "codex", "--timeout", "1"]), /Fresh task/);
});

test("--as selects the request author, leaving the opposite lane intact", (t) => {
  const f = fixture(t);
  const removed = f.request("claude", "Old Claude request");
  const kept = f.request("codex", "Keep this Codex request");
  const saved = f.backup(f.ok(["reset", "--as", "claude"]));
  assert.ok(!existsSync(removed));
  assert.ok(existsSync(join(saved, "claude-to-codex")));
  assert.ok(!existsSync(join(saved, "codex-to-claude")));
  assert.ok(existsSync(kept));
  assert.match(f.ok(["status"]), /claude-to-codex: idle\ncodex-to-claude: awaiting-review/);
});

test("dry run previews pending lanes without changing requests, instructions, or history", (t) => {
  const f = fixture(t);
  f.ok(["init"]);
  const agents = join(f.root, "AGENTS.md");
  writeFileSync(agents, "<!-- pair:start -->\nstale instructions\n<!-- pair:end -->\n");
  const file = f.request("claude"); // send refreshes instructions; make them stale again below
  writeFileSync(agents, "<!-- pair:start -->\nstale instructions\n<!-- pair:end -->\n");
  const request = readFileSync(file, "utf8");
  const instructions = readFileSync(agents, "utf8");
  const output = f.ok(["reset", "--dry-run"]);
  assert.match(output, /would reset/);
  assert.match(output, /claude-to-codex/);
  assert.match(output, /no files changed/);
  assert.equal(readFileSync(file, "utf8"), request);
  assert.equal(readFileSync(agents, "utf8"), instructions);
  assert.ok(!existsSync(join(f.channel, "resets")));
});

test("other commands reject --dry-run before deleting history or instructions", (t) => {
  const f = fixture(t);
  f.ok(["init"]);
  f.request("claude", "Finished task");
  f.ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "Approved");
  f.ok(["wait", "--as", "claude", "--timeout", "1"]);
  const history = f.ok(["history"]);
  const agents = readFileSync(join(f.root, "AGENTS.md"), "utf8");
  for (const args of [["clean", "--keep", "0", "--dry-run"], ["uninit", "--dry-run"], ["upgrade", "--dry-run"]]) {
    const result = f.run(args);
    assert.equal(result.code, 1);
    assert.match(result.out, /--dry-run is only supported by pair reset/);
    assert.equal(f.ok(["history"]), history);
    assert.equal(readFileSync(join(f.root, "AGENTS.md"), "utf8"), agents);
  }
});

test("reset makes unread closed verdicts visible and preserves them in the backup", (t) => {
  const f = fixture(t);
  const request = f.request("claude", "Already reviewed task");
  f.ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "Unread approval");
  assert.match(f.ok(["reset", "--dry-run"]), /claude-to-codex: closed/);
  const output = f.ok(["reset"]);
  assert.match(output, /reset: claude-to-codex: closed/);
  const saved = f.backup(output);
  const review = join(saved, "claude-to-codex", basename(join(request, "..")), "002-review.md");
  assert.match(readFileSync(review, "utf8"), /Unread approval/);
  assert.match(f.ok(["history"]), /no finished threads yet/);
});

test("reset is idempotent and does not create a missing channel", (t) => {
  const f = fixture(t);
  assert.match(f.ok(["reset", "--dry-run"]), /nothing to reset/);
  assert.match(f.ok(["reset"]), /nothing to reset/);
  assert.ok(!existsSync(f.channel));
  f.request("claude");
  f.ok(["reset"]);
  const backups = readdirSync(join(f.channel, "resets"));
  assert.match(f.ok(["reset"]), /nothing to reset/);
  assert.deepEqual(readdirSync(join(f.channel, "resets")), backups);
});

test("reset recovers legacy, corrupt, hidden, and older requests without parsing them", (t) => {
  const f = fixture(t);
  const legacy = join(f.channel, "claude-to-codex");
  const other = join(f.channel, "codex-to-claude");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "001-request.md"), "old flat request\n");
  for (const name of ["older", "newer", ".partial"]) {
    mkdirSync(join(other, name), { recursive: true });
    writeFileSync(join(other, name, "001-request.md"), `corrupt ${name}\n`);
  }
  assert.equal(f.run(["status"]).code, 1);
  assert.match(f.ok(["reset", "--dry-run"]), /unparseable/);
  const saved = f.backup(f.ok(["reset"]));
  assert.equal(readFileSync(join(saved, "claude-to-codex", "001-request.md"), "utf8"), "old flat request\n");
  for (const name of ["older", "newer", ".partial"]) {
    assert.equal(readFileSync(join(saved, "codex-to-claude", name, "001-request.md"), "utf8"), `corrupt ${name}\n`);
  }
  assert.match(f.ok(["status"]), /claude-to-codex: idle\ncodex-to-claude: idle/);
  f.request("claude", "Recovered");
});

test("reset backs up a lane path that became a regular file", (t) => {
  const f = fixture(t);
  mkdirSync(f.channel, { recursive: true });
  writeFileSync(join(f.channel, "claude-to-codex"), "not a lane");
  assert.equal(f.run(["send", "request", "--as", "claude", "-"], "x").code, 1);
  assert.match(f.ok(["reset", "--as", "claude", "--dry-run"]), /claude-to-codex: unparseable/);
  const saved = f.backup(f.ok(["reset", "--as", "claude"]));
  assert.equal(readFileSync(join(saved, "claude-to-codex"), "utf8"), "not a lane");
  f.request("claude", "Recovered");
});

test("reset preserves lane symlinks themselves instead of following them", (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "user.txt"), "preserve me");
  mkdirSync(f.channel, { recursive: true });
  symlinkSync(outside, join(f.channel, "claude-to-codex"));
  const saved = f.backup(f.ok(["reset"]));
  assert.equal(readFileSync(join(outside, "user.txt"), "utf8"), "preserve me");
  assert.equal(realpathSync(join(saved, "claude-to-codex")), outside);
  assert.ok(!existsSync(join(f.channel, "claude-to-codex")));
});

test("reset refuses a symlink at the backup root", (t) => {
  const f = fixture(t);
  const request = f.request("claude");
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.channel, "resets"));
  const result = f.run(["reset"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /refusing to write reset backups/);
  assert.ok(existsSync(request));
  assert.deepEqual(readdirSync(outside), []);
});

test("partial reset failure preserves every request and reports its backup", (t) => {
  const f = fixture(t);
  const first = f.request("claude", "First request");
  const second = f.request("codex", "Second request");
  const hook = join(f.root, "deny-rename.mjs");
  writeFileSync(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const rename=fs.renameSync; fs.renameSync=(from,to)=>{if(String(from).endsWith('/codex-to-claude')) throw Object.assign(new Error('denied'),{code:'EACCES',path:from}); return rename(from,to);}; syncBuiltinESMExports();`);
  const result = f.run(["reset"], undefined, { NODE_OPTIONS: `--import=${hook}` });
  assert.equal(result.code, 1);
  assert.match(result.out, /reset failed after moving claude-to-codex/);
  assert.match(result.out, /preserved at/);
  const saved = join(f.channel, "resets", readdirSync(join(f.channel, "resets"))[0]);
  assert.ok(!existsSync(first));
  assert.ok(existsSync(join(saved, "claude-to-codex", basename(join(first, "..")), "001-request.md")));
  assert.ok(existsSync(second));
  f.ok(["reset"]);
  assert.match(f.ok(["status"]), /claude-to-codex: idle\ncodex-to-claude: idle/);
});

test("auto startup cannot bind while the manual reset owns the socket", async (t) => {
  const f = fixture(t);
  const previous = process.env.PAIR_AUTO_SOCKET_DIR;
  process.env.PAIR_AUTO_SOCKET_DIR = f.socketDir;
  try {
    await withAutoStopped(f.stateDir, async () => {
      const path = join(f.socketDir, `${createHash("sha256").update(f.stateDir).digest("hex").slice(0, 24)}.sock`);
      assert.ok(existsSync(path));
      await assert.rejects(exec(process.execPath, [CLI, "start", "--as", "claude", "--claude", process.execPath, "--codex", process.execPath], { cwd: f.root, env: f.env }), /cannot own auto mode socket/);
      assert.ok(!existsSync(join(f.stateDir, "auto.json")));
    });
  } finally {
    if (previous === undefined) delete process.env.PAIR_AUTO_SOCKET_DIR;
    else process.env.PAIR_AUTO_SOCKET_DIR = previous;
  }
  f.ok(["reset"]); // ownership was released even after awaiting the competing startup
});

test("invalid reset arguments do not move requests", (t) => {
  const f = fixture(t);
  const request = f.request("claude");
  for (const args of [["reset", "--as", "Not-A-Name"], ["reset", "unexpected-id"]]) {
    assert.equal(f.run(args).code, 1);
    assert.ok(existsSync(request));
    assert.ok(!existsSync(join(f.channel, "resets")));
  }
  // A valid name with no lanes resets nothing, and leaves claude's lane alone.
  assert.match(f.ok(["reset", "--as", "alice"]), /nothing to reset/);
  assert.ok(existsSync(request));
  assert.match(f.ok(["reset", "--help"]), /pair reset/);
});

test("denied reset socket access gives terminal guidance without changing requests", (t) => {
  const f = fixture(t);
  const request = f.request("claude");
  const hook = join(f.root, "deny-socket.cjs");
  writeFileSync(hook, `const net=require('node:net'); net.Server.prototype.listen=function(){queueMicrotask(()=>this.emit('error',Object.assign(new Error('listen EPERM'),{code:'EPERM'})));return this;};`);
  const result = f.run(["reset"], undefined, { NODE_OPTIONS: `--require=${hook}` });
  assert.equal(result.code, 1);
  assert.match(result.out, /run pair reset in your own terminal, outside agent sandboxes/);
  assert.ok(existsSync(request));
  assert.ok(!existsSync(join(f.channel, "resets")));
});

const nameOf = (path) => `${basename(path)}-${createHash("sha1").update(path).digest("hex").slice(0, 8)}`;

/** pair prune's view of a fixture: worktrees that sent a request (so their channel records them), and where things live. */
function pruning(f) {
  const home = f.env.PAIR_HOME;
  const states = join(f.env.XDG_STATE_HOME, "pair");
  const at = (cwd, args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: f.env, input, encoding: "utf8", timeout: 5000 });
  const worktree = (name) => {
    const dir = join(f.root, name);
    mkdirSync(dir);
    const sent = at(dir, ["send", "request", "--as", "claude", "-"], "req");
    assert.equal(sent.status, 0, sent.stderr);
    return { dir, name: nameOf(dir) };
  };
  const exists = (name) => existsSync(join(home, name)) || existsSync(join(states, name));
  return { home, states, worktree, exists };
}

test("prune deletes only the channels and auto state of removed worktrees, after asking, and never one an auto session holds", async (t) => {
  const f = fixture(t);
  const { home, states, worktree, exists } = pruning(f);
  const gone = worktree("gone");
  const held = worktree("held");
  const live = worktree("live");
  mkdirSync(join(states, gone.name), { recursive: true });
  writeFileSync(join(states, gone.name, "author.json"), "{}");
  // Known only from auto mode's state, as before pair recorded it in the channel.
  const stateOnly = join(f.root, "state-only");
  mkdirSync(join(states, nameOf(stateOnly)), { recursive: true });
  writeFileSync(join(states, nameOf(stateOnly), "auto.json"), JSON.stringify({ worktree: stateOnly }));
  // No record, and a record that doesn't hash to its channel: both kept, listed by name.
  mkdirSync(join(home, "legacy-0123abcd", "claude-to-codex"), { recursive: true });
  mkdirSync(join(home, "liar-89abcdef"));
  writeFileSync(join(home, "liar-89abcdef", "worktree"), `${gone.dir}\n`);
  rmSync(gone.dir, { recursive: true });
  rmSync(held.dir, { recursive: true });

  const dry = f.ok(["prune", "--dry-run"]);
  for (const [name, dir] of [[gone.name, gone.dir], [held.name, held.dir], [nameOf(stateOnly), stateOnly]]) assert.ok(dry.includes(`  ${name} (was ${dir})`), dry);
  assert.match(dry, /kept 2 whose worktree pair doesn't know .*\n  legacy-0123abcd\n  liar-89abcdef\n$/);
  assert.doesNotMatch(dry, new RegExp(live.name));
  const unasked = f.run(["prune"]);
  assert.equal(unasked.code, 1);
  assert.match(unasked.out, /Pass --yes to delete them without asking/);
  assert.ok([gone.name, held.name, nameOf(stateOnly)].every(exists), "nothing deleted without --yes or a terminal");

  const previous = process.env.PAIR_AUTO_SOCKET_DIR;
  process.env.PAIR_AUTO_SOCKET_DIR = f.socketDir;
  try {
    await withAutoStopped(join(states, held.name), async () => {
      const { stdout } = await exec(process.execPath, [CLI, "prune", "--yes"], { cwd: f.root, env: f.env });
      assert.ok(stdout.includes(`removed: ${gone.name} (was ${gone.dir})`), stdout);
      assert.ok(stdout.includes(`removed: ${nameOf(stateOnly)} (was ${stateOnly})`), stdout);
      assert.match(stdout, new RegExp(`kept: ${held.name}: cannot prune while auto mode`));
    });
  } finally {
    if (previous === undefined) delete process.env.PAIR_AUTO_SOCKET_DIR;
    else process.env.PAIR_AUTO_SOCKET_DIR = previous;
  }
  assert.ok(!exists(gone.name) && !exists(nameOf(stateOnly)));
  assert.ok([held.name, live.name, "legacy-0123abcd", "liar-89abcdef"].every(exists));
  assert.match(f.ok(["prune", "-y"]), new RegExp(`^removed: ${held.name} `));
  assert.match(f.ok(["prune"]), /^no channel belongs to a removed worktree\nkept 2 /);
  assert.ok(exists(live.name));
  assert.match(f.run(["status", "--yes"]).out, /--yes is only supported by pair start and pair prune/);
});

test("prune asks on a terminal, shows names escaped, and keeps a worktree that came back while it asked", (t) => {
  const f = fixture(t);
  const { home, worktree } = pruning(f);
  const back = worktree("back");
  const bell = worktree("be\x07ll");
  rmSync(back.dir, { recursive: true });
  rmSync(bell.dir, { recursive: true });
  // On a pty, answer y once the question shows, after putting the first worktree back.
  const python = `
import os, pty, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, cwd=os.environ['TEST_CWD'])
os.close(slave)
output = b''
answered = False
while True:
    try: chunk = os.read(master, 65536)
    except OSError: break
    if not chunk: break
    output += chunk
    if not answered and b'[y/N] ' in output:
        os.mkdir(os.environ['RECREATE'])
        os.write(master, b'y\\n')
        answered = True
child.wait()
sys.stdout.buffer.write(output)
`;
  const shown = spawnSync("python3", ["-c", python, process.execPath, CLI, "prune"], { env: { ...f.env, TEST_CWD: f.root, RECREATE: back.dir }, encoding: "utf8", timeout: 10000 });
  if (shown.error) return t.skip("python3 is unavailable");
  assert.ok(!shown.stdout.includes("\x07"), "no raw control byte reaches the terminal, in the question's list either");
  assert.match(shown.stdout, /\n  be\\x07ll-[0-9a-f]{8} \(was .*be\\x07ll\)/);
  assert.match(shown.stdout, new RegExp(`kept: ${back.name}: its worktree is back`));
  assert.match(shown.stdout, /removed: be\\x07ll-/);
  assert.ok(existsSync(join(home, back.name)) && !existsSync(join(home, bell.name)));
});

test("prune trusts no record behind a symlink", (t) => {
  const f = fixture(t);
  const { home, states } = pruning(f);
  const missing = join(f.root, "linked");
  const name = nameOf(missing);
  mkdirSync(join(states, name), { recursive: true });
  const elsewhere = join(f.root, "elsewhere");
  mkdirSync(join(elsewhere, "sessions"), { recursive: true });
  writeFileSync(join(elsewhere, "worktree"), `${missing}\n`);
  mkdirSync(home, { recursive: true });
  symlinkSync(elsewhere, join(home, name));
  // A real channel whose sessions directory is a link to the same records.
  const other = join(f.root, "other");
  mkdirSync(join(home, nameOf(other)));
  writeFileSync(join(elsewhere, "sessions", "x.json"), JSON.stringify({ worktree: other }));
  symlinkSync(join(elsewhere, "sessions"), join(home, nameOf(other), "sessions"));
  const out = f.ok(["prune", "--yes"]);
  assert.match(out, /^no channel belongs to a removed worktree\nkept 2 /);
  assert.ok(existsSync(join(states, name)) && existsSync(join(elsewhere, "worktree")) && existsSync(join(home, nameOf(other))));
});

test("a failed prune leaves a record outside both directories, so the next one finds what remains", (t) => {
  const f = fixture(t);
  const { home, states, worktree } = pruning(f);
  const marker = (name) => join(states, ".pruning", name);
  // Known only from auto mode's state, and the channel can't be removed yet.
  const stuck = join(f.root, "stuck");
  const name = nameOf(stuck);
  mkdirSync(join(states, name), { recursive: true });
  writeFileSync(join(states, name, "auto.json"), JSON.stringify({ worktree: stuck }));
  mkdirSync(join(home, name, "claude-to-codex"), { recursive: true });
  chmodSync(join(home, name), 0o555);
  t.after(() => { try { chmodSync(join(home, name), 0o755); } catch { /* removed */ } });
  assert.match(f.ok(["prune", "--yes"]), new RegExp(`^kept: ${name} \\(its auto state was removed\\): `));
  assert.ok(!existsSync(join(states, name)) && existsSync(marker(name)));
  chmodSync(join(home, name), 0o755);
  assert.match(f.ok(["prune", "--yes"]), new RegExp(`^removed: ${name} \\(was ${stuck}\\)`));
  assert.ok(!existsSync(join(home, name)) && !existsSync(marker(name)));

  // Known only from the channel's own record, and PAIR_HOME can't lose the emptied channel yet.
  const emptied = worktree("emptied");
  rmSync(emptied.dir, { recursive: true });
  chmodSync(home, 0o555);
  t.after(() => { try { chmodSync(home, 0o755); } catch { /* removed */ } });
  const out = f.ok(["prune", "--yes"]);
  assert.match(out, new RegExp(`^kept: ${emptied.name}: `));
  assert.doesNotMatch(out, /its auto state was removed/, "it had none");
  chmodSync(home, 0o755);
  assert.match(f.ok(["prune", "--yes"]), new RegExp(`^removed: ${emptied.name} `));
  assert.ok(!existsSync(join(home, emptied.name)) && !existsSync(marker(emptied.name)));

  // State that can't be removed leaves the channel and its record alone.
  const kept = worktree("kept");
  rmSync(kept.dir, { recursive: true });
  const state = join(states, kept.name);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "auto.log"), "");
  chmodSync(state, 0o555);
  t.after(() => { try { chmodSync(state, 0o755); } catch { /* removed */ } });
  assert.match(f.ok(["prune", "--yes"]), new RegExp(`^kept: ${kept.name}: `));
  assert.equal(readFileSync(join(home, kept.name, "worktree"), "utf8"), `${kept.dir}\n`);
  chmodSync(state, 0o755);
  assert.match(f.ok(["prune", "--yes"]), new RegExp(`^removed: ${kept.name} `));
});

test("a channel swapped for a link while prune removes its state costs only the link", (t) => {
  const f = fixture(t);
  const { home, states, worktree } = pruning(f);
  const swapped = worktree("swapped");
  rmSync(swapped.dir, { recursive: true });
  const state = join(states, swapped.name);
  mkdirSync(state, { recursive: true });
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "mine");
  // Swap the channel for a link to someone else's directory right after prune removes the state.
  const hook = join(f.root, "swap.cjs");
  writeFileSync(hook, `
const fs = require("node:fs");
const rm = fs.rmSync;
fs.rmSync = (path, options) => {
  rm(path, options);
  if (path === ${JSON.stringify(state)}) {
    rm(${JSON.stringify(join(home, swapped.name))}, { recursive: true, force: true });
    fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(join(home, swapped.name))});
  }
};
require("node:module").syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--require", hook, CLI, "prune", "--yes"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^removed: ${swapped.name} `));
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "mine");
  assert.throws(() => lstatSync(join(home, swapped.name)));
});

test("prune finds worktrees whose names end in a space or hold a newline", (t) => {
  const f = fixture(t);
  const { worktree } = pruning(f);
  const spaced = worktree("checkout ");
  const broken = worktree("check\nout");
  rmSync(spaced.dir, { recursive: true });
  rmSync(broken.dir, { recursive: true });
  const dry = f.ok(["prune", "--dry-run"]);
  assert.match(dry, /^2 belong/);
  assert.ok(dry.includes(`  ${spaced.name} (was ${spaced.dir})`), dry);
  assert.ok(dry.includes(`  check\\x0aout-${broken.name.slice(-8)} (was ${broken.dir.replace("\n", "\\x0a")})`), dry);
  assert.match(f.ok(["prune", "--yes"]), /^removed: .*\nremoved: /);
});
