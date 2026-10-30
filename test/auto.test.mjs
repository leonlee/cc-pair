import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { autoCall } from "../dist/auto.js";

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "pair.js");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(40);
  }
  assert.fail(`timed out: ${label}`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function fixture(t, { author = "claude", scenario = "roundtrip", worker = "normal", timeout = 5, clockJumps = false, denySocket = false, reviewerModel, reviewerEffort, authorArgs = [], reviewerArgs, worktree, remoteBranch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pair-auto-test-"));
  const socketDir = mkdtempSync("/tmp/pair-at-");
  const fake = join(root, "fake-agent");
  const env = {
    ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AGENT: "", PAIR_AUTO_ROLE: "", PAIR_AUTO_RUN: "",
    PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_NO_UPDATE_CHECK: "1",
    TEST_ROOT: root, TEST_SCENARIO: scenario, TEST_WORKER: worker,
    PAIR_AUTO_SOCKET_DIR: socketDir,
  };
  if (clockJumps || denySocket) {
    const hook = join(root, "faults.cjs");
    writeFileSync(hook, [
      clockJumps ? `if (process.argv.includes('_auto-guardian')) { const now = Date.now; let jumps = 0; Date.now = () => now() + (++jumps * 60000); }` : "",
      denySocket ? `if (process.env.PAIR_AUTO_ROLE === 'author' && process.argv.includes('send')) { const net = require('node:net'); net.Socket.prototype.connect = function () { queueMicrotask(() => this.destroy(Object.assign(new Error('connect EPERM'), {code:'EPERM'}))); return this; }; }` : "",
    ].join("\n"));
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require=${hook}`;
  }
  writeFileSync(fake, `#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const exec = promisify(execFile);
const root = process.env.TEST_ROOT;
const write = (name, value) => writeFileSync(join(root, name), String(value));
const call = (args, input = '') => new Promise((resolve, reject) => {
  const child = execFile('pair', args, {env: process.env}, (error, stdout, stderr) => {
    if (error) { error.output = stdout + stderr; reject(error); } else resolve(stdout + stderr);
  });
  child.stdin.end(input);
});
const reviewer = process.env.PAIR_AUTO_ROLE === 'reviewer';
write(reviewer ? 'worker.pid' : 'author.pid', process.pid);
if (reviewer) {
  let calls = [];
  try { calls = JSON.parse(readFileSync(join(root, 'calls.json'), 'utf8')); } catch {}
  calls.push({args:process.argv.slice(2), agent:process.env.PAIR_AGENT, cwd:process.cwd()});
  write('calls.json', JSON.stringify(calls));
  const count = calls.length;
  const session = '11111111-1111-4111-8111-' + String(count).padStart(12, '0');
  // Corrupt the lane before announcing the session, so recording the session must not read the lane.
  if (process.env.TEST_WORKER === 'corrupt') writeFileSync(join(dirname(process.env.PAIR_AUTO_MESSAGE), '002-review.md'), '---\\nfrom: nobody\\n---\\njunk\\n');
  console.log(JSON.stringify(process.env.PAIR_AGENT === 'codex' ? {type:'thread.started', thread_id:session} : {type:'system',subtype:'init',session_id:session}));
  if (process.env.TEST_WORKER === 'hang' || process.env.TEST_WORKER === 'leaky') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'inherit'});
    write('descendant.pid', child.pid);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (process.env.TEST_WORKER === 'hang') {
      process.on('SIGTERM', () => {});
      setInterval(()=>{},1000);
    }
  }
  if (process.env.TEST_WORKER === 'model-error' || process.env.TEST_WORKER === 'noisy') {
    const line = JSON.stringify(process.env.TEST_WORKER === 'noisy' ? {type:'error', message:'stream hiccup, retrying'}
      : process.env.PAIR_AGENT === 'claude' ? {type:'result', subtype:'error_during_execution', is_error:true, errors:['No conversation found with session ID: x', 7, ' ']}
      : {type:'turn.failed', error:{message:"The 'X' model is not supported\u001b[31m" + 'a'.repeat(5000)}});
    process.stdout.write(line.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A pipe write can still be pending at process.exit.
    await new Promise((resolve) => process.stdout.write(line.slice(20) + '\\n' + JSON.stringify({type:'error', message:42}) + '\\n', resolve));
    if (process.env.TEST_WORKER === 'model-error') process.exit(1);
  }
  if (process.env.TEST_WORKER !== 'hang') {
    if (process.env.TEST_WORKER === 'failfirst' && count === 1) process.exit(2);
    if (process.env.TEST_WORKER === 'no-verdict') process.exit(0);
    if (process.env.TEST_WORKER === 'corrupt') process.exit(0);
    const message = await call(['wait','--as',process.env.PAIR_AGENT,'--timeout','1']);
    const verdict = count === 1 && process.env.TEST_SCENARIO === 'roundtrip' ? 'changes' : 'approve';
    await call(['send','review','--as',process.env.PAIR_AGENT,'--verdict',verdict,'-'], verdict === 'changes' ? '### F1 [medium] fix this' : 'Approved');
    if (process.env.TEST_WORKER === 'leaky') process.exit(0);
  }
} else {
  write('author.args.json', JSON.stringify(process.argv.slice(2)));
  write('author.cwd', process.cwd());
  write('author.bin', process.env.PAIR_BIN);
  if (process.env.TEST_SCENARIO === 'hold') setInterval(()=>{},1000);
  else {
    const stateBase = join(process.env.XDG_STATE_HOME, 'pair');
    const lockState = (mode) => { if (process.env.TEST_SCENARIO === 'readonly-state') chmodSync(join(stateBase, readdirSync(stateBase)[0]), mode); };
    lockState(0o500);
    try {
      const first = await call(['send','request','--as',process.env.PAIR_AGENT,'-'], '## Summary\\nTest change\\n## Files\\na.ts');
      lockState(0o700);
      write('first.out', first);
      if (process.env.TEST_SCENARIO === 'roundtrip') {
        write('second.out', await call(['send','response','--as',process.env.PAIR_AGENT,'-'], '### F1 fixed'));
        write('third.out', await call(['send','request','--as',process.env.PAIR_AGENT,'-'], 'Another task'));
      }
    } catch (error) {
      lockState(0o700);
      write('first.error', error.output || error.message);
      if (process.env.TEST_SCENARIO === 'retry') write('retry.out', await call(['wait','--as',process.env.PAIR_AGENT,'--timeout','1']));
    }
    if (process.env.TEST_SCENARIO === 'review') setInterval(()=>{},1000);
  }
}
`);
  chmodSync(fake, 0o700);
  const overrides = [
    ...(reviewerModel === undefined ? [] : ["--reviewer-model", reviewerModel]),
    ...(reviewerEffort === undefined ? [] : ["--reviewer-effort", reviewerEffort]),
    ...(reviewerArgs === undefined ? [] : [`--reviewer-args=${reviewerArgs}`]),
    ...(worktree === undefined ? [] : ["--worktree", worktree]),
    ...(authorArgs.length ? ["--", ...authorArgs] : []),
  ];
  if (worktree !== undefined) {
    const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root }).status, 0);
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    if (remoteBranch) {
      // The branch exists only on origin, one commit ahead of HEAD.
      git("clone", "-q", "--bare", ".", "origin.git");
      git("remote", "add", "origin", join(root, "origin.git"));
      git("commit", "-q", "--allow-empty", "-m", "remote work");
      git("push", "-q", "origin", `HEAD:refs/heads/${worktree}`);
      git("fetch", "-q", "origin");
      git("reset", "-q", "--hard", "HEAD~1");
      git("tag", worktree); // a same-name tag at the old commit must not be checked out instead
    }
    assert.equal(spawnSync(process.execPath, [CLI, "init"], { cwd: root, env }).status, 0);
  }
  const launcher = spawn(process.execPath, [CLI, "start", "--as", author, "--claude", fake, "--codex", fake, "--timeout", String(timeout), "--grace", "0.15", ...overrides], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  launcher.stdout.on("data", (data) => { output += data; });
  launcher.stderr.on("data", (data) => { output += data; });
  const completed = new Promise((resolve) => launcher.once("close", (code, signal) => resolve({ code, signal })));
  const file = (name) => join(root, name);
  const read = (name) => readFileSync(file(name), "utf8");
  const command = (args) => exec(process.execPath, [CLI, ...args], { cwd: root, env, timeout: 10_000 });
  t.after(async () => {
    try {
      if (launcher.exitCode === null && launcher.signalCode === null) { launcher.kill("SIGCONT"); launcher.kill("SIGTERM"); }
      const ended = await Promise.race([completed.then(() => true), pause(7000).then(() => false)]);
      if (!ended) { launcher.kill("SIGKILL"); await completed; }
      for (const name of ["worker.pid", "descendant.pid", "author.pid"]) {
        if (existsSync(file(name))) {
          const pid = Number(read(name));
          if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
        }
      }
      await until(() => readdirSync(socketDir).length === 0, `test socket cleanup; launcher output: ${output}`, 7000);
      assert.ok(ended, "launcher must finish before deleting test state");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(socketDir, { recursive: true, force: true });
      if (worktree !== undefined) rmSync(`${root}-${worktree.replaceAll("/", "-")}`, { recursive: true, force: true });
    }
  });
  const stateDir = () => join(root, "state", "pair", readdirSync(join(root, "state", "pair"))[0]);
  const state = () => JSON.parse(readFileSync(join(stateDir(), "auto.json"), "utf8"));
  const call = (request, timeout) => {
    const previous = process.env.PAIR_AUTO_SOCKET_DIR;
    process.env.PAIR_AUTO_SOCKET_DIR = socketDir;
    try { return autoCall(stateDir(), request, timeout); }
    finally {
      if (previous === undefined) delete process.env.PAIR_AUTO_SOCKET_DIR;
      else process.env.PAIR_AUTO_SOCKET_DIR = previous;
    }
  };
  return { root, socketDir, env, fake, launcher, completed, file, read, command, stateDir, state, call, output: () => output };
}

for (const author of ["claude", "codex"]) {
  test(`auto ${author}: changes, resume, approve, new thread`, { timeout: 15_000 }, async (t) => {
    const f = fixture(t, { author });
    assert.equal((await f.completed).code, 0, f.output());
    assert.match(f.read("first.out"), /verdict changes/);
    assert.match(f.read("second.out"), /verdict approve/);
    assert.match(f.read("third.out"), /verdict approve/);
    const calls = JSON.parse(f.read("calls.json"));
    assert.equal(calls.length, 3);
    for (const { args } of calls) {
      assert.ok(!args.includes("--model"), "omitted model must inherit CLI defaults");
      assert.ok(!args.includes("--effort") && !args.includes("--config"), "omitted effort must inherit CLI defaults");
    }
    const resume = author === "claude" ? "resume" : "--resume";
    assert.ok(calls[1].args.includes(resume));
    assert.equal(calls[1].args[calls[1].args.indexOf(resume) + 1], "11111111-1111-4111-8111-000000000001");
    assert.ok(!calls[2].args.includes(resume));
    assert.match((await f.command(["history"])).stdout, /approved/);
    assert.match((await f.command(["status"])).stdout, /auto mode: stopped/);
  });

  test(`auto ${author}: reviewer overrides persist through resume without changing author arguments`, { timeout: 15_000 }, async (t) => {
    const reviewerModel = `fixture-${author === "claude" ? "codex" : "claude"}-model`;
    const f = fixture(t, { author, reviewerModel, reviewerEffort: "high" });
    assert.equal((await f.completed).code, 0, f.output());
    const calls = JSON.parse(f.read("calls.json"));
    assert.equal(calls.length, 3);
    for (const { args } of calls) {
      assert.equal(args[args.indexOf("--model") + 1], reviewerModel);
      if (author === "claude") {
        assert.equal(args[args.indexOf("--config") + 1], 'model_reasoning_effort="high"');
        assert.ok(args.indexOf("--model") > args.indexOf("exec"), "Codex model belongs to the exec command");
        assert.ok(args.indexOf("--config") > args.indexOf("exec"));
        if (args.includes("resume")) assert.ok(args.indexOf("--model") > args.indexOf("resume"), "resume gets its own explicit model override");
      } else {
        assert.equal(args[args.indexOf("--effort") + 1], "high");
      }
    }
    assert.ok(calls[1].args.includes(author === "claude" ? "resume" : "--resume"));
    const authorArgs = JSON.parse(f.read("author.args.json"));
    assert.ok(!authorArgs.includes("--model") && !authorArgs.includes("--effort") && !authorArgs.includes("--config"));
  });

  test(`auto ${author}: author arguments after -- and --reviewer-args each reach only their agent`, { timeout: 15_000 }, async (t) => {
    const passed = ["--model", "fixture-author-model", "--add-dir", "../shared"];
    const reviewerArgs = author === "claude" ? ["-c", "model_verbosity=low"] : ["--fallback-model", "fixture-fallback"];
    const f = fixture(t, { author, authorArgs: passed, reviewerArgs: reviewerArgs.join(" ") });
    assert.equal((await f.completed).code, 0, f.output());
    const args = JSON.parse(f.read("author.args.json"));
    assert.deepEqual(args.slice(0, passed.length), passed);
    assert.ok(!args.includes(reviewerArgs[1]), "the author doesn't get reviewer arguments");
    if (author === "codex") assert.equal(args.at(-2), "--", "the prompt follows -- so a multi-value option can't take it");
    const calls = JSON.parse(f.read("calls.json"));
    assert.ok(calls.some(({ args }) => args.includes(author === "claude" ? "resume" : "--resume")), "a resumed round is covered");
    for (const call of calls) {
      assert.ok(!call.args.includes("fixture-author-model"), "the reviewer doesn't get author arguments");
      const at = call.args.indexOf(reviewerArgs[0]);
      assert.deepEqual(call.args.slice(at, at + 2), reviewerArgs);
      assert.ok(at < call.args.indexOf(author === "claude" ? "--json" : "-p"));
      if (author === "claude") assert.ok(at > call.args.indexOf(call.args.includes("resume") ? "resume" : "exec"), "codex options follow exec (resume)");
    }
  });
}

test("status reports requested reviewer overrides and labels inherited settings", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { author: "codex", scenario: "hold", reviewerModel: "opus", reviewerEffort: "high" });
  await until(() => existsSync(f.file("author.pid")), "author started");
  const status = (await f.command(["status"])).stdout;
  assert.match(status, /reviewer model override: opus/);
  assert.match(status, /reviewer effort override: high/);
  assert.match(status, /author session: unknown \(pair can't learn a Codex session's ID\)/);
  assert.equal(f.state().reviewerModel, "opus");
  assert.equal(f.state().reviewerEffort, "high");
  await f.command(["stop"]);

  const defaults = fixture(t, { scenario: "hold" });
  await until(() => existsSync(defaults.file("author.pid")), "default author started");
  const inherited = (await defaults.command(["status"])).stdout;
  assert.match(inherited, /reviewer model override: CLI default/);
  assert.match(inherited, /reviewer effort override: CLI default/);
  await defaults.command(["stop"]);
});

for (const overrides of [{ reviewerModel: "fixture-model" }, { reviewerEffort: "xhigh" }]) {
  test(`reviewer ${Object.keys(overrides)[0]} can be set independently`, { timeout: 15_000 }, async (t) => {
    const f = fixture(t, { ...overrides, scenario: "retry" });
    assert.equal((await f.completed).code, 0, f.output());
    const [{ args }] = JSON.parse(f.read("calls.json"));
    assert.equal(args.includes("--model"), overrides.reviewerModel !== undefined);
    assert.equal(args.includes("--config"), overrides.reviewerEffort !== undefined);
    assert.match(f.read("first.out"), /verdict approve/);
  });
}

for (const options of [
  { reviewerModel: "" },
  { reviewerModel: " padded-model " },
  { reviewerModel: "model\nname" },
  { reviewerEffort: "higgh" },
  { reviewerEffort: "" },
  { author: "codex", reviewerEffort: "none" },
]) {
  test(`invalid reviewer override fails before agent startup: ${JSON.stringify(options)}`, { timeout: 10_000 }, async (t) => {
    const f = fixture(t, { scenario: "hold", ...options });
    assert.equal((await f.completed).code, 1);
    assert.match(f.output(), /--reviewer-(?:model|effort)/);
    assert.ok(!existsSync(f.file("author.pid")), "invalid overrides must not launch an author");
    assert.deepEqual(readdirSync(f.socketDir), [], "invalid overrides must not claim a socket");
  });
}

test("auto stop cleans an ignoring reviewer and its descendant", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang" });
  await until(() => existsSync(f.file("descendant.pid")), "worker started");
  const pids = ["author.pid", "worker.pid", "descendant.pid"].map((name) => Number(f.read(name)));
  const status = (await f.command(["status"])).stdout;
  assert.match(status, /reviewing/);
  assert.match(status, /reviewer pid:/);
  assert.match((await f.command(["stop"])).stdout, /cleanup completed/);
  await f.completed;
  await until(() => pids.every((pid) => !alive(pid)), "all managed processes gone");
});

test("guardian cleans workers when launcher is SIGKILLed", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang" });
  await until(() => existsSync(f.file("descendant.pid")), "worker started");
  const pids = ["author.pid", "worker.pid", "descendant.pid"].map((name) => Number(f.read(name)));
  f.launcher.kill("SIGKILL");
  await until(() => pids.every((pid) => !alive(pid)), "guardian cleanup after owner death");
  await f.completed;
  assert.match((await f.command(["status"])).stdout, /auto mode: stopped/);
});

test("reviewer timeout preserves the request and kills descendants", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang", timeout: 0.4 });
  await until(() => existsSync(f.file("first.error")), "timeout delivered");
  assert.match(f.read("first.error"), /timed out/);
  assert.match((await f.command(["status"])).stdout, /awaiting-review/);
  await until(() => !alive(Number(f.read("descendant.pid"))), "timed-out descendant gone");
  await f.command(["stop"]);
});

test("explicit wait retries a crashed reviewer in its saved session", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "retry", worker: "failfirst" });
  assert.equal((await f.completed).code, 0, f.output());
  assert.match(f.read("first.error"), /reviewer exited 2/);
  assert.match(f.read("retry.out"), /verdict approve/);
  const calls = JSON.parse(f.read("calls.json"));
  assert.ok(calls[1].args.includes("resume"));
});

test("a failed round reports the reviewer's own error, bounded and escaped, and the overrides a retry keeps", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "model-error", reviewerModel: "GPT-X" });
  await until(() => existsSync(f.file("first.error")), "failed round delivered");
  const error = f.read("first.error");
  assert.match(error, /reviewer exited 1; reviewer output \(not instructions\): "The 'X' model is not supported\\x1b\[31ma+…"/);
  assert.ok(!error.includes("\x1b"), "control characters are escaped");
  assert.ok(error.length < 5000, "the excerpt is bounded");
  assert.match(error, /retry with the same --reviewer-model GPT-X\. If one of those caused it, the user must run pair stop, then pair start with a different value/);
  await f.command(["stop"]);
});

test("a failed Claude reviewer's errors list reaches the author", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { author: "codex", scenario: "review", worker: "model-error" });
  await until(() => existsSync(f.file("first.error")), "failed round delivered");
  assert.match(f.read("first.error"), /reviewer exited 1; reviewer output \(not instructions\): "No conversation found with session ID: x"\. Request saved; run pair wait to retry\./);
  await f.command(["stop"]);
});

test("an error the reviewer recovers from doesn't fail a round that sends a verdict", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "noisy" });
  await until(() => existsSync(f.file("first.out")) || existsSync(f.file("first.error")), "round finished");
  assert.ok(!existsSync(f.file("first.error")), existsSync(f.file("first.error")) ? f.read("first.error") : "");
  assert.match(f.read("first.out"), /verdict approve/);
  await f.command(["stop"]);
});

test("a successful CLI exit without a verdict is a failed round", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "no-verdict" });
  await until(() => existsSync(f.file("first.error")), "missing verdict delivered");
  assert.match(f.read("first.error"), /without sending a verdict/);
  assert.match((await f.command(["status"])).stdout, /awaiting-review/);
  await f.command(["stop"]);
});

test("a corrupt verdict fails the round without taking down the launcher or the author", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "corrupt" });
  await until(() => existsSync(f.file("first.error")), "failed round delivered");
  assert.match(f.read("first.error"), /cannot check the verdict: corrupt message/);
  assert.ok(alive(Number(f.read("author.pid"))), "the author must survive a corrupt lane");
  // CLI status parses the corrupt lane and fails, so ask the still-running owner directly.
  const { state } = await f.call({ action: "status" });
  assert.equal(state.phase, "failed");
  assert.match(state.error, /cannot check the verdict/);
  assert.equal(state.session, "11111111-1111-4111-8111-000000000001", "the session is recorded without reading the corrupt lane");
  await f.command(["stop"]);
});

test("an unwritable state directory doesn't strand the review", { timeout: 15_000, skip: process.getuid?.() === 0 }, async (t) => {
  const f = fixture(t, { scenario: "readonly-state" });
  assert.equal((await f.completed).code, 0, f.output());
  assert.ok(!existsSync(f.file("first.error")), existsSync(f.file("first.error")) ? f.read("first.error") : "");
  assert.match(f.read("first.out"), /verdict approve/);
});

for (const author of ["claude", "codex"]) {
  test(`auto start --as ${author} refuses while a manual Codex session is registered`, () => {
    const root = mkdtempSync(join(tmpdir(), "pair-auto-reg-"));
    const env = { ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AGENT: "", PAIR_AUTO_ROLE: "", PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_NO_UPDATE_CHECK: "1" };
    const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
    try {
      assert.equal(run(["register"], { CODEX_THREAD_ID: "11111111-2222-4333-8444-555555555555" }).status, 0);
      const result = run(["start", "--as", author, "--claude", process.execPath, "--codex", process.execPath]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /a manual Codex session is registered here/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const remoteBranch of [false, true]) test(`auto start --worktree runs the whole round in a new worktree${remoteBranch ? ", tracking a remote-only branch" : ""}`, { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { worktree: "feat/x", remoteBranch });
  assert.equal((await f.completed).code, 0, f.output());
  const worktree = realpathSync(`${f.root}-feat-x`);
  const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "feat/x@{upstream}"], { cwd: worktree, encoding: "utf8" });
  assert.equal(upstream.stdout.trim(), remoteBranch ? "origin/feat/x" : "", "a remote-only branch is tracked, not recreated from HEAD");
  if (remoteBranch) {
    const commit = (cwd, ref) => spawnSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).stdout.trim();
    assert.equal(commit(worktree, "HEAD"), commit(f.root, "refs/remotes/origin/feat/x"), "the worktree has the remote's commit, not the tag's");
  }
  assert.match(f.output(), /this session runs in worktree .*-feat-x; run pair status and pair stop there/);
  assert.equal(realpathSync(f.read("author.cwd")), worktree);
  for (const call of JSON.parse(f.read("calls.json"))) assert.equal(realpathSync(call.cwd), worktree, "the reviewer runs in the author's worktree");
  assert.match(spawnSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).stdout, /^feat\/x$/m);
  assert.ok(existsSync(join(worktree, "AGENTS.md")), "pair init ran in the new worktree");
  assert.match(f.output(), /pair: wrote: .*AGENTS\.md/);
  assert.match(f.read("first.out"), /verdict changes/, "the review reached the author through the worktree's channel");
  const status = spawnSync(process.execPath, [CLI, "status"], { cwd: worktree, env: f.env, encoding: "utf8" }).stdout;
  const restart = /restart it: (.*)/.exec(status)?.[1] ?? "";
  assert.ok(restart.startsWith(`cd ${worktree} && pair start --as claude `), status);
  assert.doesNotMatch(restart, /--worktree/, "after cd, --worktree would name a second worktree");
});

test("pair ps lists a --worktree launcher under the worktree it runs", { timeout: 15_000, skip: spawnSync("ps", ["-p", String(process.pid)]).status !== 0 && "ps is blocked here" }, async (t) => {
  const f = fixture(t, { scenario: "hold", worktree: "feat" });
  await until(() => existsSync(f.file("author.pid")), "author started");
  const worktree = realpathSync(`${f.root}-feat`);
  const listing = (await f.command(["ps"])).stdout;
  const block = listing.split("\n\n").find((text) => text.includes(`start   ${f.launcher.pid} `));
  assert.ok(block?.startsWith(`${basename(worktree)}  `), listing);
  const stop = spawnSync(process.execPath, [CLI, "stop"], { cwd: worktree, env: f.env, encoding: "utf8" });
  assert.equal(stop.status, 0, stop.stderr);
});

test("auto start --worktree checks its input first, and reuses an existing worktree", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pair-auto-wt-")));
  const root = join(base, "repo");
  mkdirSync(root);
  const env = { ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AGENT: "", PAIR_AUTO_ROLE: "", PAIR_HOME: join(base, "home"), XDG_STATE_HOME: join(base, "state"), PAIR_NO_UPDATE_CHECK: "1" };
  const run = (cwd, args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  const start = (...args) => run(root, ["start", "--as", "claude", "--claude", process.execPath, "--codex", process.execPath, ...args]);
  try {
    assert.match(start("--worktree", "feat").stderr, /--worktree needs a git repository/);
    const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root }).status, 0);
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    for (const name of ["-x", "@{-1}", "a..b", "x.lock", "a b"]) {
      assert.match(start(`--worktree=${name}`).stderr, /is not a usable branch name/, name);
    }
    // Bad options, executables and socket settings fail before anything is created.
    const absent = (what) => {
      assert.ok(!existsSync(join(base, "repo-feat")), what);
      assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/feat"], { cwd: root }).status, 1, what);
    };
    assert.match(start("--worktree", "feat", "--reviewer-effort", "bogus").stderr, /--reviewer-effort for codex must be one of/);
    absent("bad effort");
    assert.match(start("--worktree", "feat", "--claude", join(base, "missing-claude")).stderr, /claude executable not found/);
    absent("bad executable");
    assert.match(run(root, ["start", "--as", "claude", "--claude", process.execPath, "--codex", process.execPath, "--worktree", "feat"], { PAIR_AUTO_SOCKET_DIR: "relative" }).stderr, /PAIR_AUTO_SOCKET_DIR must be an absolute path/);
    absent("bad socket directory");
    // A reused worktree must be on NAME: fix/one and fix-one share a path, and a worktree can be switched.
    git("worktree", "add", "-q", "-b", "fix/one", join(base, "repo-fix-one"));
    assert.match(start("--worktree", "fix-one").stderr, /repo-fix-one has branch fix\/one checked out, not fix-one/);
    assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/fix-one"], { cwd: root }).status, 1);
    assert.equal(spawnSync("git", ["checkout", "-q", "--detach"], { cwd: join(base, "repo-fix-one") }).status, 0);
    assert.match(start("--worktree", "fix/one").stderr, /repo-fix-one has a detached HEAD checked out, not fix\/one/);
    // A branch on several remotes needs checkout.defaultRemote; nothing is created without it.
    for (const remote of ["r1", "r2"]) {
      assert.equal(spawnSync("git", ["init", "-q", "--bare", join(base, `${remote}.git`)]).status, 0);
      git("remote", "add", remote, join(base, `${remote}.git`));
      git("push", "-q", remote, "HEAD:refs/heads/dup");
    }
    git("fetch", "-q", "--all");
    assert.match(start("--worktree", "dup").stderr, /branch dup exists on several remotes \(r1, r2\); set checkout\.defaultRemote/);
    assert.ok(!existsSync(join(base, "repo-dup")));
    mkdirSync(join(base, "repo-plain"));
    assert.match(start("--worktree", "plain").stderr, /repo-plain already exists and isn't a worktree of this repository/);
    assert.match(run(root, ["status", "--worktree", "feat"]).stderr, /--worktree is only supported by pair start/);
    // An existing worktree is reused, and start then checks that worktree's channel, not this one's.
    // A tag with the branch's name must not make pair misread the branch (git's short form is heads/feat).
    git("worktree", "add", "-q", "-b", "feat", join(base, "repo-feat"));
    git("tag", "feat");
    assert.equal(run(root, ["init"]).status, 0); // so the reused worktree, created by plain git, gets pair init too
    assert.equal(run(join(base, "repo-feat"), ["register"], { CODEX_THREAD_ID: "11111111-2222-4333-8444-555555555555" }).status, 0);
    const reused = start("--worktree", "feat");
    assert.equal(reused.status, 1);
    assert.match(reused.stderr, /pair: wrote: .*repo-feat\/AGENTS\.md[\s\S]*this session runs in worktree .*repo-feat; run pair status and pair stop there\n[\s\S]*a manual Codex session is registered here/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("auto start refuses agent arguments outside its allowlists", () => {
  const root = mkdtempSync(join(tmpdir(), "pair-auto-args-"));
  const env = { ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AGENT: "", PAIR_AUTO_ROLE: "", PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_NO_UPDATE_CHECK: "1" };
  const start = (...args) => spawnSync(process.execPath, [CLI, "start", "--claude", process.execPath, "--codex", process.execPath, ...args], { cwd: root, env, encoding: "utf8" });
  try {
    const refused = (name, agent) => new RegExp(`can't pass "${name}" to the ${agent}`);
    for (const [args, message] of [
      [["--as", "claude", "stray"], /takes no arguments of its own/],
      // Print and background modes, settings that replace pair's, directory switches, and a second terminator.
      ...["-p", "--print", "--output-format", "--settings=x.json", "--bg", "--background", "--desktop", "-w", "--worktree", "--"]
        .map((arg) => [["--as", "claude", "--", "--model", "opus", arg], refused(arg.split("=")[0], "claude author")]),
      // Subcommands even after an option's value, prompts, and directory switches.
      [["--as", "codex", "--", "exec"], /can't pass "exec" to the codex author: only options/],
      [["--as", "codex", "--", "--model", "m", "exec", "--help"], /can't pass "exec" to the codex author: only options/],
      [["--as", "codex", "--", "--search", "fix the bug"], /can't pass "fix the bug"/],
      ...["-C", "--cd", "--worktree", "--remote"].map((arg) => [["--as", "codex", "--", arg, "/elsewhere"], refused(arg, "codex author")]),
      [["--as", "claude", "--", "--add-dir", "a", "b"], /can't pass "b"/],
      [["--as", "codex", "--", "--model"], /--model for the codex author needs a value/],
      [["--as", "claude", "--", "--model="], /--model for the claude author needs a value/],
      [["--as", "codex", "--", "--search=yes"], /--search for the codex author takes no value/],
      // pair records the author's session only when it can know it, so it refuses to guess between selectors.
      [["--as", "claude", "--", "-c", "--resume", "x"], /at most one of --continue and --resume/],
      [["--as", "claude", "--", "-r", "a", "--resume=b"], /at most one of --continue and --resume/],
      [["--as", "claude", "--", "--fork-session"], /--fork-session for the claude author needs --resume or --continue/],
      // A reviewer gets nothing that changes its tools, permissions or sandbox.
      [["--as", "claude", "--reviewer-args=-c sandbox_mode=danger-full-access"], /-c for the codex reviewer must match/],
      [["--as", "claude", "--reviewer-args=--dangerously-bypass-approvals-and-sandbox"], refused("--dangerously-bypass-approvals-and-sandbox", "codex reviewer")],
      [["--as", "claude", "--reviewer-args=-c model_reasoning_effort=high"], /-c for the codex reviewer must match/],
      ...["--dangerously-skip-permissions", "--permission-mode", "--allowedTools", "--settings", "--plugin-dir", "--mcp-config"]
        .map((arg) => [["--as", "codex", `--reviewer-args=${arg} x`], refused(arg, "claude reviewer")]),
    ]) {
      const result = start(...args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful reviewer cleanup also terminates leftover tool processes", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "retry", worker: "leaky" });
  assert.equal((await f.completed).code, 0, f.output());
  await until(() => !alive(Number(f.read("descendant.pid"))), "leftover tool gone");
});

test("a second launcher cannot take over a live worktree", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold" });
  await until(() => existsSync(f.file("author.pid")), "author started");
  await assert.rejects(f.command(["start", "--as", "codex", "--claude", f.fake, "--codex", f.fake]), /cannot own auto mode socket/);
  assert.ok(alive(Number(f.read("author.pid"))));
  await f.command(["stop"]);
});

test("Ctrl+C stops a running review and its tools", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang" });
  await until(() => existsSync(f.file("descendant.pid")), "worker started");
  f.launcher.kill("SIGINT");
  await f.completed;
  await until(() => !alive(Number(f.read("worker.pid"))) && !alive(Number(f.read("descendant.pid"))), "interrupt cleanup");
});

test("reset refuses an active auto review, then clears it after stop", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang" });
  await until(() => existsSync(f.file("worker.pid")), "reviewer started");
  assert.match((await f.command(["reset", "--dry-run"])).stdout, /would reset/);
  await assert.rejects(f.command(["stop", "--dry-run"]), /--dry-run is only supported by pair reset/);
  await assert.rejects(f.command(["reset"]), /Run pair stop first/);
  assert.ok(alive(Number(f.read("worker.pid"))));
  assert.match((await f.command(["status"])).stdout, /awaiting-review/);
  await f.command(["stop"]);
  assert.match((await f.command(["reset"])).stdout, /saved pending requests:/);
  const status = (await f.command(["status"])).stdout;
  assert.match(status, /claude-to-codex: idle/);
  assert.match(status, /codex-to-claude: idle/);
});

test("auto start rejects nested launches from agent shells", () => {
  const result = spawnSync(process.execPath, [CLI, "start", "--as", "claude"], {
    env: { ...process.env, CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", PAIR_NO_UPDATE_CHECK: "1" }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside Claude or Codex/);
});

test("a reviewer spawn failure preserves the pending request", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold" });
  await until(() => existsSync(f.file("author.pid")), "author started");
  // Supply a body without relying on the interactive author's stdin.
  writeFileSync(f.file("request.md"), "Review a.ts");
  const sent = (await f.command(["send", "request", "--as", "claude", f.file("request.md")])).stdout.trim().replace("sent: ", "");
  rmSync(f.fake);
  await assert.rejects(f.call({ action: "review", run: f.state().run, file: sent }, 10_000), /ENOENT/);
  assert.match((await f.command(["status"])).stdout, /awaiting-review/);
  await f.command(["stop"]);
});

test("duplicate dispatches share one running reviewer", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang" });
  await until(() => existsSync(f.file("worker.pid")), "reviewer started");
  const state = f.state();
  const home = join(f.env.PAIR_HOME, readdirSync(f.env.PAIR_HOME)[0], "claude-to-codex");
  const file = join(home, readdirSync(home)[0], "001-request.md");
  const duplicate = f.call({ action: "review", run: state.run, file }, 10_000).catch((error) => error);
  await pause(150);
  assert.equal(JSON.parse(f.read("calls.json")).length, 1);
  await f.command(["stop"]);
  assert.ok(await duplicate instanceof Error);
});

test("launcher emergency cleanup handles a killed guardian", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang" });
  await until(() => existsSync(f.file("descendant.pid")), "worker started");
  const pids = ["author.pid", "worker.pid", "descendant.pid"].map((name) => Number(f.read(name)));
  process.kill(f.state().guardianPid, "SIGKILL");
  await f.completed;
  await until(() => pids.every((pid) => !alive(pid)), "emergency cleanup");
});

test("heartbeat expiry cleans a hung launcher's workers", { timeout: 20_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang", timeout: 15 });
  await until(() => existsSync(f.file("descendant.pid")), "worker started");
  const pids = ["author.pid", "worker.pid", "descendant.pid"].map((name) => Number(f.read(name)));
  f.launcher.kill("SIGSTOP");
  try { await until(() => pids.every((pid) => !alive(pid)), "heartbeat cleanup", 10_000); }
  finally { f.launcher.kill("SIGCONT"); }
  await f.completed;
});

test("standard help describes auto mode", () => {
  const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pair start --as/);
  assert.match(result.stdout, /pair stop/);
  assert.match(result.stdout, /--reviewer-model MODEL/);
  assert.match(result.stdout, /--reviewer-effort LEVEL/);
});

test("guardian heartbeat ignores forward wall-clock jumps", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold", clockJumps: true });
  await until(() => existsSync(f.file("author.pid")), "author started");
  await pause(2200); // Several watchdog ticks while Date.now() jumps by a minute on every call.
  assert.ok(alive(Number(f.read("author.pid"))), "wall-clock changes must not terminate the author");
  await f.command(["stop"]);
});

test("Claude author gets one canonical socket allow rule and persistent instructions", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold" });
  await until(() => existsSync(f.file("author.args.json")), "author started");
  const args = JSON.parse(f.read("author.args.json"));
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  const allowed = settings.sandbox.network.allowUnixSockets;
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0], join(realpathSync(f.socketDir), readdirSync(f.socketDir)[0]));
  assert.ok(args.includes("--append-system-prompt"));
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /run_in_background: true/);
  await f.command(["stop"]);
});

const NEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a new Claude author gets an ID that pair start, status and stop report, with a restart command", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold", reviewerModel: "m1", authorArgs: ["--model", "opus"] });
  await until(() => existsSync(f.file("author.args.json")), "author started");
  const args = JSON.parse(f.read("author.args.json"));
  const id = args[args.indexOf("--session-id") + 1];
  assert.match(id, NEW_ID);
  assert.match(f.output(), new RegExp(`pair: start auto mode in .*\npair:   author claude · session ${id} \\(new\\)\npair:   reviewer codex · model m1 · effort CLI default\n`));
  assert.match((await f.command(["status"])).stdout, new RegExp(`author session: ${id} \\(new\\)`));
  const stopped = (await f.command(["stop"])).stdout;
  assert.match(stopped, new RegExp(`last author session: ${id} \\(picked by pair, .*; pair doesn't check that it still exists\\)`));
  assert.equal(/restart it: (.*)/.exec(stopped)?.[1], `cd ${realpathSync(f.root)} && pair start --as claude --claude ${f.fake} --codex ${f.fake} --reviewer-model m1 --timeout 5 --grace 0.15 -- --model opus --resume ${id}`);
  await f.completed;
  assert.match((await f.command(["status"])).stdout, new RegExp(`auto mode: stopped\n  last author session: ${id}`), "the record outlives the run");
});

