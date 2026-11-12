import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { autoCall, autoSocketPath, FAILED_REVIEW_RULE, knownModels, ranSettings, setReviewer, withRecordedSession } from "../dist/auto.js";
// The tests set every pair variable they need; one inherited from a pair session (PAIR_PARTNER, PAIR_AUTO_*) would leak in.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("PAIR_")) {
    delete process.env[name];
  }
}

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

function fixture(t, { author = "claude", scenario = "roundtrip", worker = "normal", timeout = 5, clockJumps = false, denySocket = false, extraEnv = {}, reviewerModel, reviewerEffort, authorArgs = [], reviewerArgs, worktree, remoteBranch = false, initRoot = true, pairArgs = [], setup, git: gitRepo = false, codexPath } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pair-auto-test-"));
  const socketDir = mkdtempSync("/tmp/pair-at-");
  const fake = join(root, "fake-agent");
  const env = {
    ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AGENT: "", PAIR_AUTO_ROLE: "", PAIR_AUTO_RUN: "",
    PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_NO_UPDATE_CHECK: "1",
    TEST_ROOT: root, TEST_SCENARIO: scenario, TEST_WORKER: worker,
    PAIR_AUTO_SOCKET_DIR: socketDir,
    ...extraEnv,
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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// The CLI this fake plays: the owner says (PAIR_AUTO_CLI); an older owner named the agent after it.
const cli = process.env.PAIR_AUTO_CLI || process.env.PAIR_AGENT;
// The test creates the named file when the author may go on.
const gate = async (name) => { while (!existsSync(join(root, name))) await new Promise((resolve) => setTimeout(resolve, 40)); };
write(reviewer ? 'worker.pid' : 'author.pid', process.pid);
if (reviewer) {
  let calls = [];
  try { calls = JSON.parse(readFileSync(join(root, 'calls.json'), 'utf8')); } catch {}
  calls.push({args:process.argv.slice(2), agent:process.env.PAIR_AGENT, cwd:process.cwd()});
  write('calls.json', JSON.stringify(calls));
  // Reviewers running at once would race on calls.json; this log only appends.
  appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), env:{owner:process.env.PAIR_AUTO_OWNER ?? null, message:process.env.PAIR_AUTO_MESSAGE}}) + '\\n');
  const inC1 = process.cwd().endsWith('-c1');
  const count = calls.length;
  const session = '11111111-1111-4111-8111-' + String(count).padStart(12, '0');
  // Corrupt the lane before announcing the session, so recording the session must not read the lane.
  if (process.env.TEST_WORKER === 'corrupt') writeFileSync(join(dirname(process.env.PAIR_AUTO_MESSAGE), '002-review.md'), '---\\nfrom: nobody\\n---\\njunk\\n');
  console.log(JSON.stringify(cli === 'codex' ? {type:'thread.started', thread_id:session} : {type:'system',subtype:'init',session_id:session}));
  // Like the real CLIs, record what the conversation ran with in their own session files.
  if (process.env.TEST_SESSION_FILES && process.argv[process.argv.indexOf('--model') + 1] !== process.env.TEST_SESSION_UNREADABLE_FOR) {
    const flag = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
    const model = flag('--model') ?? 'default-model';
    const effort = (cli === 'codex' ? /^model_reasoning_effort="(.*)"$/.exec(flag('--config') ?? '')?.[1] : flag('--effort')) ?? 'default-effort';
    const dir = cli === 'codex' ? join(process.env.CODEX_HOME, 'sessions', '2026', '11', '10') : join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, {recursive:true});
    appendFileSync(join(dir, cli === 'codex' ? 'rollout-2026-11-10T00-00-00-' + session + '.jsonl' : session + '.jsonl'), JSON.stringify(cli === 'codex' ? {type:'turn_context', payload:{model, effort}} : {type:'assistant', isSidechain:false, message:{model}, effort}) + '\\n');
  }
  const hangs = process.env.TEST_WORKER === 'hang' || (process.env.TEST_WORKER === 'hang-c1' && inC1) || (process.env.TEST_WORKER === 'hangfirst' && count === 1);
  if (hangs || process.env.TEST_WORKER === 'leaky') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'inherit'});
    write('descendant.pid', child.pid);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (hangs) {
      process.on('SIGTERM', () => {});
      setInterval(()=>{},1000);
    }
  }
  if (process.env.TEST_WORKER === 'model-error' || process.env.TEST_WORKER === 'noisy') {
    const line = JSON.stringify(process.env.TEST_WORKER === 'noisy' ? {type:'error', message:'stream hiccup, retrying'}
      : cli === 'claude' ? {type:'result', subtype:'error_during_execution', is_error:true, errors:['No conversation found with session ID: x', 7, ' ']}
      : {type:'turn.failed', error:{message:"The 'X' model is not supported\u001b[31m" + 'a'.repeat(5000)}});
    process.stdout.write(line.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A pipe write can still be pending at process.exit.
    await new Promise((resolve) => process.stdout.write(line.slice(20) + '\\n' + JSON.stringify({type:'error', message:42}) + '\\n', resolve));
    if (process.env.TEST_WORKER === 'model-error') process.exit(1);
  }
  const model = process.argv.indexOf('--model');
  if ((process.env.TEST_WORKER === 'bad-model' || (process.env.TEST_WORKER === 'fail-c1' && inC1)) && model >= 0 && process.argv[model + 1] === 'BAD') {
    await new Promise((resolve) => process.stdout.write(JSON.stringify({type:'turn.failed', error:{message:'unknown model BAD'}}) + '\\n', resolve));
    process.exit(1);
  }
  if (!hangs) {
    if (process.env.TEST_WORKER === 'gated-release' || process.env.TEST_WORKER === 'hang-c1') await gate('release');
    if (process.env.TEST_WORKER === 'failfirst' && count === 1) process.exit(2);
    if (process.env.TEST_WORKER === 'no-verdict') process.exit(0);
    if (process.env.TEST_WORKER === 'corrupt') process.exit(0);
    const message = await call(['wait','--as',process.env.PAIR_AGENT,'--timeout','1']);
    const verdict = process.env.TEST_SCENARIO === 'brainstorm' ? (count === 1 ? 'continue' : 'complete')
      : count === 1 && ['roundtrip', 'gated'].includes(process.env.TEST_SCENARIO) ? 'changes' : 'approve';
    await call(['send','review','--as',process.env.PAIR_AGENT,'--verdict',verdict,'-'], verdict === 'changes' ? '### F1 [medium] fix this' : verdict === 'approve' ? 'Approved' : 'Option A or B?');
    if (process.env.TEST_WORKER === 'leaky') process.exit(0);
  }
} else {
  write('author.args.json', JSON.stringify(process.argv.slice(2)));
  write('author.env.json', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('PAIR_')))));
  if (process.env.TEST_AUTHOR_SESSION) process.env[cli === 'claude' ? 'CLAUDE_CODE_SESSION_ID' : 'CODEX_THREAD_ID'] = process.env.TEST_AUTHOR_SESSION;
  write('author.cwd', process.cwd());
  write('author.bin', process.env.PAIR_BIN);
  if (process.env.TEST_SCENARIO === 'hold') setInterval(()=>{},1000);
  else {
    const stateBase = join(process.env.XDG_STATE_HOME, 'pair');
    const lockState = (mode) => { if (process.env.TEST_SCENARIO === 'readonly-state') chmodSync(join(stateBase, readdirSync(stateBase)[0]), mode); };
    lockState(0o500);
    try {
      const brainstorm = process.env.TEST_SCENARIO === 'brainstorm' ? ['--brainstorm'] : [];
      const first = await call(['send','request',...brainstorm,'--as',process.env.PAIR_AGENT,'-'], '## Summary\\nTest change\\n## Files\\na.ts');
      lockState(0o700);
      write('first.out', first);
      if (process.env.TEST_SCENARIO === 'brainstorm') write('second.out', await call(['send','response','--as',process.env.PAIR_AGENT,'-'], 'A, because'));
      if (process.env.TEST_SCENARIO === 'roundtrip' || process.env.TEST_SCENARIO === 'gated') {
        if (process.env.TEST_SCENARIO === 'gated') await gate('go1');
        write('second.out', await call(['send','response','--as',process.env.PAIR_AGENT,'-'], '### F1 fixed'));
        if (process.env.TEST_SCENARIO === 'gated') await gate('go2');
        write('third.out', await call(['send','request','--as',process.env.PAIR_AGENT,'-'], 'Another task'));
      }
    } catch (error) {
      lockState(0o700);
      write('first.error', error.output || error.message);
      if (process.env.TEST_SCENARIO === 'gated-retry') await gate('go1');
      if (process.env.TEST_SCENARIO === 'retry' || process.env.TEST_SCENARIO === 'gated-retry') write('retry.out', await call(['wait','--as',process.env.PAIR_AGENT,'--timeout','1']));
      if (process.env.TEST_SCENARIO === 'gated-retry') await gate('go2');
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
    ...pairArgs,
    ...(authorArgs.length ? ["--", ...authorArgs] : []),
  ];
  if (worktree !== undefined || gitRepo) {
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
    if (initRoot) assert.equal(spawnSync(process.execPath, [CLI, "init"], { cwd: root, env }).status, 0);
  }
  setup?.({ root, env });
  const launcher = spawn(process.execPath, [CLI, "start", "--as", author, "--claude", fake, "--codex", codexPath ?? fake, "--timeout", String(timeout), "--grace", "0.15", ...overrides], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
    if (author === "codex") {
      const tools = calls[0].args[calls[0].args.indexOf("--allowedTools") + 1].split(",");
      assert.ok(tools.some((tool) => tool.endsWith(" history *)")), "a Claude reviewer can read a cited spec thread");
      assert.ok(!tools.some((tool) => / (send request|send response|reset|clean|stop|reviewer)/.test(tool)), tools.join(","));
    }
    const resume = author === "claude" ? "resume" : "--resume";
    assert.ok(calls[1].args.includes(resume));
    assert.equal(calls[1].args[calls[1].args.indexOf(resume) + 1], "11111111-1111-4111-8111-000000000001");
    assert.ok(!calls[2].args.includes(resume));
    assert.match((await f.command(["history"])).stdout, /approved/);
    assert.match((await f.command(["status"])).stdout, /auto mode: stopped/);
  });

  test(`auto ${author}: a brainstorm continues and completes through managed rounds`, { timeout: 15_000 }, async (t) => {
    const f = fixture(t, { author, scenario: "brainstorm" });
    assert.equal((await f.completed).code, 0, f.output());
    assert.match(f.read("first.out"), /brainstorm review from \w+ [^\n]* verdict continue[\s\S]*next: reply with your answers/);
    assert.match(f.read("second.out"), /verdict complete[\s\S]*brainstorm completed and closed/);
    const calls = JSON.parse(f.read("calls.json"));
    assert.equal(calls.length, 2);
    for (const { args } of calls) {
      assert.match(args.at(-1), /This thread is a brainstorm[^]*--verdict continue\|complete; /);
      assert.doesNotMatch(args.at(-1), /approve\|changes/);
    }
    assert.match(JSON.parse(f.read("author.args.json")).join(" "), /use pair send request --brainstorm/);
    assert.match((await f.command(["history"])).stdout, /completed  4 messages/);
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
  assert.match(status, /reviewer for new threads: model opus · effort high/);
  assert.match(status, /author session: unknown until the author's first review request \(a new Codex conversation\)/);
  assert.equal(f.state().reviewerModel, "opus");
  assert.equal(f.state().reviewerEffort, "high");
  await f.command(["stop"]);

  const defaults = fixture(t, { scenario: "hold" });
  await until(() => existsSync(defaults.file("author.pid")), "default author started");
  const inherited = (await defaults.command(["status"])).stdout;
  assert.match(inherited, /reviewer for new threads: model CLI default · effort CLI default/);
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

test("pair reviewer --timeout changes the limit from the next round, a retry included", { timeout: 20_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang", timeout: 0.4 });
  await until(() => existsSync(f.file("first.error")), "timeout delivered");
  await assert.rejects(f.command(["reviewer", "--timeout", "90000"]), /at most 86400/);
  await assert.rejects(f.command(["reviewer", "--thread", "current", "--timeout", "60"]), /leave out --thread/);
  assert.match((await f.command(["reviewer", "--timeout", "600"])).stdout, /review time limit: 600s \(was 0\.4s\), from the next round/);
  assert.match((await f.command(["status"])).stdout, /review time limit: 600s per round, not counting sleep/);
  const { start } = JSON.parse(readFileSync(join(f.stateDir(), "author.json"), "utf8"));
  assert.deepEqual(start.filter((arg) => arg === "--timeout").length, 1);
  assert.equal(start[start.indexOf("--timeout") + 1], "600", "pair stop's restart command keeps the new limit");
  const retry = spawn(process.execPath, [CLI, "wait", "--as", "claude", "--timeout", "30"], { cwd: f.root, env: { ...f.env, ...JSON.parse(f.read("author.env.json")) } });
  t.after(() => retry.kill());
  await until(() => JSON.parse(f.read("calls.json")).length === 2, "retry started");
  await pause(2000);
  assert.equal(retry.exitCode, null, "the retry runs past the old 0.4s limit");
  await f.command(["stop"]);
});

test("pair reviewer --timeout changes nothing unless the session's own owner supports it", async (t) => {
  const socketDir = mkdtempSync("/tmp/pair-at-");
  const previous = process.env.PAIR_AUTO_SOCKET_DIR;
  process.env.PAIR_AUTO_SOCKET_DIR = socketDir;
  const stateDir = join(socketDir, "state");
  const actions = [];
  let status = { state: { reviewerModel: "m" } };
  const owner = createServer((socket) => socket.once("data", (data) => {
    const { action } = JSON.parse(data);
    actions.push(action);
    socket.end(JSON.stringify(action === "status" ? status : { message: "reviewer for new threads: ..." }));
  }));
  await new Promise((resolve) => owner.listen(autoSocketPath(stateDir), resolve));
  t.after(() => {
    owner.close();
    if (previous === undefined) delete process.env.PAIR_AUTO_SOCKET_DIR;
    else process.env.PAIR_AUTO_SOCKET_DIR = previous;
    rmSync(socketDir, { recursive: true, force: true });
  });
  await assert.rejects(setReviewer(stateDir, { model: "new", timeoutSeconds: 600 }), /runs an older pair that can't change its review time limit; nothing was changed/);
  assert.deepEqual(actions, ["status"], "the model isn't changed either");
  await assert.rejects(setReviewer(stateDir, { thread: "current", model: "new", timeoutSeconds: 600 }), /leave out --thread/);
  status = { served: { root: "/the/root", pid: 1 } }; // a served worktree's owner may be older too
  await assert.rejects(setReviewer(stateDir, { model: "new", timeoutSeconds: 600 }), /served by the auto session in \/the\/root; run pair reviewer --timeout there/);
  assert.deepEqual(actions, ["status", "status"], "neither reaches the reviewer action");
});

test("pair wait reruns a timed-out review", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "retry", worker: "hangfirst" });
  assert.equal((await f.completed).code, 0, f.output());
  assert.match(f.read("first.error"), /reviewer timed out\. Pair wait retries it; to give it more than 5s, first run pair reviewer --timeout SECONDS in your own terminal\./);
  assert.match(f.read("retry.out"), /verdict approve/);
  assert.equal(JSON.parse(f.read("calls.json")).length, 2);
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
  assert.match(error, /Pair wait retries it with the same --reviewer-model GPT-X; to change that first, run pair reviewer --thread current with the new value in your own terminal\./);
  await f.command(["stop"]);
});

for (const author of ["claude", "codex"]) test(`status shows what the ${author === "claude" ? "codex" : "claude"} reviewer actually ran with`, { timeout: 20_000 }, async (t) => {
  const homes = mkdtempSync(join(tmpdir(), "pair-cli-homes-"));
  t.after(() => rmSync(homes, { recursive: true, force: true }));
  const f = fixture(t, { author, scenario: "gated", reviewerEffort: "high", extraEnv: { TEST_SESSION_FILES: "1", CODEX_HOME: join(homes, "codex"), CLAUDE_CONFIG_DIR: join(homes, "claude") } });
  await until(() => existsSync(f.file("first.out")), "first round");
  const { log } = f.state(); // auto.json goes when the session ends
  let status = "";
  await until(async () => /\(ran default-model\)/.test(status = (await f.command(["status"])).stdout), "the round's settings are read");
  assert.match(status, /reviewer for thread \S+: model CLI default \(ran default-model\) · effort high\n/, "a requested value the reviewer used isn't repeated");
  assert.match(status, /reviewer for new threads: model CLI default \(last ran default-model\) · effort high\n/);
  await f.command(["reviewer", "--reviewer-model", "new-model"]);
  assert.match((await f.command(["status"])).stdout, /reviewer for new threads: model new-model · effort high\n/, "other settings: nothing ran with them yet");
  writeFileSync(f.file("go1"), "");
  writeFileSync(f.file("go2"), "");
  assert.equal((await f.completed).code, 0, f.output());
  assert.match(readFileSync(log, "utf8"), /pair: reviewer for thread \S+ ran model new-model · effort high/);
});

test("pair reviewer changes the reviewer for new threads; an open thread keeps its settings", { timeout: 20_000 }, async (t) => {
  const f = fixture(t, { scenario: "gated", reviewerModel: "old-model" });
  await until(() => existsSync(f.file("first.out")), "first round");
  await assert.rejects(f.command(["reviewer", "--reviewer-effort", "higgh"]), /--reviewer-effort for codex must be one of/);
  await assert.rejects(f.command(["reviewer"]), /pass --reviewer-model or --reviewer-effort/);
  const { stdout } = await f.command(["reviewer", "--reviewer-model", "new-model", "--reviewer-effort", "high"]);
  assert.match(stdout, /reviewer for new threads: model new-model · effort high \(was model old-model · effort CLI default\)/);
  const status = (await f.command(["status"])).stdout;
  assert.match(status, /reviewer for new threads: model new-model · effort high/);
  assert.match(status, /reviewer for thread \S+: model old-model · effort CLI default/);
  writeFileSync(f.file("go1"), "");
  await until(() => existsSync(f.file("second.out")), "follow-up round");
  writeFileSync(f.file("go2"), "");
  assert.equal((await f.completed).code, 0, f.output());
  const calls = JSON.parse(f.read("calls.json"));
  assert.equal(calls.length, 3);
  const model = ({ args }) => args[args.indexOf("--model") + 1];
  assert.deepEqual(calls.map(model), ["old-model", "old-model", "new-model"], "the follow-up keeps its thread's settings");
  assert.ok(calls[1].args.includes("resume"), "an unchanged thread still resumes its reviewer");
  assert.ok(!calls[0].args.includes("--config") && calls[2].args.includes('model_reasoning_effort="high"'));
  const record = JSON.parse(readFileSync(join(f.stateDir(), "author.json"), "utf8"));
  assert.match(record.restart, /--reviewer-model new-model --reviewer-effort high -- /, "pair stop's restart command has the current settings");
  assert.deepEqual(record.start.slice(-4), ["--reviewer-model", "new-model", "--reviewer-effort", "high"], "and so do the arguments a guided resume reuses");
  assert.ok(record.restart.includes(` pair start ${record.start.join(" ")} -- `));
  await assert.rejects(f.command(["reviewer", "--reviewer-model", "x"]), /auto mode is not running here/);
});

test("pair reviewer --thread fixes a failed thread's settings, and its retry starts a new reviewer conversation", { timeout: 20_000 }, async (t) => {
  const homes = mkdtempSync(join(tmpdir(), "pair-cli-homes-"));
  t.after(() => rmSync(homes, { recursive: true, force: true }));
  // The new conversation's session file can't be read, so nothing may claim what it ran with.
  const f = fixture(t, { scenario: "gated-retry", worker: "bad-model", reviewerModel: "BAD", extraEnv: { TEST_SESSION_FILES: "1", TEST_SESSION_UNREADABLE_FOR: "good", CODEX_HOME: join(homes, "codex") } });
  await until(() => existsSync(f.file("first.error")), "failed round delivered");
  assert.match(f.read("first.error"), /unknown model BAD.*run pair reviewer --thread current/s);
  await assert.rejects(exec(process.execPath, [CLI, "reviewer", "--thread", "current", "--reviewer-model", "good"], { cwd: f.root, env: { ...f.env, PAIR_AUTO_ROLE: "author" } }),
    /run pair reviewer in your own terminal/);
  await assert.rejects(f.command(["reviewer", "--thread", "some-other-thread", "--reviewer-model", "good"]), /--thread some-other-thread: the failed thread is \S+/);
  await assert.rejects(f.command(["status", "--thread", "current"]), /--thread is only supported by pair reviewer/);
  const { stdout } = await f.command(["reviewer", "--thread", "current", "--reviewer-model", "good"]);
  assert.match(stdout, /reviewer for thread \S+: model good · effort CLI default \(was model BAD · effort CLI default\)\. Its next round starts a new codex conversation/);
  const status = (await f.command(["status"])).stdout;
  assert.match(status, /reviewer for new threads: model BAD/, "--thread leaves the defaults alone");
  assert.match(status, /reviewer for thread \S+: model good/);
  writeFileSync(f.file("go1"), "");
  await until(() => existsSync(f.file("retry.out")), "retried round");
  assert.match(f.read("retry.out"), /verdict approve/);
  assert.match((await f.command(["status"])).stdout, /reviewer for thread \S+: model good · effort CLI default\n/, "not the old conversation's model BAD");
  const calls = JSON.parse(f.read("calls.json"));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf("--model") + 1], "good");
  assert.ok(!calls[1].args.includes("resume"), "a changed thread doesn't resume its old reviewer conversation");
  await assert.rejects(f.command(["reviewer", "--thread", "current", "--reviewer-model", "x"]), /no pending thread's last review round failed/);
  writeFileSync(f.file("go2"), "");
  assert.equal((await f.completed).code, 0, f.output());
});

