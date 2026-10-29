import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, lstatSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { promisify } from "node:util";

// These protocol tests create their own agents/channels. Do not inherit an auto author's or
// reviewer's role when the developer runs npm test from inside a managed session.
for (const name of ["PAIR_AUTO_ROLE", "PAIR_AUTO_RUN", "PAIR_AUTO_MESSAGE", "PAIR_BIN"]) delete process.env[name];

const CLI = join(import.meta.dirname, "..", "dist", "pair.js");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "pair-test-"));
  // CODEX_THREAD_ID is cleared so tests behave the same when run from a Codex shell; no test asks npm for updates.
  const env = { ...process.env, PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_AGENT: "", CODEX_THREAD_ID: "", PAIR_NO_UPDATE_CHECK: "1" };
  const run = (args, input) => {
    const result = spawnSync("node", [CLI, ...args], { cwd: root, env, input, encoding: "utf8" });
    return { code: result.status, out: result.stdout + result.stderr };
  };
  const ok = (args, input) => {
    const result = run(args, input);
    assert.equal(result.code, 0, result.out);
    return result.out;
  };
  return { root, env, run, ok };
}

/** A fake codex that records each call's argv, optionally failing the first call. */
function fakeCodex(root, { failFirst = false } = {}) {
  const calls = join(root, "queue-calls");
  const codex = join(root, "fake-codex");
  const fail = failFirst ? `if [ ! -e "${calls}.failed" ]; then : > "${calls}.failed"; echo boom >&2; exit 1; fi\n` : "";
  writeFileSync(codex, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n${fail}`);
  chmodSync(codex, 0o755);
  return { codex, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trimEnd().split("\n") : []) };
}

function startMcp(env, cwd = tmpdir()) {
  const server = spawn("node", [CLI, "mcp"], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  const responses = new Map();
  const waiters = new Map();
  createInterface({ input: server.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    responses.set(message.id, message);
    waiters.get(message.id)?.(message);
  });
  let id = 0;
  const call = (method, params) => {
    id += 1;
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return responses.get(id) ?? new Promise((resolve) => waiters.set(id, resolve));
  };
  const listen = async (threadId) => (await call("tools/call", { name: "pair_listen", arguments: {}, ...(threadId ? { _meta: { threadId } } : {}) })).result;
  const stop = () => {
    server.stdin.end();
    return Promise.race([
      new Promise((resolve) => (server.exitCode !== null ? resolve(server.exitCode) : server.once("exit", resolve))),
      new Promise((resolve) => setTimeout(() => resolve("still running"), 5000)),
    ]);
  };
  return { server, call, listen, stop };
}

async function until(check, what) {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(check(), what);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 2500));

/** pair mcp's own files for the channel holding `pending`: they live in XDG_STATE_HOME, not the channel. */
function mcpState(root, pending, thread) {
  const channel = dirname(dirname(dirname(pending)));
  const dir = join(root, "state", "pair", basename(channel));
  return { channel, log: join(dir, "codex.listen.log"), claim: join(dir, "claims", `${basename(dirname(pending))}.${basename(pending)}.${thread}`) };
}

test("full review loop: request, changes, response, approve", () => {
  const { run, ok } = sandbox();
  ok(["send", "request", "--as", "claude", "-"], "## Summary\nadded parse()");

  const nothingYet = run(["wait", "--as", "claude", "--timeout", "1"]);
  assert.equal(nothingYet.code, 0, "a timeout is routine, not a failure");
  assert.match(nothingYet.out, /^pair: no message for claude yet\./, "author has nothing to read yet");
  const firstPickup = ok(["wait", "--as", "codex", "--timeout", "1"]);
  assert.match(firstPickup, /request from claude[\s\S]*added parse\(\)/);
  assert.doesNotMatch(firstPickup, /earlier in this thread/, "a fresh request has no history");
  assert.equal(run(["send", "request", "--as", "claude", "-"], "again").code, 1, "one open thread per direction");

  ok(["send", "review", "--as", "codex", "--verdict", "changes", "-"], "### F1 [high] a.ts:1 null deref");
  assert.equal(run(["send", "review", "--as", "codex", "--verdict", "changes", "-"], "dup").code, 1, "not codex's turn");
  assert.match(ok(["wait", "--as", "claude", "--timeout", "1"]), /verdict changes[\s\S]*F1[\s\S]*next: verify/);

  ok(["send", "response", "--as", "claude", "-"], "### F1 fixed");
  const responsePickup = ok(["wait", "--as", "codex", "--timeout", "1"]);
  assert.match(responsePickup, /response from claude · claude-to-codex · round 2/);
  assert.match(responsePickup, /earlier in this thread[^\n]*\/ 001-request\.md 002-review\.md ==/, "lists the history a restarted reviewer needs");
  ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM");

  assert.match(ok(["wait", "--as", "claude", "--timeout", "1"]), /approved and closed/);
  assert.match(ok(["status"]), /claude-to-codex: idle/);
});

test("escalates when the round cap is hit with findings still open", () => {
  const { root, run, ok } = sandbox();
  ok(["send", "request", "--as", "codex", "-"], "req");
  for (let round = 1; round <= 3; round++) {
    const sent = ok(["send", "review", "--as", "claude", "--verdict", "changes", "-"], `### F1 still broken r${round}`);
    assert.equal(/ESCALATED[\s\S]*STOP/.test(sent), round === 3, "reviewer is told to stop when its review escalates");
    if (round < 3) {
      ok(["send", "response", "--as", "codex", "-"], "### F1 rejected");
    }
  }
  assert.match(ok(["wait", "--as", "codex", "--timeout", "1"]), /ESCALATED/);
  assert.equal(run(["send", "response", "--as", "codex", "-"], "more").code, 1, "escalated thread is closed");

  const [channel] = readdirSync(join(root, "home"));
  const [archived] = readdirSync(join(root, "home", channel, "archive"));
  assert.match(archived, /codex-to-claude-escalated$/);
});

test("wait blocks until the partner writes, and messages are stored with frontmatter", async () => {
  const { root, env, ok } = sandbox();
  const waiting = promisify(execFile)("node", [CLI, "wait", "--as", "codex", "--timeout", "10"], { cwd: root, env });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const sent = ok(["send", "request", "--as", "claude", "-"], "late request").replace("sent: ", "").trim();

  const { stdout } = await waiting;
  assert.match(stdout, /late request/);
  assert.ok(existsSync(sent));
  assert.match(readFileSync(sent, "utf8"), /^---\nfrom: claude\ntype: request\nround: 1\nstatus: open\n---\nlate request/);
});

test("rejects bad input", () => {
  const { run } = sandbox();
  assert.match(run(["send", "request", "-"], "x").out, /--as \(or PAIR_AGENT\) must be one of/);
  assert.match(run(["send", "review", "--as", "codex", "-"], "x").out, /review needs --verdict/);
  assert.match(run(["send", "request", "--as", "claude", "-"], "  \n").out, /empty/);
  assert.match(run(["send", "nope", "--as", "claude", "-"], "x").out, /message type must be one of/);
});

