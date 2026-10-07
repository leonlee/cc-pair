import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const CLI = join(import.meta.dirname, "..", "dist", "pair.js");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "pair-test-"));
  const env = { ...process.env, PAIR_HOME: join(root, "home"), PAIR_AGENT: "" };
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

test("full review loop: request, changes, response, approve", () => {
  const { run, ok } = sandbox();
  ok(["send", "request", "--as", "claude", "-"], "## Summary\nadded parse()");

  assert.equal(run(["wait", "--as", "claude", "--timeout", "1"]).code, 2, "author has nothing to read yet");
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