test("ranSettings reads the last model and effort a conversation ran with from each CLI's session file", () => {
  const homes = mkdtempSync(join(tmpdir(), "pair-cli-homes-"));
  try {
    const env = { CODEX_HOME: join(homes, "codex"), CLAUDE_CONFIG_DIR: join(homes, "claude") };
    const id = "11111111-1111-4111-8111-111111111111";
    const lines = (...entries) => entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n";
    mkdirSync(join(env.CODEX_HOME, "sessions", "2026", "11", "09"), { recursive: true });
    writeFileSync(join(env.CODEX_HOME, "sessions", "2026", "11", "09", `rollout-2026-11-09T23-00-00-${id}.jsonl`), lines(
      { type: "turn_context", payload: { model: "gpt-old", effort: "low" } }, "not json", { type: "turn_context", payload: { model: "gpt-new", effort: "xhigh" } }, { type: "event_msg" }));
    assert.deepEqual(ranSettings("codex", id, "/any", env), { model: "gpt-new", effort: "xhigh" });
    // Claude: the last main-thread entry from a model, not a subagent's or Claude's own "<synthetic>" one.
    const dir = join(env.CLAUDE_CONFIG_DIR, "projects", "-work-my-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), lines(
      { type: "assistant", isSidechain: false, message: { model: "claude-opus-5-5" }, effort: "xhigh" },
      { type: "assistant", isSidechain: true, message: { model: "claude-haiku-5-5" }, effort: "low" },
      { type: "assistant", isSidechain: false, isApiErrorMessage: false, message: { model: "<synthetic>" } }));
    assert.deepEqual(ranSettings("claude", id, "/work/my.repo", env), { model: "claude-opus-5-5", effort: "xhigh" });
    assert.deepEqual(ranSettings("claude", id, "/elsewhere", env), { model: "claude-opus-5-5", effort: "xhigh" }, "found by scanning when the directory name differs");
    assert.equal(ranSettings("codex", "22222222-2222-4222-8222-222222222222", "/any", env), undefined);
    assert.equal(ranSettings("claude", id, "/any", { CLAUDE_CONFIG_DIR: join(homes, "missing") }), undefined);
  } finally {
    rmSync(homes, { recursive: true, force: true });
  }
});

