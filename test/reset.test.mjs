import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { withAutoStopped } from "../dist/auto.js";

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
  for (const args of [["reset", "--as", "unknown"], ["reset", "unexpected-id"]]) {
    assert.equal(f.run(args).code, 1);
    assert.ok(existsSync(request));
    assert.ok(!existsSync(join(f.channel, "resets")));
  }
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