test("help explains each command and its options", () => {
  const { run, ok } = sandbox();
  assert.match(ok(["--help"]), /pair help \[command\][\s\S]*PAIR_KEEP/);
  assert.match(run([]).out, /pair help \[command\]/);
  assert.equal(ok(["help", "start"]), ok(["start", "--help"]));
  assert.equal(ok(["help", "help"]), ok(["--help"]));
  assert.match(ok(["start", "-h"]), /--reviewer-effort LEVEL[\s\S]*--grace SECONDS/);
  assert.match(ok(["help", "send"]), /--verdict <approve\|changes>/);
  assert.match(ok(["help", "unregister"]), /usage: pair register \| pair unregister/);
  const unknown = run(["help", "nope"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /unknown command "nope"/);
});

test("a symlinked path to the same repo shares one channel", () => {
  const { root, env } = sandbox();
  spawnSync("git", ["init", "-q"], { cwd: root });
  const link = `${root}-link`;
  symlinkSync(root, link);
  const channelFrom = (cwd) => spawnSync("node", [CLI, "status"], { cwd, env, encoding: "utf8" }).stdout.split("\n")[0];
  assert.equal(channelFrom(link), channelFrom(root));
});

test("init from a subdirectory installs at the repo root", () => {
  const { root, env } = sandbox();
  spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "sub"));
  const result = spawnSync("node", [CLI, "init"], { cwd: join(root, "sub"), env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, "AGENTS.md")));
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /for `codex` only\. If you are not `codex`, ignore this section\./);
  assert.ok(existsSync(join(root, ".claude", "skills", "pair", "SKILL.md")));
  assert.ok(!existsSync(join(root, "sub", "AGENTS.md")));
  const status = spawnSync("node", [CLI, "status"], { cwd: join(root, "sub"), env, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(`worktree: ${realpathSync(root)}\n`));
  assert.match(status.stdout, /AGENTS\.md \(pair section\): current/);
  assert.match(status.stdout, /\.claude\/skills\/pair\/SKILL\.md: current/);
});

test("status diagnoses instructions without writing, and ignores user content outside the pair section", () => {
  const { root, env, ok } = sandbox();
  const agentsPath = join(root, "AGENTS.md");
  const skillPath = join(root, ".claude", "skills", "pair", "SKILL.md");
  const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;
  const before = ok(["status"]);
  assert.match(before, /^channel: /, "keep the channel on the first line");
  assert.ok(before.includes(`worktree: ${realpathSync(root)}\n`));
  assert.ok(before.includes(`version: claude-codex-pair ${version}\n`));
  assert.match(before, /AGENTS\.md \(pair section\): missing/);
  assert.match(before, /\.claude\/skills\/pair\/SKILL\.md: missing/);
  assert.match(before, /Run `pair init`/);
  assert.ok(!existsSync(env.PAIR_HOME), "status must not create a channel");
  assert.ok(!existsSync(agentsPath));
  assert.ok(!existsSync(join(root, ".claude")));

  writeFileSync(agentsPath, "# My instructions\n");
  assert.match(ok(["status"]), /AGENTS\.md \(pair section\): missing/);
  ok(["init"]);
  const generated = readFileSync(agentsPath, "utf8");
  assert.ok(generated.startsWith("# My instructions\n"));
  const customized = `User prefix\n${generated}\nUser suffix\n`;
  writeFileSync(agentsPath, customized);
  const current = ok(["status"]);
  assert.match(current, /AGENTS\.md \(pair section\): current/);
  assert.match(current, /\.claude\/skills\/pair\/SKILL\.md: current/);
  assert.match(current, /does not verify what running agents loaded/);
  assert.doesNotMatch(current, /Run `pair init`/);
  assert.equal(readFileSync(agentsPath, "utf8"), customized, "freshness is read-only");

  const stale = customized.replace("# pair: review loop", "# pair: old review loop");
  writeFileSync(agentsPath, stale);
  assert.match(ok(["status"]), /AGENTS\.md \(pair section\): stale/);
  assert.equal(readFileSync(agentsPath, "utf8"), stale, "status does not repair instructions");
  ok(["init"]);
  assert.equal(readFileSync(agentsPath, "utf8"), customized, "init refreshes only the marked section");
  writeFileSync(skillPath, "old skill\n");
  const oldSkill = ok(["status"]);
  assert.match(oldSkill, /AGENTS\.md \(pair section\): current/);
  assert.match(oldSkill, /\.claude\/skills\/pair\/SKILL\.md: stale/);
  rmSync(skillPath);
  assert.match(ok(["status"]), /\.claude\/skills\/pair\/SKILL\.md: missing/);
});

test("unreadable instructions remain a status diagnosis and do not affect message delivery", { skip: process.getuid?.() === 0 }, () => {
  const { root, ok } = sandbox();
  ok(["init"]);
  const paths = [join(root, "AGENTS.md"), join(root, ".claude", "skills", "pair", "SKILL.md")];
  paths.forEach((path) => chmodSync(path, 0o000));
  try {
    const status = ok(["status"]);
    assert.match(status, /AGENTS\.md \(pair section\): unreadable \(EACCES\)/);
    assert.match(status, /\.claude\/skills\/pair\/SKILL\.md: unreadable \(EACCES\)/);
    assert.match(status, /Check permissions on the unreadable instruction paths/);
    assert.doesNotMatch(status, /cannot access channel path/);
    ok(["send", "request", "--as", "claude", "-"], "still deliver");
    const message = ok(["wait", "--as", "codex", "--timeout", "1"]);
    assert.match(message, /^== pair: request from claude/);
    assert.match(message, /still deliver/);
    assert.doesNotMatch(message, /instructions on disk|unreadable/);
  } finally {
    paths.forEach((path) => chmodSync(path, 0o600));
  }
});

test("channel read and write permission errors name the path and give sandbox hints", { skip: process.getuid?.() === 0 }, () => {
  const { root, env, run, ok } = sandbox();
  // Relative and quoted PAIR_HOME must still produce usable absolute configuration paths.
  env.PAIR_HOME = 'home"quoted';
  const pairHome = join(realpathSync(root), env.PAIR_HOME);
  mkdirSync(pairHome);
  chmodSync(pairHome, 0o500);
  try {
    for (const args of [["init"], ["send", "request", "--as", "claude", "-"]]) {
      const denied = run(args, "request");
      assert.equal(denied.code, 1, denied.out);
      assert.match(denied.out, /^pair: cannot access channel path .*\(EACCES\)/);
      assert.ok(denied.out.includes(pairHome));
      assert.match(denied.out, /filesystem permissions and sandbox restrictions/);
      assert.ok(denied.out.includes(`writable_roots = [${JSON.stringify(pairHome)}]`));
      assert.ok(denied.out.includes(`"allowWrite": [${JSON.stringify(pairHome)}]`));
      assert.doesNotMatch(denied.out, /at (?:Object\.|file:)/, "no stack trace for a diagnosed channel error");
    }
  } finally {
    chmodSync(pairHome, 0o700);
  }
  const messagePath = ok(["send", "request", "--as", "claude", "-"], "request").replace("sent: ", "").trim();
  const threadDir = dirname(messagePath);
  chmodSync(threadDir, 0o000);
  try {
    for (const args of [["status"], ["wait", "--as", "codex", "--timeout", "1"]]) {
      const denied = run(args);
      assert.equal(denied.code, 1, denied.out);
      assert.ok(denied.out.startsWith(`pair: cannot access channel path ${threadDir} (EACCES)`));
      assert.match(denied.out, /sandbox_workspace_write/);
    }
  } finally {
    chmodSync(threadDir, 0o700);
  }
  // Even an input file inside the channel is an input error, not a channel-operation failure.
  chmodSync(messagePath, 0o000);
  try {
    const inputError = run(["send", "request", "--as", "codex", messagePath]);
    assert.equal(inputError.code, 1);
    assert.match(inputError.out, /EACCES/);
    assert.doesNotMatch(inputError.out, /cannot access channel path|sandbox_workspace_write/);
  } finally {
    chmodSync(messagePath, 0o600);
  }
});