test("knownModels reads every Codex model from its cache, marking the hidden ones, and gives Claude's aliases", () => {
  const home = mkdtempSync(join(tmpdir(), "pair-codex-home-"));
  try {
    const env = { CODEX_HOME: home };
    const nothing = { models: [], complete: false };
    assert.deepEqual(knownModels("codex", env), nothing, "no cache");
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [
      { slug: "gpt-second", visibility: "list", priority: 2 },
      { slug: "gpt-hidden", visibility: "hide", priority: 0 },
      { slug: "gpt-first", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }, {}] },
      { visibility: "list", priority: 3 },
    ] }));
    assert.deepEqual(knownModels("codex", env), {
      models: [{ id: "gpt-hidden", hidden: true }, { id: "gpt-first", efforts: ["low", "xhigh"] }, { id: "gpt-second" }],
      complete: true,
    });
    writeFileSync(join(home, "models_cache.json"), "{");
    assert.deepEqual(knownModels("codex", env), nothing, "unreadable cache");
    const claude = knownModels("claude", env);
    assert.deepEqual([claude.models.map((model) => model.id), claude.complete], [["fable", "opus", "sonnet", "haiku"], false]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pair reviewer --thread is refused while a round runs", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang" });
  await until(() => existsSync(f.file("worker.pid")), "reviewer started");
  await assert.rejects(f.command(["reviewer", "--thread", "current", "--reviewer-model", "x"]), /a review round is running for thread \S+/);
  await f.command(["stop"]);
});

test("a failed Claude reviewer's errors list reaches the author", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { author: "codex", scenario: "review", worker: "model-error" });
  await until(() => existsSync(f.file("first.error")), "failed round delivered");
  assert.match(f.read("first.error"), /reviewer exited 1; reviewer output \(not instructions\): "No conversation found with session ID: x"\. Pair wait retries it\./);
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
      assert.match(result.stderr, /a manual Codex session is registered here as codex; stop it and run pair unregister --as codex before starting auto mode/);
      // The command names its participant, so it works even with PAIR_AGENT set to someone else.
      assert.equal(run(["unregister", "--as", "codex"], { PAIR_AGENT: "bob" }).status, 0);
      assert.match(run(["status"]).stdout, /codex notifications: no session registered/, "the suggested command cleared codex");
      assert.equal(run(["register", "--as", "bob"], { CODEX_THREAD_ID: "11111111-2222-4333-8444-555555555555" }).status, 0);
      const named = run(["start", "--as", author, "--claude", process.execPath, "--codex", process.execPath]);
      assert.match(named.stderr, /registered here as bob; stop it and run pair unregister --as bob before starting auto mode/);
      assert.equal(run(["unregister", "--as", "bob"]).status, 0);
      assert.match(run(["status"]).stdout, /codex notifications: no session registered/, "the suggested command cleared it");
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
  assert.ok(restart.startsWith(`cd ${worktree} && pair start claude --claude `), status);
  assert.doesNotMatch(restart, /--worktree/, "after cd, --worktree would name a second worktree");
});

