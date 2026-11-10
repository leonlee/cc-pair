import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { guideStart, guidedArgv, linePrompter } from "../dist/guide.js";
import { EFFORTS } from "../dist/auto.js";

/** Answers in order; undefined (or running out) cancels like Ctrl-C. Records every question and note. */
function scripted(answers) {
  const log = [];
  let next = 0;
  return {
    log,
    asked: () => log.filter((line) => line.startsWith("? ")).length,
    prompter: {
      async ask(question) { log.push(`? ${question}`); return answers[next++]; },
      say(text) { log.push(`! ${text}`); },
    },
  };
}

const facts = (overrides = {}) => ({
  installed: ["claude", "codex"],
  git: true,
  checkWorktree: (name) => { if (name.includes(" ")) throw new Error(`--worktree ${JSON.stringify(name)} is not a usable branch name`); },
  recorded: () => undefined,
  checkModel: (model) => { if (model.includes(" ")) throw new Error("--reviewer-model must be a nonempty model ID"); },
  efforts: EFFORTS,
  ...overrides,
});
const none = { resume: false, model: false, effort: false };

test("guided start: Enter takes every default after the author's CLI", async () => {
  const s = scripted(["1", "", "", "", ""]);
  assert.deepEqual(await guideStart(s.prompter, facts(), none), ["claude"]);
  assert.match(s.log[0], /^\? Author CLI: 1\) claude {2}2\) codex $/, "no default for the author");
  assert.match(s.log[1], /Reviewer CLI: .* \[codex\]/);
  assert.match(s.log[4], /Reviewer effort: 1\) codex's default {2}2\) none .* \[codex's default\]/);
});

test("guided start: every choice, answered by name or number, becomes its option", async () => {
  const recorded = (cli, worktree) => cli === "codex" && worktree === "feat" ? { id: "11111111-1111-4111-8111-111111111111", at: "2026-11-10T00:00:00.000Z" } : undefined;
  const s = scripted(["codex", "2", "feat", "y", "gpt-x", "high"]);
  assert.deepEqual(await guideStart(s.prompter, facts({ recorded }), none),
    ["codex", "codex", "--worktree", "feat", "--resume", "--reviewer-model", "gpt-x", "--reviewer-effort", "high"]);
  assert.match(s.log[3], /Resume the codex conversation 11111111-1111-4111-8111-111111111111 \(recorded 2026-11-10T00:00:00.000Z\)\? \[y\/N\]/);
});

test("guided start: an invalid answer explains and asks again, keeping earlier choices", async () => {
  const s = scripted(["3", "gemini", "2", "x", "", "feat x", "feat", "bad model", "opus", "9", "ultracode"]);
  assert.deepEqual(await guideStart(s.prompter, facts(), none),
    ["codex", "--worktree", "feat", "--reviewer-model", "opus", "--reviewer-effort", "ultracode"]);
  assert.ok(s.log.includes("! Choose 1 (claude) or 2 (codex)."));
  assert.ok(s.log.includes('! --worktree "feat x" is not a usable branch name'));
  assert.ok(s.log.includes("! --reviewer-model must be a nonempty model ID"));
});

test("guided start: a CLI that isn't installed can't be chosen, and is never a default", async () => {
  const s = scripted(["2", "1", "", "claude", "", "", ""]);
  assert.deepEqual(await guideStart(s.prompter, facts({ installed: ["claude"] }), none), ["claude", "claude"]);
  assert.match(s.log[0], /2\) codex \(not found\)/);
  assert.ok(s.log.includes("! codex was not found; choose another."));
  assert.doesNotMatch(s.log.find((line) => line.includes("Reviewer CLI")), /\[/, "no default reviewer: a same-CLI pair is chosen, not assumed");
  await assert.rejects(guideStart(scripted([]).prompter, facts({ installed: [] }), none), /neither claude nor codex was found/);
});

test("guided start: the command line's choices are kept and their questions skipped", async () => {
  const recorded = () => ({ id: "11111111-1111-4111-8111-111111111111", at: "x" });
  const s = scripted(["1", ""]);
  assert.deepEqual(await guideStart(s.prompter, facts({ recorded }), { worktree: "feat", resume: true, model: true, effort: true, envName: "alice" }),
    ["claude", "--as", "alice"]);
  assert.equal(s.asked(), 2, "only the CLIs");
  // Outside git there's no worktree to offer; without a record, no resume question.
  const outside = scripted(["1", "", "", ""]);
  assert.deepEqual(await guideStart(outside.prompter, facts({ git: false }), none), ["claude"]);
  assert.ok(!outside.log.some((line) => line.includes("Run in")));
  assert.ok(!outside.log.some((line) => line.includes("Resume")));
});

test("guided start: cancelling at any question stops at once", async () => {
  const recorded = () => ({ id: "11111111-1111-4111-8111-111111111111", at: "x" });
  const answers = ["1", "", "", "", "", ""];
  for (let at = 0; at < answers.length; at++) {
    const s = scripted(answers.slice(0, at));
    assert.equal(await guideStart(s.prompter, facts({ recorded }), none), undefined, `cancelled at question ${at + 1}`);
    assert.equal(s.asked(), at + 1, "no question after the cancelled one");
  }
});

test("guided start: the added arguments go right after the command word, before --", () => {
  const argv = ["--as", "alice", "start", "--reviewer-args=-c model_verbosity=low", "--", "--model", "it's", "--"];
  assert.deepEqual(guidedArgv(argv, 2, ["claude", "--worktree", "feat"]),
    ["--as", "alice", "start", "claude", "--worktree", "feat", "--reviewer-args=-c model_verbosity=low", "--", "--model", "it's", "--"]);
});

test("guided start's readline prompter: answers typed ahead wait for their question, and end of input cancels", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (data) => { shown += data; });
  const prompter = linePrompter(input, output);
  input.write("first\nsecond\n");
  assert.equal(await prompter.ask("one? "), "first");
  assert.equal(await prompter.ask("two? "), "second");
  input.end();
  assert.equal(await prompter.ask("three? "), undefined);
  assert.equal(await prompter.ask("four? "), undefined, "still cancelled");
  prompter.say("note");
  prompter.close();
  assert.match(shown, /one\? [\s\S]*two\? [\s\S]*note\n/);
});