test("a resumed Claude author keeps the ID it was given, and its prompts never name a run's path", { timeout: 15_000 }, async (t) => {
  const id = "26ec38ba-37d4-41b2-9016-d8885231d54a";
  const f = fixture(t, { scenario: "hold", authorArgs: [`--resume=${id}`, "-n", "fix"] });
  await until(() => existsSync(f.file("author.args.json")), "author started");
  const args = JSON.parse(f.read("author.args.json"));
  assert.ok(args.includes(`--resume=${id}`) && !args.includes("--session-id"), "a resumed conversation keeps its own ID");
  // Claude reuses a resumed conversation's recorded system prompt, so it can't name this run's wrapper. The new
  // user turn on each launch points a conversation recorded by an older pair at the current one; this checks
  // that pair sends it, not that the model follows it.
  const prompt = args[args.indexOf("--append-system-prompt") + 1];
  assert.match(prompt, /The pair CLI is "\$PAIR_BIN"/);
  assert.match(args.at(-1), /Run pair as "\$PAIR_BIN" in this launch; an absolute .*bin\/pair path from an earlier launch no longer exists/);
  for (const text of [prompt, args.at(-1)]) assert.ok(!text.includes(f.stateDir()), "no run-specific path");
  assert.ok(existsSync(f.read("author.bin")), "PAIR_BIN names this run's live wrapper");
  assert.match((await f.command(["status"])).stdout, new RegExp(`author session: ${id} \\(resumed\\)`));
  assert.match((await f.command(["stop"])).stdout, new RegExp(` -- -n fix --resume ${id}$`, "m"));
});