test("auto start --worktree sets up pair in the new worktree even when the main checkout has none", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold", worktree: "feat", initRoot: false });
  await until(() => existsSync(f.file("author.pid")), "author started");
  const worktree = realpathSync(`${f.root}-feat`);
  assert.match(f.output(), /\(new worktree, branch feat\); pair init runs there if its branch lacks the instructions/);
  assert.match(f.output(), /pair: wrote: .*-feat\/AGENTS\.md/);
  assert.ok(existsSync(join(worktree, ".claude", "skills", "pair", "SKILL.md")));
  assert.ok(!existsSync(join(f.root, "AGENTS.md")), "the main checkout is left alone");
  const stop = spawnSync(process.execPath, [CLI, "stop"], { cwd: worktree, env: f.env, encoding: "utf8" });
  assert.equal(stop.status, 0, stop.stderr);
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
    // A reused worktree runs on whatever it has checked out (a ticket's branch gets renamed), and the summary
    // says what that is: fix/one and fix-one share a path, and a worktree can be switched or detached.
    // The registration stops each start after the summary and init, before any agent.
    git("worktree", "add", "-q", "-b", "fix/one", join(base, "repo-fix-one"));
    assert.equal(run(join(base, "repo-fix-one"), ["register"], { CODEX_THREAD_ID: "11111111-2222-4333-8444-555555555555" }).status, 0);
    assert.match(start("--worktree", "fix-one").stderr, /repo-fix-one \(existing worktree, branch fix\/one\)[\s\S]*a manual Codex session is registered here/);
    assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/fix-one"], { cwd: root }).status, 1, "nothing is switched or created");
    assert.equal(spawnSync("git", ["checkout", "-q", "--detach"], { cwd: join(base, "repo-fix-one") }).status, 0);
    assert.match(start("--worktree", "fix/one").stderr, /repo-fix-one \(existing worktree, a detached HEAD at [0-9a-f]{12}\)[\s\S]*a manual Codex session is registered here/);
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
    assert.equal(run(join(base, "repo-feat"), ["register"], { CODEX_THREAD_ID: "11111111-2222-4333-8444-555555555555" }).status, 0);
    const reused = start("--worktree", "feat");
    assert.equal(reused.status, 1);
    assert.match(reused.stderr, /this session runs in worktree .*repo-feat; run pair status and pair stop there\n[\s\S]*pair: wrote: .*repo-feat\/AGENTS\.md[\s\S]*a manual Codex session is registered here/);
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
      [["--as", "claude", "stray"], /the author's CLI must be claude or codex \(got "stray"\)/],
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
      // A codex author resumes only by ID, as the first author argument.
      ...[["resume"], ["resume", "--last"], ["resume", "my-session"]].map((args) => [["--as", "codex", "--", ...args], /resumes a codex author only by session ID/]),
      [["--as", "codex", "--", "resume", "01a18aac-6f8a-70d1-86ce-9728073a8693", "exec"], /can't pass "exec" to the codex author: only options/],
      [["--as", "codex", "--", "-m", "m", "resume", "01a18aac-6f8a-70d1-86ce-9728073a8693"], /can't pass "resume" to the codex author: only options/],
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
    env: { ...process.env, CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", PAIR_AUTO_ROLE: "", PAIR_AUTO_RUN: "", PAIR_NO_UPDATE_CHECK: "1" }, encoding: "utf8",
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

test("guardian survives a system sleep that suspends it and the launcher past the heartbeat deadline", { timeout: 20_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold" });
  await until(() => existsSync(f.file("author.pid")), "author started");
  const guardian = f.state().guardianPid;
  // A sleeping Mac suspends every process while Node's monotonic clock keeps counting.
  f.launcher.kill("SIGSTOP");
  process.kill(guardian, "SIGSTOP");
  try { await pause(6500); }
  finally { process.kill(guardian, "SIGCONT"); f.launcher.kill("SIGCONT"); }
  await pause(2200);
  assert.ok(alive(Number(f.read("author.pid"))), "waking up must not terminate the author");
  await f.command(["stop"]);
});

test("a review's time limit doesn't count a system sleep", { timeout: 25_000 }, async (t) => {
  const f = fixture(t, { scenario: "review", worker: "hang", timeout: 4 });
  await until(() => existsSync(f.file("worker.pid")), "reviewer started");
  const guardian = f.state().guardianPid;
  f.launcher.kill("SIGSTOP");
  process.kill(guardian, "SIGSTOP");
  try { await pause(6000); }
  finally { process.kill(guardian, "SIGCONT"); f.launcher.kill("SIGCONT"); }
  await pause(1500);
  assert.ok(!existsSync(f.file("first.error")), "six seconds asleep don't use up a four-second limit");
  await until(() => existsSync(f.file("first.error")), "the limit still applies to time awake");
  assert.match(f.read("first.error"), /timed out/);
  await f.command(["stop"]);
});

test("a review launched as the Mac wakes gets no credit for the sleep before it", { timeout: 25_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold", worker: "hang", timeout: 2 });
  await until(() => existsSync(f.file("author.env.json")), "author started");
  const guardian = f.state().guardianPid;
  process.kill(guardian, "SIGSTOP");
  let output = "";
  let ended;
  try {
    // The owner queues the launch while the guardian sleeps; the guardian handles it on waking.
    const send = spawn(process.execPath, [CLI, "send", "request", "--as", "claude", "--to", "codex", "-"], { cwd: f.root, env: { ...f.env, ...JSON.parse(f.read("author.env.json")) } });
    for (const stream of [send.stdout, send.stderr]) stream.on("data", (chunk) => { output += chunk; });
    ended = new Promise((resolve) => send.once("close", resolve));
    send.stdin.end("## Summary\nx");
    await pause(6000);
  } finally { process.kill(guardian, "SIGCONT"); }
  const woke = Date.now();
  await ended;
  assert.match(output, /timed out/);
  assert.ok(Date.now() - woke < 4500, `a two-second limit ended ${Date.now() - woke}ms after waking`);
  await f.command(["stop"]);
});

test("standard help describes auto mode", () => {
  const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pair start \[AUTHOR_CLI \[REVIEWER_CLI\]\]/);
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
  // One rule for a failed review, in the author's system prompt and in the instructions agents read.
  assert.ok(args[args.indexOf("--append-system-prompt") + 1].includes(FAILED_REVIEW_RULE.replaceAll("{{AGENT}}", "claude")));
  const instructions = readFileSync(join(import.meta.dirname, "..", "prompts", "pair.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(instructions.includes(FAILED_REVIEW_RULE), "prompts/pair.md states the same failed-review rule");
  await f.command(["stop"]);
});

const NEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a new Claude author gets an ID that pair start, status and stop report, with a restart command", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { scenario: "hold", reviewerModel: "m1", authorArgs: ["--model", "opus"] });
  await until(() => existsSync(f.file("author.args.json")), "author started");
  const args = JSON.parse(f.read("author.args.json"));
  const id = args[args.indexOf("--session-id") + 1];
  assert.match(id, NEW_ID);
  assert.match(f.output(), /pair: start auto mode in .*; pair init runs there first\n/, "the fixture's directory has no instructions");
  assert.ok(existsSync(join(f.root, "AGENTS.md")) && existsSync(join(f.root, ".claude", "skills", "pair", "SKILL.md")));
  assert.match(f.output(), new RegExp(`pair: start auto mode in .*\npair:   author claude · session ${id} \\(new\\)\npair:   reviewer codex · model m1 · effort CLI default\n`));
  assert.match((await f.command(["status"])).stdout, new RegExp(`author session: ${id} \\(new\\)`));
  const stopped = (await f.command(["stop"])).stdout;
  assert.match(stopped, new RegExp(`last author session: ${id} \\(picked by pair, .*; pair doesn't check that it still exists\\)`));
  assert.equal(/restart it: (.*)/.exec(stopped)?.[1], `cd ${realpathSync(f.root)} && pair start claude --claude ${f.fake} --codex ${f.fake} --timeout 5 --grace 0.15 --reviewer-model m1 -- --model opus --resume ${id}`);
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
  assert.match(args.at(-1), /In this launch your pair name is claude and your reviewer is codex: pass --as claude --to codex/, "a recorded prompt may name another pairing");
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
  assert.match((await f.command(["status"])).stdout, /author session: unknown until the author's first review request \(--continue: Claude's newest conversation in this worktree\)/);
  const stopped = (await f.command(["stop"])).stdout;
  assert.match(stopped, /last author session: unknown \(--continue/);
  assert.doesNotMatch(stopped, /restart it/);
});

for (const [author, authorArgs] of [["claude", ["-c"]], ["codex", []]]) {
  test(`a ${author} author's first review request reports its conversation, which pair stop can resume`, { timeout: 15_000 }, async (t) => {
    const id = "0c8b6a3e-ff15-49a6-915b-b3884cabde5f";
    const f = fixture(t, { author, scenario: "review", authorArgs, extraEnv: { TEST_AUTHOR_SESSION: id } });
    await until(() => existsSync(f.file("first.out")), "first round");
    assert.match((await f.command(["status"])).stdout, new RegExp(`author session: ${id} \\(reported by the author\\)`));
    const stopped = (await f.command(["stop"])).stdout;
    assert.match(stopped, new RegExp(`last author session: ${id} \\(reported by the author, `));
    assert.match(stopped, new RegExp(author === "claude" ? ` -- --resume ${id}$` : ` -- resume ${id}$`, "m"), "-c is replaced, not kept");
  });
}

test("pair ignores an author ID that isn't a UUID, and a stale one from pair start's own environment", { timeout: 15_000 }, async (t) => {
  for (const extraEnv of [{ TEST_AUTHOR_SESSION: "not-a-uuid" }, { CLAUDE_CODE_SESSION_ID: "0c8b6a3e-ff15-49a6-915b-b3884cabde5f" }]) {
    const f = fixture(t, { scenario: "review", authorArgs: ["-c"], extraEnv });
    await until(() => existsSync(f.file("first.out")), "first round");
    assert.match((await f.command(["status"])).stdout, /author session: unknown until/, JSON.stringify(extraEnv));
    await f.command(["stop"]);
  }
});

test("a codex author resumes by ID, and pair stop can resume it again", { timeout: 15_000 }, async (t) => {
  const id = "01a18aac-6f8a-70d1-86ce-9728073a8693";
  const f = fixture(t, { author: "codex", scenario: "hold", authorArgs: ["resume", id, "-m", "fixture-model"] });
  await until(() => existsSync(f.file("author.args.json")), "author started");
  const args = JSON.parse(f.read("author.args.json"));
  assert.deepEqual(args.slice(0, 6), ["resume", id, "-m", "fixture-model", "--cd", realpathSync(f.root)], "--cd keeps a resumed session in this worktree");
  assert.equal(args.at(-2), "--", "the prompt is its new message");
  // A session on Codex's shared app-server daemon doesn't get the author's environment: pair's variables also go in as config.
  const config = Object.fromEntries(args.slice(6, -2).map((arg, i, all) => i % 2 ? [] : (assert.equal(arg, "-c"), all[i + 1].split(/=(.*)/s).slice(0, 2))).filter((pair) => pair.length));
  const env = JSON.parse(f.read("author.env.json"));
  for (const name of ["PAIR_AGENT", "PAIR_PARTNER", "PAIR_AUTO_ROLE", "PAIR_AUTO_RUN", "PAIR_AUTO_OWNER", "PAIR_BIN", "PAIR_HOME"]) {
    assert.equal(config[`shell_environment_policy.set.${name}`], JSON.stringify(env[name]), name);
  }
  assert.match((await f.command(["status"])).stdout, new RegExp(`author session: ${id} \\(resumed\\)`));
  assert.match((await f.command(["stop"])).stdout, new RegExp(` -- resume ${id} -m fixture-model$`, "m"));
});

test("an author that can't start is reported instead of a silent exit", { timeout: 15_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pair-auto-spawn-"));
  const socketDir = mkdtempSync("/tmp/pair-at-");
  const broken = join(root, "broken-codex");
  writeFileSync(broken, "#!/nonexistent/interpreter\n");
  chmodSync(broken, 0o700);
  const env = { ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AGENT: "", PAIR_AUTO_ROLE: "", PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_AUTO_SOCKET_DIR: socketDir, PAIR_NO_UPDATE_CHECK: "1" };
  try {
    const result = spawnSync(process.execPath, [CLI, "start", "--as", "codex", "--codex", broken, "--claude", process.execPath], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pair: the codex author couldn't start: .*ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
});

/** Writes the author record pair keeps for root, as an earlier session would have. */
function recordAuthor(root, stateHome, record) {
  const real = realpathSync(root);
  const dir = join(stateHome, "pair", `${basename(real)}-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "author.json"), JSON.stringify({ worktree: real, learned: "author-env", note: null, at: "2026-10-30T00:00:00.000Z", restart: "cd x && pair start", ...record }));
}

test("withRecordedSession gives a guided resume its session's pair start arguments, when the record has them", () => {
  const root = mkdtempSync(join(tmpdir(), "pair-record-"));
  const states = mkdtempSync(join(tmpdir(), "pair-states-"));
  try {
    const id = "0c8b6a3e-ff15-49a6-915b-b3884cabde5f";
    const real = realpathSync(root);
    const stateDir = join(states, "pair", `${basename(real)}-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`);
    recordAuthor(root, states, { backend: "claude", session: id });
    assert.equal(withRecordedSession("claude", [], stateDir, real).start, undefined, "an older record");
    recordAuthor(root, states, { backend: "claude", session: id, start: ["claude", "--reviewer-model", "m"] });
    assert.deepEqual(withRecordedSession("claude", [], stateDir, real).start, ["claude", "--reviewer-model", "m"]);
    recordAuthor(root, states, { backend: "claude", session: id, start: ["claude", 1] });
    assert.throws(() => withRecordedSession("claude", [], stateDir, real), /no author conversation is recorded/, "a malformed record is no record");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(states, { recursive: true, force: true });
  }
});

for (const author of ["claude", "codex"]) {
  test(`pair start --resume resumes the ${author} author's last recorded conversation`, { timeout: 15_000 }, async (t) => {
    const id = "0c8b6a3e-ff15-49a6-915b-b3884cabde5f";
    const f = fixture(t, { author, scenario: "hold", pairArgs: ["--resume"], authorArgs: ["--model", "m"], setup: ({ root, env }) => recordAuthor(root, env.XDG_STATE_HOME, { backend: author, session: id }) });
    await until(() => existsSync(f.file("author.args.json")), "author started");
    const args = JSON.parse(f.read("author.args.json"));
    if (author === "claude") {
      assert.deepEqual(args.slice(0, 4), ["--model", "m", "--resume", id]);
      assert.ok(!args.includes("--session-id"));
    } else {
      assert.deepEqual(args.slice(0, 4), ["resume", id, "--model", "m"]);
    }
    assert.match(f.output(), new RegExp(`author ${author} · session ${id} \\(resumed: the last author conversation here, recorded 2026-10-30T00:00:00.000Z\\)`));
    assert.match((await f.command(["status"])).stdout, new RegExp(`author session: ${id} \\(resumed\\)`));
    await f.command(["stop"]);
  });
}

test("pair start --resume refuses without a usable record, or with a selector of its own", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pair-auto-resume-")));
  const stateHome = join(root, "state");
  const env = { ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AGENT: "", PAIR_AUTO_ROLE: "", PAIR_AUTO_RUN: "", PAIR_HOME: join(root, "home"), XDG_STATE_HOME: stateHome, PAIR_NO_UPDATE_CHECK: "1" };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
  const start = (as, ...args) => run("start", "--as", as, "--claude", process.execPath, "--codex", process.execPath, "--resume", ...args);
  const id = "0c8b6a3e-ff15-49a6-915b-b3884cabde5f";
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: root }).status, 0);
    const refused = (result, message) => {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /pair: start auto mode/, "refused before the summary");
    };
    refused(start("claude"), /no author conversation is recorded for .*; start without --resume/);
    refused(run("status", "--resume"), /--resume is only supported by pair start/);
    refused(start("claude", "--worktree", "feat"), /--resume needs an existing worktree; .*-feat doesn't exist yet/);
    recordAuthor(root, stateHome, { backend: "codex", session: id });
    refused(start("claude"), /the last author in .* was codex, not claude/);
    refused(start("codex", "--", "resume", id), /pair start --resume picks the conversation; drop the resume after --/);
    recordAuthor(root, stateHome, { backend: "claude", session: id });
    for (const selector of [["-c"], ["--resume", id], [`--resume=${id}`]]) {
      refused(start("claude", "--", ...selector), /pair start --resume picks the conversation; drop the --continue or --resume after --/);
    }
    recordAuthor(root, stateHome, { backend: "claude", session: null, learned: null, note: "--continue: Claude's newest conversation in this worktree", restart: null });
    refused(start("claude"), /the last claude author in .* has no known conversation ID \(--continue: Claude's newest conversation in this worktree\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-feat`, { recursive: true, force: true });
  }
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

// A closed terminal window: a write to it blocks forever, which once kept a guardian alive for days.
for (const signal of ["SIGKILL", "SIGTERM"]) {
  test(`owner and guardian exit when their terminal is gone and the launcher gets ${signal}`, {
    timeout: 20_000,
    skip: spawnSync("python3", ["--version"]).status !== 0 && "Python is needed for the PTY harness",
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "pair-gone-tty-test-"));
    const socketDir = mkdtempSync("/tmp/pair-at-");
    const fake = join(root, "fake-agent");
    writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdin.setRawMode(true);\nconsole.log('TTY_READY');\nsetInterval(() => {}, 1000);\n`);
    chmodSync(fake, 0o700);
    const env = {
      ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AUTO_ROLE: "", PAIR_AUTO_RUN: "", TEST_ROOT: root,
      PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_AUTO_SOCKET_DIR: socketDir, PAIR_NO_UPDATE_CHECK: "1",
    };
    try {
      const python = `
import glob, json, os, pty, select, signal, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'start', '--as', 'claude', '--claude', sys.argv[3], '--codex', sys.argv[3], '--grace', '0.15', '-y'], cwd=os.environ['TEST_ROOT'], stdin=slave, stdout=slave, stderr=slave)
def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
try:
    output = b''
    deadline = time.monotonic() + 8
    while b'TTY_READY' not in output and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]: output += os.read(master, 65536)
    assert b'TTY_READY' in output, output
    guardian = json.load(open(glob.glob(os.environ['XDG_STATE_HOME'] + '/pair/*/auto.json')[0]))['guardianPid']
    os.close(master)  # the terminal window closes
    master = None
    os.kill(child.pid, getattr(signal, sys.argv[4]))
    deadline = time.monotonic() + 8
    while (child.poll() is None or alive(guardian)) and time.monotonic() < deadline: time.sleep(0.1)
    print('owner', 'exited' if child.poll() is not None else 'ALIVE', 'guardian', 'ALIVE' if alive(guardian) else 'exited')
    if alive(guardian): os.kill(guardian, signal.SIGKILL)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    if master is not None: os.close(master)
    os.close(slave)
`;
      const { stdout } = await exec("python3", ["-c", python, process.execPath, CLI, fake, signal], { env, timeout: 18_000 });
      assert.match(stdout, /owner exited guardian exited/);
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
    const switched = await start("\r", "run pair start again", `git -C '${root}-feat' switch -q other`, "--worktree", "feat");
    assert.match(switched, /\(existing worktree, branch feat\)[\s\S]*-feat changed while pair start waited: it has branch other checked out now, not branch feat; run pair start again[\s\S]*EXIT 1/);
    assert.doesNotMatch(switched, /TTY_READY/, "no author starts");
    assert.ok(!existsSync(join(root, "state")), "no session record");
    // A detached HEAD has no branch, so its commit is what the summary showed and what is checked again.
    git("commit", "-q", "--allow-empty", "-m", "second");
    const second = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    assert.equal(spawnSync("git", ["checkout", "-q", "--detach", "other"], { cwd: `${root}-feat` }).status, 0);
    const moved = await start("\r", "run pair start again", `git -C '${root}-feat' checkout -q --detach ${second}`, "--worktree", "feat");
    assert.match(moved, /\(existing worktree, a detached HEAD at [0-9a-f]{12}\)[\s\S]*-feat changed while pair start waited: it has a detached HEAD at [0-9a-f]{12} checked out now, not a detached HEAD at [0-9a-f]{12}; run pair start again[\s\S]*EXIT 1/);
    assert.doesNotMatch(moved, /TTY_READY/, "no author starts");
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

// --serve-worktrees: subagents in other worktrees of the repository review through the root's owner.
function addChild(f, name) {
  const dir = `${f.root}-${name}`;
  assert.equal(spawnSync("git", ["worktree", "add", "-q", dir, "-b", name], { cwd: f.root }).status, 0);
  return realpathSync(dir);
}

/** Runs the CLI as a subagent of the auto author would: in its own worktree, with the author's environment. */
function asSubagent(f, owner, cwd, args, input = "") {
  const env = { ...f.env, PAIR_AUTO_ROLE: "author", PAIR_AUTO_RUN: f.state().run, PAIR_AUTO_OWNER: owner, PAIR_AGENT: "claude" };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { out += data; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

const channelName = (dir) => `${basename(dir)}-${createHash("sha1").update(dir).digest("hex").slice(0, 8)}`;
const reviewerCalls = (f) => existsSync(f.file("calls.jsonl")) ? f.read("calls.jsonl").trim().split("\n").map((line) => JSON.parse(line)) : [];
const inDir = (f, cwd, args) => exec(process.execPath, [CLI, ...args], { cwd, env: f.env, timeout: 10_000 });

async function served(t, options) {
  const f = fixture(t, { scenario: "hold", git: true, timeout: 20, ...options });
  t.after(() => { for (const name of ["c1", "c2", "c3"]) rmSync(`${f.root}-${name}`, { recursive: true, force: true }); });
  await until(() => { try { return existsSync(f.file("author.pid")) && f.state().phase === "idle"; } catch { return false; } }, "owner ready");
  return { f, owner: f.stateDir() };
}

test("without --serve-worktrees, a subagent worktree's request is refused and stays on disk", { timeout: 20_000 }, async (t) => {
  const { f, owner } = await served(t, {});
  const c1 = addChild(f, "c1");
  const sent = await asSubagent(f, owner, c1, ["send", "request", "-"], "## Summary\nchild work");
  assert.equal(sent.code, 1, sent.out);
  assert.match(sent.out, /doesn't serve other worktrees; integrate the work into .*, or start the session with --serve-worktrees.*The request remains on disk/s);
  assert.equal(reviewerCalls(f).length, 0);
  assert.match((await inDir(f, c1, ["status"])).stdout, /claude-to-codex: awaiting-review/);
});

test("--serve-worktrees: a subagent's loop runs through the root's owner, writes nothing in its worktree, and its commands there are scoped", { timeout: 30_000 }, async (t) => {
  const { f, owner } = await served(t, { pairArgs: ["--serve-worktrees"] });
  const recorded = JSON.parse(readFileSync(join(owner, "author.json"), "utf8")).session;
  const c1 = addChild(f, "c1");
  // A tracked AGENTS.md whose pair section an older pair wrote: a refresh here would rewrite it.
  const stale = "# repo notes\n<!-- pair:start -->\n<!-- pair 0.1.0 -->\nold pair instructions\n<!-- pair:end -->\n";
  writeFileSync(join(c1, "AGENTS.md"), stale);
  assert.equal(spawnSync("git", ["add", "AGENTS.md"], { cwd: c1 }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "notes"], { cwd: c1 }).status, 0);
  const sent = await asSubagent(f, owner, c1, ["send", "request", "-"], "## Summary\nchild work");
  assert.equal(sent.code, 0, sent.out);
  assert.match(sent.out, /== pair: review from codex · claude-to-codex · round 1 · verdict approve ==/);
  const [call] = reviewerCalls(f);
  assert.equal(realpathSync(call.cwd), c1, "the reviewer runs in the subagent's worktree");
  assert.equal(call.args[call.args.indexOf("--add-dir") + 1], join(f.root, "home", channelName(c1)), "with that worktree's channel");
  assert.equal(call.env.owner, null, "a reviewer's commands act only on its own worktree");
  assert.match(call.args.at(-1), /## Review for your partner[\s\S]*Managed round: the pair CLI is/, "the rules come with the prompt");
  assert.equal(readFileSync(join(c1, "AGENTS.md"), "utf8"), stale, "no refresh in a served worktree");
  assert.ok(!existsSync(join(c1, ".claude")), "no pair init there");
  assert.equal(JSON.parse(readFileSync(join(owner, "author.json"), "utf8")).session, recorded, "the root's resume record is its own");

  const childStatus = (await inDir(f, c1, ["status"])).stdout;
  assert.match(childStatus, new RegExp(`auto mode: served by the session in ${realpathSync(f.root)} \\(owner \\d+\\)`));
  assert.match(childStatus, /served by another worktree's auto session, which gives its agents pair's rules: don't run pair init here/);
  assert.doesNotMatch(childStatus, /Run `pair init`/, "no advice to write pair's files into a served worktree");
  const status = (await f.command(["status"])).stdout;
  assert.match(status, /serves subagent worktrees · reviewers 1 · running 0 · queued 0/);
  await assert.rejects(inDir(f, c1, ["stop"]), /served by the auto session in .*run pair stop there, which stops the whole session/s);
  await assert.rejects(inDir(f, c1, ["reviewer", "--reviewer-model", "x"]), /run pair reviewer there to change the settings for new threads/);
  await assert.rejects(inDir(f, c1, ["reset", "--as", "claude"]), /cannot reset while auto mode or another reset owns this worktree/);
  // A purge would delete a live channel, the served worktree's or the session's own: refused, and nothing is removed.
  await assert.rejects(inDir(f, c1, ["uninit", "--purge"]), /cannot uninit --purge while auto mode/);
  assert.ok(existsSync(join(f.root, "home", channelName(c1))));
  await assert.rejects(f.command(["uninit", "--purge"]), /cannot uninit --purge while auto mode/);
  assert.ok(existsSync(join(f.root, "AGENTS.md")) && existsSync(f.stateDir()), "uninit didn't start");
  assert.equal(f.state().phase, "idle", "nothing in the subagent's worktree stopped the session");
});

for (const reviewers of [1, 2]) {
  test(`--serve-worktrees --reviewers ${reviewers}: one FIFO across worktrees${reviewers > 1 ? ", with rounds running at once" : ""}`, { timeout: 40_000 }, async (t) => {
    const { f, owner } = await served(t, { worker: "gated-release", pairArgs: ["--serve-worktrees", "--reviewers", String(reviewers)] });
    const [c1, c2] = [addChild(f, "c1"), addChild(f, "c2")];
    const first = asSubagent(f, owner, c1, ["send", "request", "-"], "c1 work");
    await until(() => reviewerCalls(f).length === 1, "c1 launched");
    const second = asSubagent(f, owner, c2, ["send", "request", "-"], "c2 work");
    if (reviewers === 1) {
      await until(() => f.state().served?.queued.length === 1, "c2 queued");
      assert.match((await f.command(["status"])).stdout, new RegExp(`running 1 · queued 1[\\s\\S]*running: ${c1} \\(thread \\S+, pid \\d+\\)[\\s\\S]*queued:  ${c2}`));
      assert.match((await inDir(f, c2, ["status"])).stdout, /served by the session in [\s\S]*  queued: thread \S+/);
      await pause(1000);
      assert.equal(reviewerCalls(f).length, 1, "the queued round waits for the slot");
    } else {
      await until(() => reviewerCalls(f).length === 2, "both rounds run at once");
    }
    writeFileSync(f.file("release"), "");
    for (const done of await Promise.all([first, second])) {
      assert.equal(done.code, 0, done.out);
      assert.match(done.out, /verdict approve/);
    }
    assert.deepEqual(reviewerCalls(f).map(({ cwd }) => realpathSync(cwd)), [c1, c2], "first come, first served");
  });
}

test("--serve-worktrees: retries attach to the round, simultaneous first contacts enroll once, and an older CLI's request means the root", { timeout: 40_000 }, async (t) => {
  const { f, owner } = await served(t, { worker: "gated-release", pairArgs: ["--serve-worktrees"] });
  const c1 = addChild(f, "c1");
  // Written without a managed review, then requested twice at once, as a send and its pair wait retry might.
  const plain = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "send", "request", "--as", "claude", "-"], { cwd: c1, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (data) => { out += data; });
    child.on("close", () => resolve(out));
    child.stdin.end("c1 work");
  });
  const file = plain.replace("sent: ", "").trim();
  const request = { action: "review", run: f.state().run, file, root: c1 };
  const both = Promise.all([f.call(request, 30_000), f.call(request, 30_000)]);
  await until(() => reviewerCalls(f).length === 1, "one launch");
  await pause(500);
  writeFileSync(f.file("release"), "");
  await both;
  assert.equal(reviewerCalls(f).length, 1, "both callers shared one round");
  assert.deepEqual(f.state().served.targets.filter((root) => root === c1), [c1], "one enrollment");
  await f.call(request, 5000); // a retry after the verdict returns it
  assert.equal(reviewerCalls(f).length, 1, "without relaunching");


  // An older CLI sends no root: the owner serves its own worktree, never a child.
  writeFileSync(f.file("root-body.md"), "root work");
  const rootFile = (await f.command(["send", "request", "--as", "claude", f.file("root-body.md")])).stdout.replace("sent: ", "").trim();
  await f.call({ action: "review", run: f.state().run, file: rootFile }, 30_000);
  assert.equal(realpathSync(reviewerCalls(f).at(-1).cwd), realpathSync(f.root));
  assert.deepEqual(f.state().served.targets, [realpathSync(f.root), c1]);
});

test("--serve-worktrees: one worktree's failed round is corrected there while another succeeds", { timeout: 40_000 }, async (t) => {
  const { f, owner } = await served(t, { worker: "fail-c1", reviewerModel: "BAD", pairArgs: ["--serve-worktrees", "--reviewers", "2"] });
  const [c1, c2] = [addChild(f, "c1"), addChild(f, "c2")];
  const [failedRound, goodRound] = await Promise.all([
    asSubagent(f, owner, c1, ["send", "request", "-"], "c1 work"),
    asSubagent(f, owner, c2, ["send", "request", "-"], "c2 work"),
  ]);
  assert.equal(failedRound.code, 1, failedRound.out);
  assert.match(failedRound.out, new RegExp(`unknown model BAD.*run pair reviewer --thread current with the new value in your own terminal, in ${c1}`, "s"));
  assert.match(goodRound.out, /verdict approve/);
  assert.match((await f.command(["status"])).stdout, new RegExp(`failed:  ${c1} thread \\S+: .*unknown model BAD`));
  const { stdout } = await inDir(f, c1, ["reviewer", "--thread", "current", "--reviewer-model", "good"]);
  assert.match(stdout, new RegExp(`model good · effort CLI default \\(was model BAD · effort CLI default\\)\\. .*Ask the subagent working in ${c1} to retry with pair wait\\.`));
  const retry = await asSubagent(f, owner, c1, ["wait", "--timeout", "1"]);
  assert.match(retry.out, /verdict approve/);
  const last = reviewerCalls(f).at(-1);
  assert.equal(realpathSync(last.cwd), c1);
  assert.equal(last.args[last.args.indexOf("--model") + 1], "good");
});

test("--serve-worktrees: a worktree removed while queued or running fails alone, and its reviewer is stopped", { timeout: 40_000 }, async (t) => {
  const { f, owner } = await served(t, { worker: "hang-c1", pairArgs: ["--serve-worktrees", "--reviewers", "2"] });
  const [c1, c2, c3] = [addChild(f, "c1"), addChild(f, "c2"), addChild(f, "c3")];
  const hung = asSubagent(f, owner, c1, ["send", "request", "-"], "c1 work");
  const sibling = asSubagent(f, owner, c2, ["send", "request", "-"], "c2 work");
  await until(() => reviewerCalls(f).length === 2 && existsSync(f.file("descendant.pid")), "both running");
  const queued = asSubagent(f, owner, c3, ["send", "request", "-"], "c3 work");
  await until(() => f.state().served?.queued.length === 1, "c3 queued");
  const descendant = Number(f.read("descendant.pid"));
  rmSync(c3, { recursive: true, force: true });
  rmSync(c1, { recursive: true, force: true });
  const removed = await hung;
  assert.equal(removed.code, 1);
  assert.match(removed.out, new RegExp(`worktree ${c1} was removed or replaced`));
  await until(() => !alive(descendant), "its reviewer's process group was stopped");
  writeFileSync(f.file("release"), "");
  assert.match((await sibling).out, /verdict approve/, "the sibling's round completes");
  const dropped = await queued;
  assert.equal(dropped.code, 1);
  assert.match(dropped.out, new RegExp(`worktree ${c3} was removed or replaced`));
  assert.equal(reviewerCalls(f).length, 2, "the removed queued worktree never launched");
});

test("--serve-worktrees: a worktree whose .git was replaced fails like a removed one, running and on retry", { timeout: 40_000 }, async (t) => {
  const { f, owner } = await served(t, { worker: "gated-release", pairArgs: ["--serve-worktrees"] });
  const c1 = addChild(f, "c1");
  const round = asSubagent(f, owner, c1, ["send", "request", "-"], "c1 work");
  await until(() => reviewerCalls(f).length === 1 && existsSync(f.file("worker.pid")), "c1 running");
  const worker = Number(f.read("worker.pid"));
  // Same directory and inode, but git now resolves it to another repository.
  rmSync(join(c1, ".git"), { force: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: c1 }).status, 0);
  const failed = await round;
  assert.equal(failed.code, 1);
  assert.match(failed.out, new RegExp(`worktree ${c1} was removed or replaced`));
  await until(() => !alive(worker), "its reviewer was stopped");
  writeFileSync(f.file("release"), "");
  const retry = await asSubagent(f, owner, c1, ["wait", "--timeout", "1"]);
  assert.equal(retry.code, 1);
  assert.match(retry.out, new RegExp(`worktree ${c1} was removed or replaced`), "a retry is refused too");
  assert.equal(reviewerCalls(f).length, 1);
});

test("--serve-worktrees: a slow git during enrollment doesn't stall the owner past the guardian's watchdog", { timeout: 45_000 }, async (t) => {
  // A git that takes 7s (more than the 5s watchdog) for the owner's first enrollment check in c1 only.
  const shims = mkdtempSync(join(tmpdir(), "pair-git-shim-"));
  t.after(() => rmSync(shims, { recursive: true, force: true }));
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(shims, "git"), `#!/bin/sh\ncase "$(pwd -P)" in *-c1) [ "$1 $2" = "rev-parse --show-toplevel" ] && sleep 7;; esac\nexec ${realGit} "$@"\n`);
  chmodSync(join(shims, "git"), 0o755);
  const { f, owner } = await served(t, { worker: "gated-release", pairArgs: ["--serve-worktrees", "--reviewers", "2"], extraEnv: { PATH: `${shims}:${process.env.PATH}` } });
  const [c1, c2] = [addChild(f, "c1"), addChild(f, "c2")];
  const sibling = asSubagent(f, owner, c2, ["send", "request", "-"], "c2 work");
  await until(() => reviewerCalls(f).length === 1, "c2 running");
  const slow = asSubagent(f, owner, c1, ["send", "request", "-"], "c1 work");
  await pause(7500); // through the slow enrollment
  assert.ok(alive(Number(f.read("author.pid"))), "the author survived");
  assert.notEqual(f.state().phase, "stopping");
  writeFileSync(f.file("release"), "");
  assert.match((await sibling).out, /verdict approve/, "the sibling's review survived");
  const enrolled = await slow;
  assert.equal(enrolled.code, 0, enrolled.out);
  assert.match(enrolled.out, /verdict approve/);
});