test("EPERM channel errors are diagnosed without treating installed prompt errors as channel errors", () => {
  const { root, env, ok } = sandbox();
  const channel = ok(["status"]).split("\n")[0].replace("channel: ", "");
  const hook = join(root, "deny-fs.mjs");
  writeFileSync(hook, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const deny = (operation, code, matches) => {
      const original = fs[operation];
      fs[operation] = function (path, ...rest) {
        if (matches(String(path))) {
          throw Object.assign(new Error("access denied"), { code, path });
        }
        return original.call(this, path, ...rest);
      };
    };
    if (process.env.DENY_PROMPT) {
      deny("readFileSync", "EACCES", (path) => path.endsWith("/prompts/pair.md"));
    } else {
      deny("readdirSync", "EPERM", (path) => path.startsWith(${JSON.stringify(channel)}));
    }
    syncBuiltinESMExports();
  `);
  const denied = spawnSync("node", ["--import", hook, CLI, "wait", "--as", "codex", "--timeout", "1"], { cwd: root, env, encoding: "utf8" });
  assert.equal(denied.status, 1);
  assert.ok(denied.stderr.startsWith(`pair: cannot access channel path ${join(channel, "codex-to-claude")} (EPERM)`));
  assert.match(denied.stderr, /sandbox_workspace_write/);
  const assetError = spawnSync("node", ["--import", hook, CLI, "status"], { cwd: root, env: { ...env, DENY_PROMPT: "1" }, encoding: "utf8" });
  assert.equal(assetError.status, 1);
  assert.match(assetError.stderr, /EACCES/);
  assert.doesNotMatch(assetError.stderr, /cannot access channel path|sandbox_workspace_write/);
});

test("a managed reviewer can only wait, send, and read status or history, and never refreshes instructions", () => {
  const { root, env, ok } = sandbox();
  ok(["init"]);
  ok(["send", "request", "--as", "claude", "-"], "req");
  ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "ok");
  ok(["wait", "--as", "claude", "--timeout", "1"]);
  const agentsPath = join(root, "AGENTS.md");
  const stale = readFileSync(agentsPath, "utf8").replace(/<!-- pair \S+ -->/, "<!-- pair 0.0.1 -->").replace("Your partner", "YOUR PARTNER");
  writeFileSync(agentsPath, stale);
  const asReviewer = (args) => {
    const result = spawnSync("node", [CLI, ...args], { cwd: root, env: { ...env, PAIR_AUTO_ROLE: "reviewer", PAIR_AGENT: "codex", PAIR_AUTO_MESSAGE: "none" }, encoding: "utf8" });
    return { code: result.status, out: result.stdout + result.stderr };
  };
  for (const args of [["clean", "--keep", "0"], ["uninit"], ["init"], ["stop"], ["reset"], ["upgrade"], ["register"], ["unregister"], ["ps"]]) {
    const result = asReviewer(args);
    assert.equal(result.code, 1, `${args.join(" ")}: ${result.out}`);
    assert.match(result.out, /a managed reviewer may only run pair wait, send, status, history/);
  }
  assert.match(asReviewer(["history"]).out, /approved/);
  const waited = asReviewer(["wait", "--as", "codex", "--timeout", "1"]);
  assert.equal(waited.code, 0, waited.out);
  assert.doesNotMatch(waited.out, /refreshed/);
  assert.equal(readFileSync(agentsPath, "utf8"), stale, "a reviewer must not rewrite worktree files");
  assert.ok(existsSync(join(root, ".claude", "skills", "pair", "SKILL.md")));
});

test("init writes instructions and reports an invalid auto socket directory instead of crashing", { skip: process.platform === "win32" }, () => {
  const { root, env } = sandbox();
  const result = spawnSync("node", [CLI, "init"], { cwd: root, env: { ...env, PAIR_AUTO_SOCKET_DIR: "relative" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Auto mode is unavailable until this is fixed: PAIR_AUTO_SOCKET_DIR must be an absolute path/);
  assert.ok(existsSync(join(root, "AGENTS.md")));
});

test("wait checks at least once and rejects a bad timeout", () => {
  const { run, ok } = sandbox();
  ok(["send", "request", "--as", "claude", "-"], "req");
  assert.match(run(["wait", "--as", "codex", "--timeout", "0.001"]).out, /request from claude/);
  assert.match(run(["wait", "--as", "codex", "--timeout", "abc"]).out, /--timeout must be a positive number/);
  assert.match(run(["send", "request", "--as", "claude", "missing.md"]).out, /message file not found/);
  assert.match(run(["wait", "--as"]).out, /^pair: /);
});

test("each thread gets a fresh directory, so a stale archive cannot move a newer thread", () => {
  const { ok } = sandbox();
  const sentPath = (out) => out.split("\n")[0].replace("sent: ", "").trim();
  const first = sentPath(ok(["send", "request", "--as", "claude", "-"], "first"));
  ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM");
  ok(["wait", "--as", "claude", "--timeout", "1"]);
  const second = sentPath(ok(["send", "request", "--as", "claude", "-"], "second"));

  assert.notEqual(dirname(first), dirname(second));
  assert.ok(!existsSync(dirname(first)), "first thread was archived");
  assert.match(ok(["wait", "--as", "codex", "--timeout", "1"]), /second/);
});

test("rejects a corrupt stored message with an error naming the file", () => {
  const { run, ok } = sandbox();
  const path = ok(["send", "request", "--as", "claude", "-"], "req").replace("sent: ", "").trim();
  writeFileSync(path, readFileSync(path, "utf8").replace("round: 1", "round: oops"));

  const result = run(["send", "review", "--as", "codex", "--verdict", "changes", "-"], "x");
  assert.equal(result.code, 1);
  assert.match(result.out, /corrupt message .*001-request\.md: round must be a positive integer/);

  writeFileSync(path, readFileSync(path, "utf8").replace("round: oops", "round: 1").replace("from: claude", "from: codex"));
  assert.match(run(["status"]).out, /corrupt message .*from must be one of: claude/);
});

test("a lane in the old flat layout fails with a recovery hint, and stray files are ignored", () => {
  const { run, ok } = sandbox();
  const channel = ok(["status"]).split("\n")[0].replace("channel: ", "");
  mkdirSync(join(channel, "codex-to-claude"), { recursive: true });
  writeFileSync(join(channel, "codex-to-claude", "notes.txt"), "not a thread");
  assert.match(ok(["status"]), /codex-to-claude: idle/);

  mkdirSync(join(channel, "claude-to-codex"), { recursive: true });
  writeFileSync(join(channel, "claude-to-codex", "001-request.md"), "---\nfrom: claude\n---\nold");
  const result = run(["wait", "--as", "codex", "--timeout", "1"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /^pair: .*old flat layout \(001-request\.md\)/);
  assert.ok(existsSync(join(channel, "claude-to-codex", "001-request.md")), "legacy messages are left in place");
});

test("wait survives the thread being archived between reading it and printing it", () => {
  const { root, env, ok } = sandbox();
  ok(["send", "request", "--as", "claude", "-"], "req");
  ok(["send", "review", "--as", "codex", "--verdict", "changes", "-"], "### F1 [high] a.ts:1 bug");
  ok(["send", "response", "--as", "claude", "-"], "### F1 fixed");

  // Simulates another process archiving the thread right after wait first reads it:
  // any second scan of the same thread directory then finds it gone.
  const hook = join(root, "archive-on-rescan.mjs");
  writeFileSync(hook, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname, join } from "node:path";
    const original = fs.readdirSync;
    const seen = new Set();
    fs.readdirSync = function (path, ...rest) {
      const dir = String(path);
      if (/-to-(claude|codex)\\/[^/]+$/.test(dir)) {
        if (seen.has(dir)) {
          const archive = join(dirname(dirname(dir)), "archive");
          fs.mkdirSync(archive, { recursive: true });
          fs.renameSync(dir, join(archive, basename(dir)));
        }
        seen.add(dir);
      }
      return original.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
  `);
  const result = spawnSync("node", ["--import", hook, CLI, "wait", "--as", "codex", "--timeout", "1"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /earlier in this thread[^\n]*001-request\.md 002-review\.md ==/);
});

test("history lists and shows finished threads, and clean keeps only the newest", () => {
  const { run, ok } = sandbox();
  assert.match(ok(["history"]), /no finished threads yet/);
  for (const n of [1, 2, 3]) {
    ok(["send", "request", "--as", "claude", "-"], `## Summary\nchange ${n}`);
    ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], `LGTM ${n}`);
    ok(["wait", "--as", "claude", "--timeout", "1"]);
  }
  const lines = ok(["history"]).trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /claude-to-codex  approved  2 messages  change 3$/, "newest first, with the request summary");

  const oldestId = lines[2].split("  ")[0];
  const transcript = ok(["history", oldestId.slice(-6)]);
  assert.match(transcript, /== thread .* approved ==[\s\S]*request from claude[\s\S]*change 1[\s\S]*verdict approve[\s\S]*LGTM 1/);
  assert.match(run(["history", "nope"]).out, /no finished thread matches "nope"/);
  assert.match(run(["history", "Z-"]).out, /3 finished threads match/);

  ok(["send", "request", "--as", "codex", "-"], "still open");
  assert.match(run(["clean"]).out, /clean needs --keep N/);
  for (const bad of ["--keep=-1", "--keep=", "--keep= ", "--keep=1.5", "--keep=Infinity"]) {
    assert.match(run(["clean", bad]).out, /--keep must be a whole number/, bad);
  }
  assert.equal(ok(["history"]).trim().split("\n").length, 3, "rejected values delete nothing");
  assert.match(ok(["clean", "--keep", "1"]), /removed 2 finished thread\(s\)/);
  assert.match(ok(["history"]), /^\S+  claude-to-codex  approved  2 messages  change 3\n$/);
  assert.match(ok(["status"]), /codex-to-claude: awaiting-review/, "clean never touches open threads");
});

