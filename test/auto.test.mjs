import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function fixture(t, { author = "claude", scenario = "roundtrip", worker = "normal", timeout = 5, clockJumps = false, denySocket = false, reviewerModel, reviewerEffort, authorArgs = [], reviewerArgs } = {}) {
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
  calls.push({args:process.argv.slice(2), agent:process.env.PAIR_AGENT});
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
    ...(authorArgs.length ? ["--", ...authorArgs] : []),
  ];
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
      [["--as", "codex", "--", "--search=yes"], /--search for the codex author takes no value/],
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
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'start', '--as', 'claude', '--claude', sys.argv[3], '--codex', sys.argv[3], '--grace', '0.15'], cwd=os.environ['TEST_ROOT'], stdin=slave, stdout=slave, stderr=slave)
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