test("pair doesn't name a --continue author's conversation", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold", authorArgs: ["-c"] });
  await until(() => existsSync(f.file("author.args.json")), "author started");
  const args = JSON.parse(f.read("author.args.json"));
  assert.ok(args.includes("-c") && !args.includes("--session-id"));
  assert.match((await f.command(["status"])).stdout, /author session: unknown \(--continue: Claude's newest conversation in this worktree\)/);
  const stopped = (await f.command(["stop"])).stdout;
  assert.match(stopped, /last author session: unknown \(--continue/);
  assert.doesNotMatch(stopped, /restart it/);
});

test("denied control-socket access names Claude's required setting and preserves the request", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", denySocket: true });
  await until(() => existsSync(f.file("first.error")), "connection denial delivered");
  assert.match(f.read("first.error"), /sandbox.network.allowUnixSockets/);
  assert.match(f.read("first.error"), /The request remains on disk/);
  assert.match(f.read("first.error"), new RegExp(realpathSync(f.socketDir)));
  assert.match((await f.command(["status"])).stdout, /awaiting-review/);
  assert.ok(!existsSync(f.file("calls.json")), "denied dispatch must not start a reviewer");
  await f.command(["stop"]);
});

for (const killed of ["author", "launcher"]) {
  test(`tty state is restored after ${killed} SIGKILL`, {
    timeout: 15_000,
    skip: spawnSync("python3", ["--version"]).status !== 0 && "Python is needed for the PTY harness",
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "pair-tty-test-"));
    const socketDir = mkdtempSync("/tmp/pair-at-");
    const fake = join(root, "fake-agent");
    writeFileSync(fake, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.TEST_ROOT + '/author.pid', String(process.pid));\nprocess.stdin.setRawMode(true);\nconsole.log('TTY_READY');\nsetInterval(() => {}, 1000);\n`);
    chmodSync(fake, 0o700);
    const env = {
      ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AUTO_ROLE: "", PAIR_AUTO_RUN: "", TEST_ROOT: root,
      PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_AUTO_SOCKET_DIR: socketDir, PAIR_NO_UPDATE_CHECK: "1",
    };
    try {
      const python = `
import os, pty, select, signal, subprocess, sys, termios, time
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'start', '--as', 'claude', '--claude', sys.argv[3], '--codex', sys.argv[3], '--grace', '0.15', '-y'], cwd=os.environ['TEST_ROOT'], stdin=slave, stdout=slave, stderr=slave)
try:
    output = b''
    deadline = time.monotonic() + 8
    while b'TTY_READY' not in output and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]: output += os.read(master, 65536)
    assert b'TTY_READY' in output, output
    assert termios.tcgetattr(slave) != original, 'author must actually enter raw mode'
    author = int(open(os.environ['TEST_ROOT'] + '/author.pid').read())
    os.kill(author if sys.argv[4] == 'author' else child.pid, signal.SIGKILL)
    child.wait(timeout=5)
    deadline = time.monotonic() + 5
    while termios.tcgetattr(slave) != original and time.monotonic() < deadline: time.sleep(0.05)
    assert termios.tcgetattr(slave) == original, 'tty mode was not restored'
    print('restored')
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
`;
      const { stdout } = await exec("python3", ["-c", python, process.execPath, CLI, fake, killed], { env, timeout: 12_000 });
      assert.match(stdout, /restored/);
      await until(() => readdirSync(socketDir).length === 0, "PTY test socket cleanup");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(socketDir, { recursive: true, force: true });
    }
  });
}

test("in a terminal, pair start waits for Enter, and a cancel creates nothing", {
  timeout: 40_000,
  skip: spawnSync("python3", ["--version"]).status !== 0 && "Python is needed for the PTY harness",
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pair-confirm-test-")));
  const socketDir = mkdtempSync("/tmp/pair-at-");
  const fake = join(root, "fake-agent");
  // A blocking read, as a Rust TUI does it: readline must leave stdin usable, and not non-blocking, for the author.
  writeFileSync(fake, `#!/usr/bin/env python3\nimport fcntl, os, sys, time\nprint('TTY_READY nonblocking=%d' % bool(fcntl.fcntl(0, fcntl.F_GETFL) & os.O_NONBLOCK), flush=True)\nprint('GOT', os.read(0, 100), flush=True)\ntime.sleep(60)\n`);
  chmodSync(fake, 0o700);
  const env = {
    ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AUTO_ROLE: "", PAIR_AUTO_RUN: "", TEST_ROOT: root,
    PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_AUTO_SOCKET_DIR: socketDir, PAIR_NO_UPDATE_CHECK: "1",
  };
  const python = `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'start', '--as', 'claude', '--claude', sys.argv[3], '--codex', sys.argv[3], '--grace', '0.15', *sys.argv[4:]], cwd=os.environ['TEST_ROOT'], stdin=slave, stdout=slave, stderr=slave)
def read_until(token):
    output = b''
    deadline = time.monotonic() + 8
    while token not in output and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            output += os.read(master, 65536)
    return output
try:
    output = read_until(b'Start? [Y/n] ')
    assert b'Start? [Y/n] ' in output, output
    if os.environ.get('TEST_BETWEEN'):
        subprocess.run(os.environ['TEST_BETWEEN'], shell=True, check=True)
    os.write(master, os.environ['TEST_INPUT'].encode())
    output += read_until(os.environ['TEST_EXPECT'].encode())
    if os.environ['TEST_EXPECT'] == 'TTY_READY':
        os.write(master, b'typed\\r')
        output += read_until(b'GOT')
    sys.stdout.write(output.decode(errors='replace'))
finally:
    if os.environ['TEST_EXPECT'] == 'TTY_READY':
        child.terminate()  # the author would run until stopped
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    print('\\nEXIT', child.returncode)
    os.close(master)
    os.close(slave)
`;
  const start = async (input, expect, between, ...args) => (await exec("python3", ["-c", python, process.execPath, CLI, fake, ...args], { env: { ...env, TEST_INPUT: input, TEST_EXPECT: expect, TEST_BETWEEN: between }, timeout: 15_000 })).stdout;
  try {
    const git = (...args) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root }).status, 0);
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    for (const [input, what] of [["\x03", "Ctrl-C"], ["\x04", "end of input"], ["n\r", "n"]]) {
      const output = await start(input, "nothing was started", "", "--worktree", "feat");
      assert.match(output, /pair: start auto mode in .*-feat \(new worktree, branch feat\)/, what);
      assert.match(output, /pair start cancelled; nothing was started[\s\S]*EXIT 1/, what);
      assert.ok(!existsSync(`${root}-feat`), `${what}: no worktree`);
      assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/feat"], { cwd: root }).status, 1, `${what}: no branch`);
      assert.ok(!existsSync(join(root, "state")), `${what}: no session record`);
      assert.deepEqual(readdirSync(socketDir), [], `${what}: no socket`);
    }
    // A reused worktree switched while the prompt waits is checked again before anything runs there.
    git("worktree", "add", "-q", "-b", "feat", `${root}-feat`);
    git("branch", "other");
    const switched = await start("\r", "checked out, not feat", `git -C '${root}-feat' switch -q other`, "--worktree", "feat");
    assert.match(switched, /\(existing worktree, branch feat\)[\s\S]*-feat has branch other checked out, not feat[\s\S]*EXIT 1/);
    assert.doesNotMatch(switched, /TTY_READY/, "no author starts");
    assert.ok(!existsSync(join(root, "state")), "no session record");
    const started = await start("\r", "TTY_READY", "");
    assert.match(started, /TTY_READY nonblocking=0/, "Enter starts the author with a blocking stdin");
    assert.match(started, /GOT b'typed/, "the author reads the terminal after the prompt");
    await until(() => readdirSync(socketDir).length === 0, "confirmed session cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-feat`, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
});