test("history tolerates a thread removed by clean after the archive was listed", () => {
  const { root, env, ok } = sandbox();
  for (const n of [1, 2, 3]) {
    ok(["send", "request", "--as", "claude", "-"], `## Summary\nchange ${n}`);
    ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM");
    ok(["wait", "--as", "claude", "--timeout", "1"]);
  }
  const removedId = ok(["history"]).trim().split("\n")[2].split("  ")[0];

  // Simulates a concurrent `pair clean`: the archive was listed and the thread found, then it
  // vanishes just as its messages are about to be read.
  const hook = join(root, "clean-after-listing.mjs");
  writeFileSync(hook, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname } from "node:path";
    const original = fs.readdirSync;
    let removing = false; // rmSync itself calls readdirSync
    fs.readdirSync = function (path, ...rest) {
      const dir = String(path);
      if (!removing && basename(dirname(dir)) === "archive" && basename(dir).includes(process.env.REMOVE_ID)) {
        removing = true;
        fs.rmSync(dir, { recursive: true, force: true });
        removing = false;
      }
      return original.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
  `);
  const withHook = (args) => spawnSync("node", ["--import", hook, CLI, ...args], { cwd: root, env: { ...env, REMOVE_ID: removedId }, encoding: "utf8" });

  const listing = withHook(["history"]);
  assert.equal(listing.status, 0, listing.stderr);
  assert.equal(listing.stdout.trim().split("\n").length, 2);
  assert.ok(!listing.stdout.includes(removedId));

  ok(["send", "request", "--as", "claude", "-"], "## Summary\nchange 4");
  ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM");
  ok(["wait", "--as", "claude", "--timeout", "1"]);
  const fourth = ok(["history"]).trim().split("\n")[0].split("  ")[0];
  const shown = spawnSync("node", ["--import", hook, CLI, "history", fourth.slice(-6)], { cwd: root, env: { ...env, REMOVE_ID: fourth }, encoding: "utf8" });
  assert.equal(shown.status, 1);
  assert.match(shown.stderr, /^pair: finished thread .* was removed while reading it/);
});

test("finished threads are pruned automatically down to PAIR_KEEP", () => {
  const { root, env } = sandbox();
  const runWith = (keep, args, input) =>
    spawnSync("node", [CLI, ...args], { cwd: root, env: { ...env, PAIR_KEEP: keep }, input, encoding: "utf8" });
  const finishThread = (keep, n) => {
    const steps = [
      [["send", "request", "--as", "claude", "-"], `## Summary\nchange ${n}`],
      [["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM"],
      [["wait", "--as", "claude", "--timeout", "1"]],
    ];
    for (const [args, input] of steps) {
      const result = runWith(keep, args, input);
      assert.equal(result.status, 0, result.stderr);
    }
  };
  for (const n of [1, 2, 3]) {
    finishThread("all", n);
  }
  assert.equal(runWith("all", ["history"]).stdout.trim().split("\n").length, 3, "PAIR_KEEP=all keeps everything");

  finishThread("2", 4);
  const kept = runWith("2", ["history"]).stdout;
  assert.equal(kept.trim().split("\n").length, 2, "archiving thread 4 pruned down to 2");
  assert.match(kept, /change 4[\s\S]*change 3/);

  const bad = runWith("", ["send", "request", "--as", "claude", "-"], "x");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /PAIR_KEEP must be a whole number/);
  assert.match(runWith("2", ["status"]).stdout, /claude-to-codex: idle/, "the rejected send wrote nothing");
});