test("--serve-worktrees: stop settles running and queued rounds; claimed sockets go with the owner, even when it's killed", { timeout: 40_000 }, async (t) => {
  const { f, owner } = await served(t, { worker: "gated-release", pairArgs: ["--serve-worktrees"] });
  const [c1, c2] = [addChild(f, "c1"), addChild(f, "c2")];
  const first = asSubagent(f, owner, c1, ["send", "request", "-"], "c1 work");
  await until(() => reviewerCalls(f).length === 1, "c1 running");
  const second = asSubagent(f, owner, c2, ["send", "request", "-"], "c2 work");
  await until(() => f.state().served?.queued.length === 1, "c2 queued");
  assert.equal(readdirSync(f.socketDir).length, 3, "the owner's socket and two claims");
  await f.command(["stop"]);
  const [running, queued] = await Promise.all([first, second]);
  for (const done of [running, queued]) {
    assert.equal(done.code, 1);
    assert.match(done.out, /The request remains on disk/);
  }
  assert.match(running.out, /auto owner stopped/, "the guardian stopped the running reviewer");
  assert.match(queued.out, /auto mode stopped; review request remains on disk/, "the queued round never launched");
  await f.completed;
  assert.deepEqual(readdirSync(f.socketDir), [], "claims released");

  const killed = await served(t, { worker: "gated-release", pairArgs: ["--serve-worktrees"] });
  const c3 = addChild(killed.f, "c3");
  void asSubagent(killed.f, killed.owner, c3, ["send", "request", "-"], "c3 work");
  await until(() => readdirSync(killed.f.socketDir).length === 2, "c3 claimed");
  killed.f.launcher.kill("SIGKILL");
  await until(() => readdirSync(killed.f.socketDir).length === 0, "the guardian removes the owner's and the claimed socket");
});

test("--serve-worktrees: enrollment refuses what it can't validate", { timeout: 40_000 }, async (t) => {
  const { f, owner } = await served(t, { pairArgs: ["--serve-worktrees"] });
  const other = mkdtempSync(join(tmpdir(), "pair-other-repo-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: other });
  const foreign = await asSubagent(f, owner, realpathSync(other), ["send", "request", "-"], "x");
  assert.match(foreign.out, /can't serve .*: it isn't a worktree of .*'s repository/);

  const c1 = addChild(f, "c1");
  const channel = join(f.root, "home", channelName(c1));
  mkdirSync(channel, { recursive: true });
  writeFileSync(join(channel, "codex.session"), JSON.stringify({ thread: "11111111-1111-4111-8111-111111111111", worktree: c1, registeredAt: "x" }));
  const registered = await asSubagent(f, owner, c1, ["send", "request", "-"], "x");
  assert.match(registered.out, /a manual Codex session is registered there as codex; stop it and run pair unregister --as codex in it first/);

  // Another owner (or a reset) already holds the second worktree's socket.
  const c2 = addChild(f, "c2");
  const taken = createServer().listen(join(f.socketDir, `${createHash("sha256").update(join(f.root, "state", "pair", channelName(c2))).digest("hex").slice(0, 24)}.sock`));
  try {
    await new Promise((resolve) => taken.once("listening", resolve));
    const claimed = await asSubagent(f, owner, c2, ["send", "request", "-"], "x");
    assert.match(claimed.out, /another auto session or a reset owns it/);
  } finally {
    await new Promise((resolve) => taken.close(resolve)); // before the fixture checks that every socket is gone
  }
  assert.equal(reviewerCalls(f).length, 0);
});

// Named participants in auto mode: the words choose CLIs, the flags names. The fixture always passes --as.
const pairings = [
  { author: "claude", args: ["claude", "claude"], reviewer: "claude_reviewer", cli: "claude", restart: "claude claude" },
  { author: "codex", args: ["codex", "codex"], reviewer: "codex_reviewer", cli: "codex", restart: "codex codex" },
  { author: "alice", args: ["claude"], reviewer: "codex", cli: "codex", restart: "claude --as alice" },
  { author: "alice", args: ["claude", "--reviewer", "bob"], reviewer: "bob", cli: "codex", restart: "claude --as alice --reviewer bob" },
  { author: "alice", args: ["codex", "codex", "--reviewer", "bob"], reviewer: "bob", cli: "codex", restart: "codex codex --as alice --reviewer bob" },
  // A built-in name on the other CLI: names never pick a CLI once one is given.
  { author: "claude", args: ["codex"], reviewer: "claude_reviewer", cli: "claude", restart: "codex --as claude" },
  { author: "alice", args: ["claude", "codex", "--reviewer", "claude"], reviewer: "claude", cli: "codex", restart: "claude --as alice --reviewer claude" },
  // Explicit defaults are left out.
  { author: "codex", args: ["codex", "claude", "--reviewer", "claude"], reviewer: "claude", cli: "claude", restart: "codex" },
];
for (const { author, args, reviewer, cli, restart: pairing } of pairings) {
  test(`auto ${author} with ${args.join(" ")}: a full loop under the reviewer's name and CLI`, { timeout: 20_000 }, async (t) => {
    const f = fixture(t, { author, pairArgs: args });
    assert.equal((await f.completed).code, 0, f.output());
    assert.match(f.read("first.out"), new RegExp(`review from ${reviewer} · ${author}-to-${reviewer} · round 1 · verdict changes`));
    assert.match(f.read("second.out"), /verdict approve/);
    assert.match(f.read("third.out"), /verdict approve/);
    const calls = JSON.parse(f.read("calls.json"));
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.agent, reviewer);
      assert.ok(cli === "codex" ? call.args.includes("exec") : call.args.includes("-p"), `launched as ${cli}`);
      assert.match(call.args.at(-1), new RegExp(`You are ${reviewer}, a ${cli === "codex" ? "Codex" : "Claude Code"} reviewer[^\\n]*reviewing for ${author}`));
    }
    const resume = cli === "codex" ? "resume" : "--resume";
    assert.equal(calls[1].args[calls[1].args.indexOf(resume) + 1], "11111111-1111-4111-8111-000000000001", "a thread's later round resumes its reviewer");
    assert.ok(!calls[2].args.includes(resume), "a new thread gets a fresh reviewer conversation");
    assert.match((await f.command(["history"])).stdout, new RegExp(`${author}-to-${reviewer}\\s+approved`));
    // The restart command (known once the author's conversation is) starts with the pairing: the
    // author's CLI, then only what the defaults wouldn't give back.
    const restart = JSON.parse(readFileSync(join(f.stateDir(), "author.json"), "utf8")).restart;
    if (args[0] === "claude") {
      assert.ok(restart, "a new Claude author's restart command is known at launch");
      assert.match(JSON.parse(f.read("author.args.json")).at(-1), new RegExp(`pass --as ${author} --to ${reviewer},`), "each launch restates the pairing");
    }
    if (restart) {
      assert.ok(restart.includes(` && pair start ${pairing} --claude `), restart);
    }
  });
}

test("each pairing's restart form resolves to the same participants, whatever PAIR_AGENT says", () => {
  const root = mkdtempSync(join(tmpdir(), "pair-auto-pairing-"));
  const env = { ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", PAIR_AGENT: "", PAIR_AUTO_ROLE: "", PAIR_HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), PAIR_NO_UPDATE_CHECK: "1" };
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  // A registered Codex session stops pair start right after it prints the pairing, before anything starts.
  const summary = (args, extra) => {
    const result = run(["start", "--claude", process.execPath, "--codex", process.execPath, ...args], extra);
    assert.match(result.stderr, /registered here as codex/, result.stderr);
    return result.stderr.split("\n").filter((line) => /^pair: {3}(author|reviewer) /.test(line)).map((line) => line.split(" · ")[0]);
  };
  try {
    assert.equal(run(["register"], { CODEX_THREAD_ID: "11111111-2222-4333-8444-555555555555" }).status, 0);
    for (const { author, args, reviewer, cli, restart } of pairings) {
      const authorCli = args[0];
      const who = (name, of) => name === of ? of : `${name} (${of})`;
      const expected = [`pair:   author ${who(author, authorCli)}`, `pair:   reviewer ${who(reviewer, cli)}`];
      assert.deepEqual(summary(["--as", author, ...args]), expected, args.join(" "));
      assert.deepEqual(summary(restart.split(" "), { PAIR_AGENT: "zed", PAIR_PARTNER: "yan" }), expected, restart);
    }
    // The form without CLIs keeps its 0.9 meaning, PAIR_AGENT included.
    assert.deepEqual(summary(["--as", "codex"]), ["pair:   author codex", "pair:   reviewer claude"]);
    assert.deepEqual(summary([], { PAIR_AGENT: "codex" }), ["pair:   author codex", "pair:   reviewer claude"]);
    assert.deepEqual(summary(["--as", "claude", "--reviewer", "bob"]), ["pair:   author claude", "pair:   reviewer bob (codex)"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto mode with two Claude CLIs needs no Codex install", { timeout: 20_000 }, async (t) => {
  const f = fixture(t, { pairArgs: ["claude", "claude"], codexPath: "/nonexistent/codex" });
  assert.equal((await f.completed).code, 0, f.output());
  assert.match(f.read("third.out"), /verdict approve/);
});

test("pair start refuses an incomplete, unknown or self pairing", () => {
  const cases = [
    [[], /name the author's CLI: pair start claude\|codex/],
    [["--as", "alice"], /name the CLI that runs alice: pair start claude\|codex --as alice/],
    [["alice"], /the author's CLI must be claude or codex \(got "alice"\); participant names go in --as and --reviewer/],
    [["claude", "gemini"], /the reviewer's CLI must be claude or codex \(got "gemini"\)/],
    [["claude", "codex", "claude"], /at most two CLIs, the author's and the reviewer's/],
    [["claude", "--as", "alice", "--reviewer", "alice"], /must be a different participant/],
    [["claude", "--reviewer", "claude"], /must be a different participant/],
    [["--as", "claude", "--cli", "codex"], /Unknown option '--cli'/],
  ];
  for (const [args, pattern] of cases) {
    const result = spawnSync(process.execPath, [CLI, "start", ...args, "-y"], { cwd: tmpdir(), env: { ...process.env, CLAUDECODE: "", CODEX_THREAD_ID: "", PAIR_AUTO_ROLE: "" }, encoding: "utf8" });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, pattern, args.join(" "));
  }
  // Without a terminal, nothing asks: a custom PAIR_AGENT without a CLI is refused as before.
  const piped = spawnSync(process.execPath, [CLI, "start"], { cwd: tmpdir(), env: { ...process.env, CLAUDECODE: "", CODEX_THREAD_ID: "", PAIR_AUTO_ROLE: "", PAIR_AGENT: "alice" }, input: "1\n", encoding: "utf8" });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /name the CLI that runs alice/);
  assert.doesNotMatch(piped.stdout, /Author CLI/);
  const elsewhere = spawnSync(process.execPath, [CLI, "status", "--reviewer", "bob"], { cwd: tmpdir(), encoding: "utf8" });
  assert.match(elsewhere.stderr, /--reviewer is only supported by pair start/);
});

test("an auto session ignores unrelated lanes: an older unread approval elsewhere isn't its verdict", { timeout: 20_000 }, async (t) => {
  const f = fixture(t, {
    setup: ({ root, env }) => {
      const run = (args, input) => assert.equal(spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, input, encoding: "utf8" }).status, 0);
      run(["send", "request", "--as", "claude", "--to", "carol", "-"], "for carol");
      run(["send", "review", "--as", "carol", "--to", "claude", "--verdict", "approve", "-"], "carol approves");
    },
  });
  assert.equal((await f.completed).code, 0, f.output());
  assert.match(f.read("first.out"), /review from codex · claude-to-codex · round 1 · verdict changes/);
  assert.doesNotMatch(f.read("first.out"), /carol/);
  assert.match((await f.command(["wait", "--as", "claude", "--timeout", "1"])).stdout, /review from carol · claude-to-carol[\s\S]*approved and closed/, "still there for a manual wait");
});