test("retention keeps the most recently finished thread, not the most recently created", () => {
  const { root, env } = sandbox();
  const runWith = (args, input) => {
    const result = spawnSync("node", [CLI, ...args], { cwd: root, env: { ...env, PAIR_KEEP: "1" }, input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  runWith(["send", "request", "--as", "claude", "-"], "## Summary\ncreated first, finished last");
  runWith(["send", "request", "--as", "codex", "-"], "## Summary\ncreated second, finished first");
  runWith(["send", "review", "--as", "claude", "--verdict", "approve", "-"], "LGTM");
  runWith(["wait", "--as", "codex", "--timeout", "1"]);
  runWith(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM");
  assert.match(runWith(["wait", "--as", "claude", "--timeout", "1"]), /approved and closed/);

  const kept = runWith(["history"]).trim().split("\n");
  assert.equal(kept.length, 1);
  assert.match(kept[0], /created first, finished last/, "the thread that just finished survives pruning");
});

test("a failed automatic cleanup warns but still delivers and still sends", { skip: process.getuid?.() === 0 }, () => {
  const { root, env } = sandbox();
  const runWith = (keep, args, input) =>
    spawnSync("node", [CLI, ...args], { cwd: root, env: { ...env, PAIR_KEEP: keep }, input, encoding: "utf8" });
  const must = (keep, args, input) => {
    const result = runWith(keep, args, input);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  must("all", ["send", "request", "--as", "claude", "-"], "## Summary\nold");
  must("all", ["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM");
  must("all", ["wait", "--as", "claude", "--timeout", "1"]);
  const channel = must("all", ["status"]).stdout.split("\n")[0].replace("channel: ", "");
  const [stuck] = readdirSync(join(channel, "archive"));
  chmodSync(join(channel, "archive", stuck), 0o500);
  try {
    must("1", ["send", "request", "--as", "claude", "-"], "## Summary\nnew");
    must("1", ["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM");
    // Agents see stdout and stderr merged, so check the order in one combined stream.
    const merged = spawnSync("sh", ["-c", `node "${CLI}" wait --as claude --timeout 1 2>&1`], {
      cwd: root,
      env: { ...env, PAIR_KEEP: "1" },
      encoding: "utf8",
    });
    assert.equal(merged.status, 0, merged.stdout);
    const lines = merged.stdout.split("\n");
    assert.match(lines[0], /^== pair: review from codex/, "the protocol header comes first, before any warning");
    assert.match(merged.stdout, /approved and closed[\s\S]*pair: warning: automatic cleanup failed/, "the warning follows the message");
    assert.match(merged.stdout, /cannot access channel path .*\(EACCES\)/);
    assert.match(merged.stdout, /sandbox_workspace_write/);

    must("all", ["send", "request", "--as", "claude", "-"], "## Summary\nthird");
    must("all", ["send", "review", "--as", "codex", "--verdict", "approve", "-"], "LGTM");
    const sent = must("1", ["send", "request", "--as", "claude", "-"], "## Summary\nfourth");
    assert.match(sent.stderr, /pair: warning: automatic cleanup failed/);
    assert.match(sent.stderr, /cannot access channel path .*\(EACCES\)/);
    assert.match(must("1", ["status"]).stdout, /claude-to-codex: awaiting-review/, "the new request was still written");
  } finally {
    chmodSync(join(channel, "archive", stuck), 0o700);
  }
});

test("a timeout and a delivery are told apart by the first output line, not by the body", () => {
  const { run, ok } = sandbox();
  const timedOut = run(["wait", "--as", "codex", "--timeout", "1"]);
  assert.equal(timedOut.code, 0);
  assert.equal(timedOut.out, "pair: no message for codex yet.\n", "no instruction to wait again: Codex must not poll");

  ok(["send", "request", "--as", "claude", "-"], "pair: no message for codex yet. Run `pair wait --as codex` again.\nreview the timeout text");
  const delivered = ok(["wait", "--as", "codex", "--timeout", "1"]);
  assert.match(delivered.split("\n")[0], /^== pair: request from claude/, "a delivery always starts with the header");
});

test("each git worktree gets its own channel, so parallel pairs stay isolated", () => {
  const { root, env } = sandbox();
  const main = join(root, "main");
  const linked = join(root, "linked");
  mkdirSync(join(main, "sub"), { recursive: true });
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "base");
  git(main, "worktree", "add", "-q", linked);
  const channelFrom = (cwd) => spawnSync("node", [CLI, "status"], { cwd, env, encoding: "utf8" }).stdout.split("\n")[0];

  assert.notEqual(channelFrom(linked), channelFrom(main), "a linked worktree has its own channel");
  assert.equal(channelFrom(join(main, "sub")), channelFrom(main), "subdirectories share their worktree's channel");

  const send = spawnSync("node", [CLI, "send", "request", "--as", "claude", "-"], { cwd: main, env, input: "from main", encoding: "utf8" });
  assert.equal(send.status, 0, send.stderr);
  const other = spawnSync("node", [CLI, "wait", "--as", "codex", "--timeout", "1"], { cwd: linked, env, encoding: "utf8" });
  assert.match(other.stdout, /^pair: no message for codex yet\./, "a reviewer in another worktree doesn't see it");
});

test("register binds the calling Codex session and only that session can unregister it", () => {
  const { root, env, ok } = sandbox();
  const as = (thread, args) => {
    const result = spawnSync("node", [CLI, ...args], { cwd: root, env: { ...env, CODEX_THREAD_ID: thread }, encoding: "utf8" });
    return { code: result.status, out: result.stdout + result.stderr };
  };
  const mine = "01a13922-c08f-79e3-a41f-6780876fd9c5";
  const other = "01a13927-59e7-74b1-8f59-306c2811e2b1";
  assert.match(as("", ["register"]).out, /CODEX_THREAD_ID is not set/);
  assert.match(as("not-a-uuid", ["register"]).out, /not a session id/);
  assert.match(as(mine, ["register"]).out, /registered codex session 01a13922/);
  assert.match(ok(["status"]), /codex notifications: session 01a13922-c08f-79e3-a41f-6780876fd9c5, registered/);
  assert.match(as(other, ["register"]).out, /replaced 01a13922/, "a newer session takes over and says so");

  const refused = as(mine, ["unregister"]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /different codex session .*01a13927.*nothing changed/, "an old session can't silence the new one");
  assert.match(ok(["status"]), /codex notifications: session 01a13927/);
  assert.match(ok(["unregister"]), /unregistered codex session 01a13927/, "the user's own shell can always unregister");
  assert.match(ok(["status"]), /codex notifications: no session registered/);
});

test("pair mcp notifies the registered session once per pending message, with a fixed nudge", async () => {
  const { root, env, ok } = sandbox();
  const thread = "01a13922-c08f-79e3-a41f-6780876fd9c5";
  const { codex, calls } = fakeCodex(root, { failFirst: true });
  const registered = spawnSync("node", [CLI, "register"], { cwd: root, env: { ...env, CODEX_THREAD_ID: thread }, encoding: "utf8" });
  assert.equal(registered.status, 0, registered.stderr);

  const servers = [];
  const start = (serverEnv) => {
    const server = startMcp(serverEnv);
    servers.push(server);
    return server;
  };
  try {
    const unpinned = start({ ...env, PAIR_CODEX: "codex" });
    assert.match((await unpinned.listen(thread)).content[0].text, /PAIR_CODEX must be the absolute path/, "codex is never looked up on PATH");

    const first = start({ ...env, PAIR_CODEX: codex });
    assert.equal((await first.call("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "pair");
    first.server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    assert.deepEqual((await first.call("tools/list", {})).result.tools.map((tool) => tool.name), ["pair_listen"]);
    const noMeta = await first.listen(undefined);
    assert.equal(noMeta.isError, true);
    assert.match(noMeta.content[0].text, /no Codex session id/);
    assert.match((await first.listen("01a13927-59e7-74b1-8f59-306c2811e2b1")).content[0].text, /isn't registered/);
    const listening = await first.listen(thread);
    assert.equal(listening.isError, undefined, listening.content[0].text);
    assert.match(listening.content[0].text, /End your turn now/);
    const second = start({ ...env, PAIR_CODEX: codex });
    assert.equal((await second.listen(thread)).isError, undefined, "a second Codex process on the same session listens too");

    ok(["send", "request", "--as", "claude", "-"], "SECRET partner text");
    await until(() => calls().length === 2, "the failed queue call is retried");
    const [, nudge] = calls();
    assert.match(nudge, new RegExp(`^queue --thread ${thread} --message pair: a message is waiting for you\\. Run \`pair wait --as codex --timeout 5\``));
    assert.doesNotMatch(nudge, /SECRET/, "channel content never reaches Codex as user input");
    assert.equal((await first.listen(thread)).isError, undefined);
    assert.equal((await second.listen(thread)).isError, undefined);
    await settle();
    assert.equal(calls().length, 2, "neither a second process nor listening again re-sends a pending message");

    ok(["send", "review", "--as", "codex", "--verdict", "changes", "-"], "### F1");
    ok(["send", "response", "--as", "claude", "-"], "### F1 fixed");
    await until(() => calls().length === 3, "a new pending message is nudged");
    await settle();
    assert.equal(calls().length, 3, "exactly once across both processes");

    ok(["unregister"]);
    ok(["send", "review", "--as", "codex", "--verdict", "approve", "-"], "ok");
    ok(["wait", "--as", "claude", "--timeout", "1"]);
    ok(["send", "request", "--as", "claude", "-"], "next");
    await settle();
    assert.equal(calls().length, 3, "an unregistered session is not notified");
    assert.match(ok(["status"]), /last listener event: .*stopped notifying/);
  } finally {
    const codes = await Promise.all(servers.map((server) => server.stop()));
    assert.deepEqual(codes, servers.map(() => 0), "each server exits when Codex closes its stdin");
  }
});

test("a claim left by a server that died mid-send is taken over once its lease runs out", async () => {
  const { root, env, ok } = sandbox();
  const thread = "01a13922-c08f-79e3-a41f-6780876fd9c5";
  const { codex, calls } = fakeCodex(root);
  spawnSync("node", [CLI, "register"], { cwd: root, env: { ...env, CODEX_THREAD_ID: thread } });
  const pending = ok(["send", "request", "--as", "claude", "-"], "req").replace("sent: ", "").trim();
  const { log, claim } = mcpState(root, pending, thread);
  mkdirSync(dirname(claim), { recursive: true });
  writeFileSync(claim, "sending\n"); // a sender that crashed between claiming and queueing

  writeFileSync(log, "old event\n".repeat(30_000)); // past the 256 KB rotation size

  const server = startMcp({ ...env, PAIR_CODEX: codex });
  try {
    assert.equal((await server.listen(thread)).isError, undefined);
    assert.match(readFileSync(log, "utf8"), /^\S+ listening for 01a13922/, "a full log is rotated before the next event");
    assert.equal(readFileSync(`${log}.1`, "utf8"), "old event\n".repeat(30_000), "one previous log is kept");
    await settle();
    assert.equal(calls().length, 0, "a fresh claim belongs to a sender that may still be working");
    const longAgo = new Date(Date.now() - 5 * 60 * 1000);
    utimesSync(claim, longAgo, longAgo);
    await until(() => calls().length === 1, "an abandoned claim is taken over and the message delivered");
    await until(() => readFileSync(claim, "utf8") === "sent\n", "a confirmed send is recorded");
    await settle();
    assert.equal(calls().length, 1);
  } finally {
    assert.equal(await server.stop(), 0);
  }
});

test("init pins codex only outside the worktree, the channels and temp directories, even through a symlink", () => {
  const { root, env } = sandbox();
  const executable = (path) => {
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
  };
  const inside = join(root, "tools");
  mkdirSync(inside);
  executable(join(inside, "codex"));
  const temp = mkdtempSync(join(tmpdir(), "pair-path-"));
  // Outside the test's worktree and outside every temp directory: the test checkout itself.
  const trusted = mkdtempSync(join(import.meta.dirname, ".pair-path-"));
  const init = (path) => spawnSync("node", [CLI, "init"], { cwd: root, env: { ...env, PATH: `${path}:${dirname(process.execPath)}` }, encoding: "utf8" }).stdout;
  const placeholder = /--env 'PAIR_CODEX=<absolute path of codex>'/;
  try {
    assert.match(init(inside), placeholder, "a codex inside the worktree is refused");
    executable(join(temp, "codex"));
    assert.match(init(temp), placeholder, "a codex in a temp directory is refused: agents can write there");
    symlinkSync(join(inside, "codex"), join(trusted, "codex"));
    assert.match(init(trusted), placeholder, "a link into the worktree is refused");
    rmSync(join(trusted, "codex"));
    executable(join(trusted, "codex"));
    // Codex hands MCP servers only HOME, PATH and a few more, so pair's own settings travel in the command.
    const forwarded = `--env 'PAIR_HOME=${env.PAIR_HOME}' --env 'XDG_STATE_HOME=${env.XDG_STATE_HOME}'`;
    assert.match(init(trusted), new RegExp(`${forwarded} --env 'PAIR_CODEX=${join(trusted, "codex")}' pair -- '.*dist/pair\\.js' mcp`));
  } finally {
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("a relative PAIR_HOME means the same channel from any subdirectory, and pair mcp gets it absolute", async () => {
  const { root, env } = sandbox();
  const thread = "01a13922-c08f-79e3-a41f-6780876fd9c5";
  spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "sub"));
  const relative = { ...env, PAIR_HOME: "home" };
  const printed = spawnSync("node", [CLI, "init"], { cwd: root, env: relative, encoding: "utf8" }).stdout;
  const home = printed.match(/--env 'PAIR_HOME=([^']+)'/)?.[1];
  assert.equal(home, join(realpathSync(root), "home"));
  spawnSync("node", [CLI, "register"], { cwd: join(root, "sub"), env: { ...relative, CODEX_THREAD_ID: thread } });
  // Codex passes the server only what the command sets, so give it exactly that PAIR_HOME.
  const server = startMcp({ ...env, PAIR_HOME: home, PAIR_CODEX: fakeCodex(root).codex });
  try {
    assert.equal((await server.listen(thread)).isError, undefined, "registered from a subdirectory, found by the server");
  } finally {
    assert.equal(await server.stop(), 0);
  }
  const empty = spawnSync("node", [CLI, "status"], { cwd: root, env: { ...env, PAIR_HOME: "", HOME: root }, encoding: "utf8" }).stdout;
  assert.match(empty, new RegExp(`channel: ${join(root, ".pair")}/`), "an empty PAIR_HOME means the default");
});

test("pair mcp writes nothing in the channel, so a channel swapped for a symlink can't redirect it", async () => {
  const { root, env, ok } = sandbox();
  const thread = "01a13922-c08f-79e3-a41f-6780876fd9c5";
  const { codex, calls } = fakeCodex(root);
  spawnSync("node", [CLI, "register"], { cwd: root, env: { ...env, CODEX_THREAD_ID: thread } });
  const pending = ok(["send", "request", "--as", "claude", "-"], "req").replace("sent: ", "").trim();
  const { channel, log } = mcpState(root, pending, thread);

  const server = startMcp({ ...env, PAIR_CODEX: codex });
  try {
    assert.equal((await server.listen(thread)).isError, undefined);
    await until(() => calls().length === 1, "the message is delivered");
    assert.deepEqual(readdirSync(channel).sort(), ["claude-to-codex", "codex.session"], "the listener left nothing in the channel");

    // An agent swaps its channel for a link to a directory it shouldn't be able to write.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    renameSync(channel, `${channel}.moved`);
    symlinkSync(elsewhere, channel);
    await until(() => existsSync(log) && /stopped notifying/.test(readFileSync(log, "utf8")), "the listener notices and stops");
    assert.deepEqual(readdirSync(elsewhere), [], "nothing was written through the swapped channel");
  } finally {
    assert.equal(await server.stop(), 0);
  }

  // The CLI won't read a planted registration link either.
  rmSync(channel);
  renameSync(`${channel}.moved`, channel);
  rmSync(join(channel, "codex.session"));
  symlinkSync(join(root, "elsewhere"), join(channel, "codex.session"));
  assert.match(ok(["status"]), /codex notifications: refusing to follow the symlink at .*codex\.session/);
});

test("uninit removes what init wrote, even from an older version, and keeps everything else", () => {
  const { root, env, ok } = sandbox();
  const agents = join(root, "AGENTS.md");
  const skill = join(root, ".claude", "skills", "pair", "SKILL.md");
  writeFileSync(agents, "# My rules\n\nBe kind.\n");
  ok(["init"]);
  spawnSync("node", [CLI, "register"], { cwd: root, env: { ...env, CODEX_THREAD_ID: "01a13922-c08f-79e3-a41f-6780876fd9c5" } });
  ok(["send", "request", "--as", "claude", "-"], "history to keep");

  const out = ok(["uninit"]);
  assert.match(out, /removed: .*SKILL\.md/);
  assert.match(out, /removed: the pair section of .*AGENTS\.md/);
  assert.match(out, /removed: the codex session registration/);
  assert.match(out, /kept: message history\. To delete it: rm -rf '/);
  assert.match(out, /codex mcp remove pair/);
  assert.equal(readFileSync(agents, "utf8"), "# My rules\n\nBe kind.\n", "the user's own text is untouched");
  assert.equal(existsSync(join(root, ".claude")), false, "directories init created are gone once empty");
  assert.match(ok(["status"]), /codex notifications: no session registered/);
  assert.match(ok(["status"]), /claude-to-codex: awaiting-review/, "history is kept");
  assert.match(ok(["uninit"]), /^nothing from pair init found in /);

  // What 0.1.x wrote: its exact skill, and an AGENTS.md holding only an older section.
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, readFileSync(join(import.meta.dirname, "fixtures", "skill-0.1.x.md")));
  writeFileSync(agents, "<!-- pair:start -->\n# pair: old instructions\n<!-- pair:end -->\n");
  const old = ok(["uninit"]);
  assert.match(old, /removed: .*SKILL\.md/, "a skill exactly as 0.1.x wrote it is recognized");
  assert.match(old, /removed: .*AGENTS\.md \(it held only the pair section\)/);
  assert.equal(existsSync(agents), false);

  // A pair skill someone edited is theirs now.
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, `${readFileSync(join(import.meta.dirname, "fixtures", "skill-0.1.x.md"), "utf8")}\nMy extra rule.\n`);
  assert.match(ok(["uninit"]), /kept: .*SKILL\.md \(it isn't a file pair init wrote/);
  assert.match(readFileSync(skill, "utf8"), /My extra rule\./);
});

test("uninit keeps the text around pair sections in the middle, repeated, or with CRLF", () => {
  const { root, ok } = sandbox();
  const agents = join(root, "AGENTS.md");
  const section = (eol) => ["<!-- pair:start -->", "old", "<!-- pair:end -->", ""].join(eol);
  const cases = [
    [`before\n${section("\n")}after\n`, "before\nafter\n"],
    [`A\n${section("\n")}between\n${section("\n")}Z\n`, "A\nbetween\nZ\n"],
    [`before\r\n${section("\r\n")}after\r\n`, "before\r\nafter\r\n"],
    [`mine\r\n\r\n${section("\r\n")}`, "mine\r\n"],
  ];
  // And a real init/uninit round trip, whatever the file's last line looked like.
  for (const original of ["mine", "mine\n", "mine\n\n", "mine\r\n"]) {
    writeFileSync(agents, original);
    ok(["init"]);
    ok(["uninit"]);
    assert.equal(readFileSync(agents, "utf8"), original, JSON.stringify(original));
  }
  for (const [text, expected] of cases) {
    writeFileSync(agents, text);
    ok(["uninit"]);
    assert.equal(readFileSync(agents, "utf8"), expected, JSON.stringify(text));
  }
});

test("uninit's printed cleanup command is safe to paste for any worktree name", () => {
  const { root, env } = sandbox();
  const worktree = join(root, "it's $(touch PWNED) `touch PWNED2`");
  mkdirSync(worktree);
  const run = (args, input) => spawnSync("node", [CLI, ...args], { cwd: worktree, env, input, encoding: "utf8" });
  assert.equal(run(["send", "request", "--as", "claude", "-"], "req").status, 0);
  const out = run(["uninit"]).stdout;
  const command = /To delete it: (rm -rf .*)/.exec(out)?.[1];
  assert.ok(command, out);
  const channel = join(root, "home", readdirSync(join(root, "home"))[0]);
  assert.equal(spawnSync("sh", ["-c", command], { cwd: root }).status, 0);
  assert.equal(existsSync(channel), false, "the command deletes the channel it names");
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith("PWNED")), [], "and runs nothing from the name");
});

test("ps groups pair processes by worktree, with its Codex registration, and skips shell wrappers", { skip: spawnSync("ps", ["-p", String(process.pid)]).status !== 0 && "ps is blocked here" }, async () => {
  const { root, env } = sandbox();
  const thread = "01a13922-c08f-79e3-a41f-6780876fd9c5";
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("node", [CLI, "register"], { cwd: root, env: { ...env, CODEX_THREAD_ID: thread } });
  const server = startMcp(env, root);
  // A shell wrapper whose own command line names the script; `; true` keeps sh from exec'ing node.
  const wrapper = spawn("sh", ["-c", `node ${CLI} wait --as codex --timeout 30; true`], { cwd: root, env, detached: true });
  const ps = (...args) => spawnSync("node", [CLI, "ps", ...args], { env, encoding: "utf8" }).stdout;
  const ourBlock = (out) => out.split("\n\n").find((block) => block.startsWith(`${basename(realpathSync(root))}  `)) ?? "";
  try {
    await server.call("ping");
    let block = "";
    await until(() => (block = ourBlock(ps())).includes("\n  wait "), "the wrapped pair wait shows up");
    assert.match(block, /^ {2}codex {3}registered 01a13922$/m, "no note found: no claim about notes");
    // A note to an earlier session in this worktree isn't this session's note.
    const [channelName] = readdirSync(env.PAIR_HOME);
    mkdirSync(join(env.XDG_STATE_HOME, "pair", channelName), { recursive: true });
    writeFileSync(join(env.XDG_STATE_HOME, "pair", channelName, "codex.listen.log"), "2026-10-20T00:00:00.000Z notified 01a0aaaa-0000-7000-8000-000000000000 about /x/001-request.md\n");
    assert.match(ourBlock(ps()), /^ {2}codex {3}registered 01a13922$/m);
    writeFileSync(join(env.XDG_STATE_HOME, "pair", channelName, "codex.listen.log"), `${new Date().toISOString()} notified ${thread} about /x/001-request.md\n`, { flag: "a" });
    assert.match(ourBlock(ps()), /^ {2}codex {3}registered 01a13922 · last note 0m ago$/m);
    // The agents may use another PAIR_HOME, so finding no registration here claims nothing.
    const elsewhere = spawnSync("node", [CLI, "ps"], { env: { ...env, PAIR_HOME: join(root, "other-home") }, encoding: "utf8" }).stdout;
    assert.doesNotMatch(ourBlock(elsewhere), /codex/);
    spawnSync("node", [CLI, "unregister"], { cwd: root, env });
    assert.doesNotMatch(ourBlock(ps()), /codex/, "a channel without a registration claims nothing either");
    assert.match(block, new RegExp(`^  mcp     ${server.server.pid} +\\d+m +node$`, "m"), "started by the test's node");
    const waits = block.split("\n").filter((line) => line.startsWith("  wait "));
    assert.equal(waits.length, 1, "the wrapper isn't listed, only node running the script");
    assert.doesNotMatch(waits[0], new RegExp(` ${wrapper.pid} `));
    assert.match(waits[0], / node$/, "the shell is skipped");
    assert.match(ourBlock(ps("-v")), new RegExp(`\\n  wait .+\\n {10}started by ${process.pid}: `), "-v shows the full command");
  } finally {
    process.kill(-wrapper.pid); // the group: sh and the node it started
    assert.equal(await server.stop(), 0);
  }
});

test("send and wait refresh instructions an older pair wrote, never ones a newer pair wrote", () => {
  const { root, env, ok, run } = sandbox();
  ok(["init"]);
  const agentsPath = join(root, "AGENTS.md");
  const skillPath = join(root, ".claude", "skills", "pair", "SKILL.md");
  const current = { agents: readFileSync(agentsPath, "utf8"), skill: readFileSync(skillPath, "utf8") };
  assert.match(current.skill, /<!-- pair \d+\.\d+\.\d+ -->\n/);

  // As 0.3.x wrote them: no stamp, older text.
  const old = (text) => text.replace(/<!-- pair \S+ -->\n/, "").replace("# pair: review loop", "# pair: old review loop");
  writeFileSync(agentsPath, `Mine\n${old(current.agents)}`);
  writeFileSync(skillPath, old(current.skill));
  assert.match(ok(["status"]), /SKILL\.md: stale/, "status stays read-only");
  // Agents read stdout and stderr merged, and decide by wait's first line.
  const merged = (args) => {
    const path = join(root, "merged.out");
    const fd = openSync(path, "w");
    spawnSync("node", [CLI, ...args], { cwd: root, env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    return readFileSync(path, "utf8");
  };
  if (process.getuid?.() !== 0) {
    chmodSync(skillPath, 0o444);
    const unwritable = merged(["wait", "--as", "codex", "--timeout", "1"]);
    chmodSync(skillPath, 0o644);
    assert.match(unwritable, /^pair: no message for codex yet\.\npair: couldn't refresh instructions \(EACCES/);
    assert.equal(readFileSync(agentsPath, "utf8"), `Mine\n${old(current.agents)}`, "nothing written after the failure");
  }
  const refreshed = merged(["wait", "--as", "codex", "--timeout", "1"]);
  assert.match(refreshed, /^pair: no message for codex yet\.\npair: refreshed .*SKILL\.md, .*AGENTS\.md \(pair section\) to pair /);
  assert.equal(readFileSync(agentsPath, "utf8"), `Mine\n${current.agents}`);
  assert.equal(readFileSync(skillPath, "utf8"), current.skill);
  assert.doesNotMatch(run(["wait", "--as", "codex", "--timeout", "1"]).out, /refreshed/, "nothing left to refresh");

  // Same text under an older stamp is current: no churn on releases that leave the prompt alone.
  writeFileSync(skillPath, current.skill.replace(/<!-- pair \S+ -->/, "<!-- pair 0.0.1 -->"));
  assert.match(ok(["status"]), /SKILL\.md: current/);
  // And the same text under a newer stamp keeps that stamp, even through init.
  const sameNewer = current.skill.replace(/<!-- pair \S+ -->/, "<!-- pair 99.0.0 -->");
  writeFileSync(skillPath, sameNewer);
  assert.match(ok(["init"]), /kept: .*SKILL\.md \(current\)/);
  ok(["wait", "--as", "codex", "--timeout", "1"]);
  assert.equal(readFileSync(skillPath, "utf8"), sameNewer);

  const newer = old(current.skill).replace("---\n\n", "---\n\n<!-- pair 99.0.0 -->\n");
  writeFileSync(skillPath, newer);
  ok(["send", "request", "--as", "claude", "-"], "hi");
  assert.equal(readFileSync(skillPath, "utf8"), newer, "an older pair never rolls back a newer one");
  assert.match(ok(["init"]), /kept: .*SKILL\.md \(a newer pair wrote it/);
  assert.equal(readFileSync(skillPath, "utf8"), newer, "not even through init");
  const status = ok(["status"]);
  assert.match(status, /SKILL\.md: newer \(pair 99\.0\.0\)/);
  assert.match(status, /run `pair upgrade`/);
  assert.doesNotMatch(status, /Run `pair init`/);
});

test("status shows the cached npm version when it is newer, and never checks when opted out", () => {
  const { root, env } = sandbox();
  const status = (extra) => spawnSync("node", [CLI, "status"], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" }).stdout;
  const cache = join(root, "state", "pair", "latest.json");
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ checkedAt: Date.now(), version: "99.0.0" }));
  assert.match(status({ PAIR_NO_UPDATE_CHECK: "" }), /update available: claude-codex-pair \S+ → 99\.0\.0\. Run `pair upgrade`/);
  assert.doesNotMatch(status({}), /update available/);
  writeFileSync(cache, JSON.stringify({ checkedAt: Date.now(), version: "0.0.1" }));
  assert.doesNotMatch(status({ PAIR_NO_UPDATE_CHECK: "" }), /update available/);
});

test("upgrade installs only a newer version, then reports just the new init's file changes where pair is set up", () => {
  const { root, env, ok } = sandbox();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls");
  const globalRoot = join(root, "global");
  const npm = `[ "$1" = root ] && echo "${globalRoot}" && exit 0\n[ "$1" = view ] && echo "\${NPM_LATEST:-99.0.0}" && exit \${NPM_VIEW_EXIT:-0}\nexit \${NPM_EXIT:-0}`;
  for (const [name, rest] of [["npm", npm], ["pair", "exit 0"]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${calls}"\n${rest}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const installed = join(globalRoot, "claude-codex-pair", "dist", "pair.js");
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(
    installed,
    `require("node:fs").appendFileSync(${JSON.stringify(calls)}, "new pair " + process.argv.slice(2).join(" ") + "\\n");\n` +
      `console.log("channel: c\\nwrote: /x/SKILL.md\\nkept: /x/AGENTS.md (pair section) (current)\\n\\nsandbox setup\\n  codex mcp add …");\n`,
  );
  const upgrade = (extra = {}) => {
    rmSync(calls, { force: true });
    const result = spawnSync("node", [CLI, "upgrade"], { cwd: root, env: { ...env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, ...extra }, encoding: "utf8" });
    return { code: result.status, out: result.stdout + result.stderr, calls: readFileSync(calls, "utf8").trimEnd().split("\n") };
  };

  const view = "npm view claude-codex-pair version";
  const install = "npm install --global claude-codex-pair@latest";
  const fresh = upgrade();
  assert.equal(fresh.code, 0, fresh.out);
  assert.deepEqual(fresh.calls, [view, install], "no init where pair isn't set up");
  assert.match(fresh.out, /upgraded: claude-codex-pair \S+ → 99\.0\.0\. Restart Claude Code and Codex sessions/);

  ok(["init"]);
  const upgraded = upgrade();
  assert.deepEqual(upgraded.calls, [view, install, "npm root --global", "new pair init"], "the init of the package just installed, not an older pair earlier on PATH");
  assert.match(upgraded.out, /^wrote: \/x\/SKILL\.md\nkept: \/x\/AGENTS\.md \(pair section\) \(current\)\nupgraded: /m);
  assert.doesNotMatch(upgraded.out, /channel: c|sandbox setup|codex mcp add/, "only what init did to the files");

  const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;
  const current = upgrade({ NPM_LATEST: version });
  assert.equal(current.code, 0, current.out);
  assert.deepEqual(current.calls, [view], "nothing to install");
  assert.equal(current.out, `already up to date: claude-codex-pair ${version}\n`);
  const skillPath = join(root, ".claude", "skills", "pair", "SKILL.md");
  writeFileSync(skillPath, "old skill\n");
  if (process.getuid?.() !== 0) {
    chmodSync(skillPath, 0o444);
    const unwritable = upgrade({ NPM_LATEST: version });
    chmodSync(skillPath, 0o644);
    assert.equal(unwritable.code, 1, unwritable.out);
    assert.match(unwritable.out, /^pair: already up to date, but couldn't refresh instructions \(EACCES/);
  }
  assert.match(upgrade({ NPM_LATEST: version }).out, /^already up to date: .*\npair: refreshed .*SKILL\.md/, "but still refreshes this worktree");

  const offline = upgrade({ NPM_VIEW_EXIT: "1" });
  assert.deepEqual(offline.calls.slice(0, 2), [view, install], "a failed version check leaves it to the install");
  assert.match(offline.out, /→ latest\./);
  const failed = upgrade({ NPM_EXIT: "3" });
  assert.equal(failed.code, 3);
  assert.deepEqual(failed.calls, [view, install], "no init after a failed install");
});
