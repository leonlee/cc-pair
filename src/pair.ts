#!/usr/bin/env node
import { execFile, execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, type Dirent, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { authorSession, autoCall, autoSocketPath, checkStart, describeSession, errorMessage, autoStatus, hasCode, runGuardian, startAuto, stopAuto, withAutoStopped } from "./auto.js";

const AGENTS = ["claude", "codex"] as const;
type Agent = (typeof AGENTS)[number];
const MESSAGE_TYPES = ["request", "review", "response"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];
const VERDICTS = ["approve", "changes"] as const;
type Verdict = (typeof VERDICTS)[number];
const THREAD_STATUSES = ["open", "approved", "escalated"] as const;
type ThreadStatus = (typeof THREAD_STATUSES)[number];

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_KEEP = 100; // finished threads kept by auto-pruning
const DEFAULT_WAIT_SECONDS = 540; // stays under Claude Code's 10-minute Bash cap
const POLL_MS = 1000;
const MESSAGE_FILE = /^(\d{3})-(request|review|response)\.md$/;
// archive/<thread id>-<author>-to-<reviewer>-<outcome>; the id starts with a timestamp
const ARCHIVED_THREAD = /^(.+)-(claude|codex)-to-(claude|codex)-(approved|escalated)$/;
const PAIR_SECTION = /<!-- pair:start -->[\s\S]*?<!-- pair:end -->\n?/;
const PAIR_SECTIONS = /<!-- pair:start -->[\s\S]*?<!-- pair:end -->(?:\r?\n)?/g; // for removal, CRLF too
// SKILL.md as released versions wrote it (0.1.0 and 0.1.1), so `uninit` can tell it from an edited one.
const RELEASED_SKILL_SHA256 = ["e9afb64c53d5e90f935bcb66406601a31a91b37758467cf867713e245f8af288"];
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE: { name: string; version: string } = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
// Which pair wrote an instruction file, so an older pair never rolls back what a newer one wrote.
const STAMP = /<!-- pair (\S+) -->\n/;
// Commands that refresh stale instructions. Not status (a read-only diagnosis) or mcp (unsandboxed, so it only reads).
const REFRESHING_COMMANDS = ["send", "wait", "history", "clean", "register", "unregister"];
// A managed reviewer handles one round. Cleanup, setup and lifecycle commands stay the user's.
const REVIEWER_COMMANDS = ["wait", "send", "status", "history"];
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // any UUID version; Codex uses v7
const SESSION_FILE = "codex.session"; // the Codex session that pair_listen may notify, per channel
const LISTEN_LOG = "codex.listen.log";
const LISTEN_LOG_MAX_BYTES = 256 * 1024; // then it becomes codex.listen.log.1, replacing the previous one
const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STALL_MS = 10 * 60 * 1000;
const QUEUE_TIMEOUT_MS = 30_000;
const CLAIM_LEASE_MS = 2 * QUEUE_TIMEOUT_MS; // longer than any live `codex queue` call can hold a claim
// Fixed text on purpose: nothing from the channel may reach Codex as user input.
const NUDGE =
  "pair: a message is waiting for you. Run `pair wait --as codex --timeout 5`, act on what it prints as the pair instructions in AGENTS.md describe, send your reply if one is due, then end your turn. Don't start another pair wait.";

interface Message {
  file: string;
  from: Agent;
  type: MessageType;
  round: number;
  verdict?: Verdict;
  status: ThreadStatus;
  body: string;
}

type ThreadState =
  | { kind: "idle" }
  | { kind: "awaiting-review"; last: Message }
  | { kind: "awaiting-response"; last: Message }
  | { kind: "closed"; last: Message };
type ActiveState = Exclude<ThreadState, { kind: "idle" }>;

interface Thread {
  lane: string; // <author>-to-<reviewer>/, holding one subdirectory per review thread
  author: Agent;
  reviewer: Agent;
}

class PairError extends Error {}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function sandboxConfig(channel: string): string {
  const pairHome = JSON.stringify(dirname(channel));
  return [
    "Both agents need read and write access to the channel. Sandbox configuration:",
    "",
    "  ~/.codex/config.toml",
    "    [sandbox_workspace_write]",
    `    writable_roots = [${pairHome}]`,
    "",
    "  ~/.claude/settings.json",
    `    "sandbox": { "filesystem": { "allowWrite": [${pairHome}] } }`,
  ].join("\n");
}

/** Only call this for channel operations; input files and installed assets have other remedies. */
function channelError(channel: string, error: unknown): unknown {
  if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
    const path = "path" in error ? String(error.path) : channel;
    return new PairError(
      `cannot access channel path ${path} (${error.code}). Check filesystem permissions and sandbox restrictions.\n${sandboxConfig(channel)}`,
    );
  }
  return error;
}

function channelAccess<T>(channel: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw channelError(channel, error);
  }
}

function positiveNumber(value: string, what: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PairError(`${what} must be a positive number (got "${value}")`);
  }
  return parsed;
}

function maxRounds(): number {
  return positiveNumber(process.env.PAIR_MAX_ROUNDS ?? String(DEFAULT_MAX_ROUNDS), "PAIR_MAX_ROUNDS");
}

function partnerOf(agent: Agent): Agent {
  return agent === "claude" ? "codex" : "claude";
}

function threadFor(channel: string, author: Agent): Thread {
  const reviewer = partnerOf(author);
  return { lane: join(channel, `${author}-to-${reviewer}`), author, reviewer };
}

function readdirOrEmpty(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    // No lane dir yet means no thread has been started in it.
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

/** Each thread gets a fresh directory, so a stale archive can never move a newer thread. */
function currentThreadDir(thread: Thread): string | undefined {
  const entries = readdirOrEmpty(thread.lane);
  const legacy = entries.find((entry) => entry.isFile() && MESSAGE_FILE.test(entry.name));
  if (legacy) {
    throw new PairError(
      `${thread.lane} still uses the old flat layout (${legacy.name}). Move its NNN-*.md files into a new subdirectory of it, or stop the agents and run pair reset --as ${thread.author} to back it up and clear the lane.`,
    );
  }
  const latest = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  return latest === undefined ? undefined : join(thread.lane, latest);
}

function newThreadId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

function gitPath(flag: string, cwd?: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", flag], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not inside a git repo; callers fall back to the current directory.
    return undefined;
  }
}

function worktreeRoot(): string {
  return realpathSync(gitPath("--show-toplevel") ?? process.cwd());
}

/** A relative PAIR_HOME resolves against the worktree root, not cwd, so every subdirectory finds one channel. */
function pairHome(root: string): string {
  const configured = process.env.PAIR_HOME;
  return configured ? resolve(root, configured) : join(homedir(), ".pair"); // empty means unset
}

/** pair start --worktree NAME: where it runs, and the git worktree add arguments when it doesn't exist yet. */
interface WorktreePlan {
  name: string;
  path: string;
  add?: string[];
}

function git(args: string[], cwd: string): SpawnSyncReturns<string> {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new PairError(`couldn't run git: ${result.error.message}`);
  }
  return result;
}

// feature/x and feature-x share a path, a reused worktree may have been switched, and a tag named NAME
// can win over a branch. The full ref, since --short abbreviates a branch to heads/NAME when a tag is also NAME.
function checkBranch(path: string, name: string, what: string): void {
  const head = git(["symbolic-ref", "--quiet", "HEAD"], path).stdout.trim();
  if (head !== `refs/heads/${name}`) {
    const actual = head.startsWith("refs/heads/") ? `branch ${head.slice("refs/heads/".length)}` : "a detached HEAD";
    throw new PairError(`${path} ${what} ${actual} checked out, not ${name}; switch it there yourself, or pick another --worktree name`);
  }
}

/** An existing path must be a worktree of this repository with NAME checked out; pair never switches it. */
function checkReused(root: string, path: string, name: string): void {
  const top = gitPath("--show-toplevel", path);
  if (!top || realpathSync(top) !== realpathSync(path) || gitPath("--git-common-dir", path) !== gitPath("--git-common-dir", root)) {
    throw new PairError(`${path} already exists and isn't a worktree of this repository`);
  }
  checkBranch(path, name, "has");
}

/** ../<repo>-NAME on branch NAME, created from HEAD on first use and reused after. Checks only; changes nothing. */
function planWorktree(root: string, name: string): WorktreePlan {
  if (!gitPath("--show-toplevel")) {
    throw new PairError("--worktree needs a git repository");
  }
  // The regex keeps the name usable as a path and out of git's option and @{-N} syntax; git checks the rest.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || git(["check-ref-format", "--branch", name], root).status !== 0) {
    throw new PairError(`--worktree ${JSON.stringify(name)} is not a usable branch name`);
  }
  const path = join(dirname(root), `${basename(root)}-${name.replaceAll("/", "-")}`);
  if (existsSync(path)) {
    checkReused(root, path, name);
    return { name, path };
  }
  const ok = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref], root).status === 0;
  if (ok(`refs/heads/${name}`)) {
    return { name, path, add: [path, name] };
  }
  // Name the remote ref outright: given a bare NAME, git prefers a tag of that name over tracking a remote branch.
  const remotes = git(["remote"], root).stdout.split("\n").filter((remote) => remote && ok(`refs/remotes/${remote}/${name}`));
  const preferred = git(["config", "checkout.defaultRemote"], root).stdout.trim();
  const remote = remotes.length === 1 ? remotes[0] : remotes.find((candidate) => candidate === preferred);
  if (remotes.length > 1 && !remote) {
    throw new PairError(`branch ${name} exists on several remotes (${remotes.join(", ")}); set checkout.defaultRemote, or create the local branch yourself`);
  }
  return { name, path, add: remote ? ["--track", "-b", name, path, `refs/remotes/${remote}/${name}`] : ["-b", name, path] };
}

/** Creates the planned worktree if needed, or checks the reused one again; returns its real path. */
function openWorktree(root: string, plan: WorktreePlan): string {
  const { name, path } = plan;
  if (plan.add) {
    const add = spawnSync("git", ["worktree", "add", ...plan.add], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
    if (add.error || add.status !== 0) {
      throw new PairError(`git worktree add ${path} failed`);
    }
    checkBranch(path, name, "was created with");
  } else {
    checkReused(root, path, name); // again: it may have changed while pair start waited for Enter
  }
  const worktree = realpathSync(path);
  console.error(`pair: this session runs in worktree ${worktree}; run pair status and pair stop there`);
  return worktree;
}

/** Whether the agents in root lack pair's instructions; a new branch has only what was committed. */
function needsInit(root: string): boolean {
  return instructionState(join(root, ".claude", "skills", "pair", "SKILL.md"), claudeSkill()) === "missing"
    || instructionState(join(root, "AGENTS.md"), codexSection(), true) === "missing";
}

/** Enter or y accepts; anything else, Ctrl-C or end of input cancels. Releases stdin before the author takes the terminal. */
async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await new Promise<boolean>((resolve) => {
      const cancel = () => {
        process.stdout.write("\n");
        resolve(false);
      };
      prompt.once("SIGINT", cancel);
      prompt.once("close", cancel);
      prompt.question(question, (answer) => resolve(/^(y|yes)?$/i.test(answer.trim())));
    });
  } finally {
    prompt.removeAllListeners();
    prompt.close();
    process.stdin.pause();
  }
}

function channelDir(root: string): string {
  // One channel per worktree: a reviewer reads the author's files, so both must share a checkout.
  // realpath so /tmp/x and /private/tmp/x (or any symlinked checkout) share one channel.
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return join(pairHome(root), `${basename(root)}-${hash}`);
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    return { fields: {}, body: text };
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return { fields, body: text.slice(match[0].length) };
}

/** Parses a stored message and rejects anything the CLI would not have written. */
function readMessage(path: string, thread: Thread): Message {
  const { fields, body } = parseFrontmatter(readChannelFile(path));
  const corrupt = `corrupt message ${path}:`;
  const type = oneOf(fields.type, MESSAGE_TYPES, `${corrupt} type`);
  if (!basename(path).endsWith(`-${type}.md`)) {
    throw new PairError(`${corrupt} type "${type}" does not match the file name`);
  }
  const from = oneOf(fields.from, [type === "review" ? thread.reviewer : thread.author], `${corrupt} from`);
  const round = Number(fields.round);
  if (!Number.isInteger(round) || round < 1) {
    throw new PairError(`${corrupt} round must be a positive integer (got "${fields.round}")`);
  }
  const status = oneOf(fields.status, THREAD_STATUSES, `${corrupt} status`);
  const verdict = type === "review" ? oneOf(fields.verdict, VERDICTS, `${corrupt} verdict`) : undefined;
  const consistent = verdict === "approve" ? status === "approved" : verdict === "changes" ? status !== "approved" : status === "open";
  if (!consistent) {
    throw new PairError(`${corrupt} status "${status}" does not fit verdict "${verdict ?? "none"}"`);
  }
  return { file: path, from, type, round, verdict, status, body };
}

function readThread(dir: string, thread: Thread): Message[] {
  return readdirSync(dir)
    .filter((name) => MESSAGE_FILE.test(name))
    .sort()
    .map((name) => readMessage(join(dir, name), thread));
}

function listMessages(thread: Thread): Message[] {
  const dir = currentThreadDir(thread);
  if (!dir) {
    return [];
  }
  try {
    return readThread(dir, thread);
  } catch (error) {
    // The author's wait archived this thread mid-read, so it is closed and gone.
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

function stateOf(messages: Message[]): ThreadState {
  const last = messages.at(-1);
  if (!last) {
    return { kind: "idle" };
  }
  if (last.type !== "review") {
    return { kind: "awaiting-review", last };
  }
  return last.status === "open" ? { kind: "awaiting-response", last } : { kind: "closed", last };
}

/** Digits only: Number("") is 0, so an empty value must never reach the conversion. */
function parseKeep(value: string, what: string): number {
  if (!/^\d+$/.test(value)) {
    throw new PairError(`${what} must be a whole number of finished threads to keep (got "${value}")`);
  }
  return Number(value);
}

/** How many finished threads auto-pruning keeps. Undefined means keep them all. */
function autoKeep(): number | undefined {
  const value = process.env.PAIR_KEEP;
  if (value === undefined) {
    return DEFAULT_KEEP;
  }
  return value === "all" ? undefined : parseKeep(value, "PAIR_KEEP");
}

/** Deletes all but the `keep` newest finished threads. Returns how many were removed. */
function prune(channel: string, keep: number): number {
  const doomed = listArchived(channel).slice(keep);
  for (const entry of doomed) {
    rmSync(entry.dir, { recursive: true, force: true });
  }
  return doomed.length;
}

function archive(channel: string, last: Message): void {
  const dir = dirname(last.file);
  const archiveDir = join(channel, "archive");
  mkdirSync(archiveDir, { recursive: true });
  try {
    renameSync(dir, join(archiveDir, `${basename(dir)}-${basename(dirname(dir))}-${last.status}`));
  } catch (error) {
    // Another wait for the same agent already archived this exact thread.
    if (!isMissing(error)) {
      throw error;
    }
  }
  const keep = autoKeep();
  if (keep === undefined) {
    return;
  }
  try {
    prune(channel, keep);
  } catch (error) {
    // Cleanup is housekeeping. It must never block delivering a result or starting a thread.
    const failure = channelError(channel, error);
    const reason = errorMessage(failure);
    console.error(`pair: warning: automatic cleanup failed: ${reason}\nFix it, then run \`pair clean --keep ${keep}\`.`);
  }
}

function writeMessage(dir: string, seq: number, message: Omit<Message, "file" | "body">, body: string): string {
  mkdirSync(dir, { recursive: true });
  const name = `${String(seq).padStart(3, "0")}-${message.type}.md`;
  const lines = [
    "---",
    `from: ${message.from}`,
    `type: ${message.type}`,
    `round: ${message.round}`,
    ...(message.verdict ? [`verdict: ${message.verdict}`] : []),
    `status: ${message.status}`,
    "---",
    body.trimEnd(),
    "",
  ];
  const finalPath = join(dir, name);
  const tmpPath = join(dir, `.${name}.tmp`);
  writeFileSync(tmpPath, lines.join("\n"));
  renameSync(tmpPath, finalPath); // atomic: readers never see a half-written message
  return finalPath;
}

function send(channel: string, me: Agent, type: MessageType, body: string, verdict?: Verdict): string {
  if (type === "review") {
    return sendReview(channel, me, body, verdict);
  }
  const thread = threadFor(channel, me);
  const messages = listMessages(thread);
  const state = stateOf(messages);
  if (type === "request") {
    if (state.kind === "awaiting-review" || state.kind === "awaiting-response") {
      throw new PairError(`a review thread to ${thread.reviewer} is already open (${state.kind}); finish it first, or stop the agents and manually run pair reset --as ${me} to back up and clear this lane`);
    }
    if (state.kind === "closed") {
      archive(channel, state.last);
    }
    return writeMessage(join(thread.lane, newThreadId()), 1, { from: me, type, round: 1, status: "open" }, body);
  }
  if (state.kind !== "awaiting-response") {
    throw new PairError(`cannot send response: no open review from ${thread.reviewer} (thread is ${state.kind})`);
  }
  const round = state.last.round + 1;
  return writeMessage(dirname(state.last.file), messages.length + 1, { from: me, type, round, status: "open" }, body);
}

function sendReview(channel: string, me: Agent, body: string, verdict?: Verdict): string {
  if (!verdict) {
    throw new PairError(`review needs --verdict ${VERDICTS.join("|")}`);
  }
  const thread = threadFor(channel, partnerOf(me));
  const messages = listMessages(thread);
  const state = stateOf(messages);
  if (state.kind !== "awaiting-review") {
    throw new PairError(`cannot send review: nothing from ${thread.author} is waiting for review (thread is ${state.kind})`);
  }
  if (process.env.PAIR_AUTO_ROLE === "reviewer" && state.last.file !== process.env.PAIR_AUTO_MESSAGE) {
    throw new PairError("managed reviewer cannot reply to a different message");
  }
  const round = state.last.round;
  const status: ThreadStatus = verdict === "approve" ? "approved" : round >= maxRounds() ? "escalated" : "open";
  const review = { from: me, type: "review" as const, round, verdict, status };
  const path = writeMessage(dirname(state.last.file), messages.length + 1, review, body);
  return status === "escalated" ? `${path}\n${escalationNotice()}` : path;
}

function escalationNotice(): string {
  return `ESCALATED: round cap (${maxRounds()}) reached with open findings. STOP and ask the user how to proceed.`;
}

/** Returns a thread where it is `me`'s turn to act, if any. Author duties come first. */
interface Pending {
  thread: Thread;
  state: ActiveState;
  earlier: Message[]; // from the same snapshot as state, so output never rereads the disk
}

function pendingFor(channel: string, me: Agent): Pending | undefined {
  if (process.env.PAIR_AUTO_ROLE === "reviewer") {
    const thread = threadFor(channel, partnerOf(me));
    const messages = listMessages(thread);
    const state = stateOf(messages);
    return state.kind === "awaiting-review" && state.last.file === process.env.PAIR_AUTO_MESSAGE
      ? { thread, state, earlier: messages.slice(0, -1) } : undefined;
  }
  const asAuthor = threadFor(channel, me);
  const authorMessages = listMessages(asAuthor);
  const authorState = stateOf(authorMessages);
  if (authorState.kind === "awaiting-response" || authorState.kind === "closed") {
    return { thread: asAuthor, state: authorState, earlier: authorMessages.slice(0, -1) };
  }
  const asReviewer = threadFor(channel, partnerOf(me));
  const reviewerMessages = listMessages(asReviewer);
  const reviewerState = stateOf(reviewerMessages);
  if (reviewerState.kind === "awaiting-review") {
    return { thread: asReviewer, state: reviewerState, earlier: reviewerMessages.slice(0, -1) };
  }
  return undefined;
}

function nextStep(me: Agent, state: ActiveState): string {
  switch (state.kind) {
    case "awaiting-review":
      return `review it, then: pair send review --verdict approve|changes --as ${me} <file|->`;
    case "awaiting-response":
      return `verify each finding yourself, fix or reject it, then: pair send response --as ${me} <file|->`;
    case "closed":
      return state.last.status === "approved"
        ? "thread approved and closed. Nothing to send."
        : escalationNotice();
  }
}

/** Points an agent that lost its context (e.g. after a restart) at the rest of the thread. */
function historyLine({ state, earlier }: Pending): string | undefined {
  // A closed thread is archived as soon as it's read and needs no further action.
  if (state.kind === "closed" || earlier.length === 0) {
    return undefined;
  }
  const names = earlier.map((message) => basename(message.file)).join(" ");
  return `== earlier in this thread (read them first if they're not in your context): ${dirname(state.last.file)}/ ${names} ==`;
}

function messageHeader(message: Message, laneName: string): string {
  const verdict = message.verdict ? ` · verdict ${message.verdict}` : "";
  return `== pair: ${message.type} from ${message.from} · ${laneName} · round ${message.round}${verdict} ==`;
}

function formatMessage(me: Agent, pending: Pending): string {
  const { thread, state } = pending;
  const { last } = state;
  const header = messageHeader(last, basename(thread.lane));
  const history = historyLine(pending);
  return [header, ...(history ? [history] : []), last.body.trimEnd(), `== next: ${nextStep(me, state)} ==`].join("\n");
}

/**
 * Prints the message, then archives a closed thread. Archiving last keeps the `== pair:` header on
 * the first line even when cleanup warns on stderr, since agents read stdout and stderr merged.
 */
async function wait(channel: string, me: Agent, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const pending = channelAccess(channel, () => pendingFor(channel, me));
    if (pending) {
      console.log(formatMessage(me, pending));
      if (pending.state.kind === "closed") {
        channelAccess(channel, () => archive(channel, pending.state.last));
      }
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(POLL_MS);
  }
}

interface Registration {
  thread: string; // Codex session id, from CODEX_THREAD_ID in the session's own shell
  worktree: string;
  registeredAt: string;
}

/**
 * `pair mcp` runs outside the agents' sandboxes, but agents can write the channel. So the files it
 * opens there must never be symlinks, or an agent could make it read or write any file.
 */
function openChannelFile(path: string, flags: number): number {
  try {
    return openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (hasCode(error, "ELOOP")) {
      throw new PairError(`refusing to follow the symlink at ${path}`);
    }
    throw error;
  }
}

function readChannelFile(path: string): string {
  const fd = openChannelFile(path, constants.O_RDONLY);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writeChannelFile(path: string, text: string, flags: number): void {
  const fd = openChannelFile(path, constants.O_WRONLY | constants.O_CREAT | flags);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

function readRegistration(channel: string): Registration | undefined {
  const path = join(channel, SESSION_FILE);
  let parsed: Partial<Registration>;
  try {
    parsed = JSON.parse(readChannelFile(path)) as Partial<Registration>;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error instanceof SyntaxError ? new PairError(`corrupt registration ${path}: ${error.message}`) : error;
  }
  const { thread, worktree, registeredAt } = parsed;
  if (typeof thread !== "string" || !SESSION_ID.test(thread) || typeof worktree !== "string" || typeof registeredAt !== "string") {
    throw new PairError(`corrupt registration ${path}: expected thread, worktree and registeredAt`);
  }
  return { thread, worktree, registeredAt };
}

/** The calling Codex session, or undefined outside Codex. */
function codexThreadId(): string | undefined {
  const id = process.env.CODEX_THREAD_ID;
  if (id === undefined || id === "") {
    return undefined;
  }
  if (!SESSION_ID.test(id)) {
    throw new PairError(`CODEX_THREAD_ID is not a session id (got "${id}")`);
  }
  return id;
}

/** Runs in Codex's shell, so the worktree comes from the session's real cwd, not from a tool argument. */
function register(channel: string, root: string): string {
  const thread = codexThreadId();
  if (!thread) {
    throw new PairError("register must run in a Codex session's shell: CODEX_THREAD_ID is not set");
  }
  const previous = readRegistration(channel);
  mkdirSync(channel, { recursive: true });
  const registration: Registration = { thread, worktree: root, registeredAt: new Date().toISOString() };
  const tmpPath = join(channel, `.${SESSION_FILE}.${randomBytes(3).toString("hex")}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(registration)}\n`);
  renameSync(tmpPath, join(channel, SESSION_FILE));
  const replaced = previous && previous.thread !== thread ? ` (replaced ${previous.thread})` : "";
  return `registered codex session ${thread} for ${root}${replaced}. Now call the pair_listen tool.`;
}

function unregister(channel: string): string {
  const current = readRegistration(channel);
  if (!current) {
    return "no codex session is registered for this worktree";
  }
  const caller = codexThreadId();
  // An old session saying "stop" must not silence a newer one. A shell outside Codex is the user.
  if (caller !== undefined && caller !== current.thread) {
    throw new PairError(`a different codex session (${current.thread}) is registered here; nothing changed`);
  }
  // ponytail: check-then-delete; a re-register in the same instant would be removed too. status shows it.
  rmSync(join(channel, SESSION_FILE), { force: true });
  return `unregistered codex session ${current.thread}: pair stops notifying it`;
}

/** Keeps the log to at most two files, so a long-lived channel doesn't grow without bound. */
function rotateLog(path: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats && !stats.isFile()) {
    rmSync(path, { force: true }); // a symlink planted here: remove the link itself, never its target
    return;
  }
  if ((stats?.size ?? 0) <= LISTEN_LOG_MAX_BYTES) {
    return;
  }
  try {
    renameSync(path, `${path}.1`);
  } catch (error) {
    if (!isMissing(error)) {
      throw error; // ENOENT: another server rotated it first
    }
  }
}

/**
 * Where `pair mcp` keeps its own files, the log and the claims: outside every agent's writable roots.
 * Agents can write the channel, and could swap a directory on a channel path for a symlink between
 * any check and the write that follows, so the unsandboxed server only ever reads channels.
 */
function stateDir(channel: string): string {
  return join(stateHome(), basename(channel));
}

function stateHome(): string {
  const configured = process.env.XDG_STATE_HOME;
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".local", "state");
  return join(resolve(root), "pair");
}

function logListen(channel: string, text: string): void {
  try {
    const path = join(stateDir(channel), LISTEN_LOG);
    mkdirSync(dirname(path), { recursive: true });
    rotateLog(path);
    const singleLine = JSON.stringify(text).slice(1, -1); // escape control characters in agent-chosen paths
    writeChannelFile(path, `${new Date().toISOString()} ${singleLine}\n`, constants.O_APPEND);
  } catch (error) {
    console.error(`pair: cannot write ${LISTEN_LOG}: ${String(error)}\n${text}`); // stderr: stdout is the MCP stream
  }
}

interface Watch {
  channel: string;
  codex: string; // pinned executable, see pinnedCodex()
  notified?: string; // the pending message file the last successful nudge was about
  notifiedAt: number;
  stallReported: boolean;
  dispatching: boolean;
  failures: number;
  retryAt: number;
}

/**
 * The MCP server runs outside Codex's sandbox, so it must not run whatever `codex` PATH points at:
 * an agent-writable PATH entry would turn the fixed queue call into unsandboxed code execution.
 */
function pinnedCodex(): string {
  const path = process.env.PAIR_CODEX;
  if (!path || !isAbsolute(path)) {
    throw new PairError("PAIR_CODEX must be the absolute path of the codex executable. Re-add the MCP server with the command `pair init` prints.");
  }
  return path;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // doesn't exist (yet); compare it as written
  }
}

/**
 * For `init`: the codex a shell here would run, unless it is, or links to, a file in a place agents
 * can write: the worktree, the channels, or a temporary directory.
 */
function findCodex(root: string): string | undefined {
  const untrusted = [root, pairHome(root), tmpdir(), process.env.TMPDIR, "/tmp", "/var/tmp"]
    .filter((dir): dir is string => Boolean(dir))
    .flatMap((dir) => [resolve(dir), realpathOrSelf(dir)]);
  const agentWritable = (path: string): boolean =>
    untrusted.some((dir) => path === dir || path.startsWith(`${dir}${sep}`));
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) {
      continue;
    }
    const candidate = join(dir, "codex");
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue; // not in this PATH entry
    }
    return agentWritable(candidate) || agentWritable(realpathSync(candidate)) ? undefined : candidate;
  }
  return undefined;
}

/** Finds the one channel where this session ran `pair register`. Thread id comes from trusted call metadata. */
function listen(thread: unknown, watches: Map<string, Watch>): string {
  if (typeof thread !== "string" || !SESSION_ID.test(thread)) {
    throw new PairError("the tool call carried no Codex session id (_meta.threadId), so pair can't notify this session");
  }
  const codex = pinnedCodex();
  const home = pairHome(process.cwd()); // the server has no worktree; `pair init` passes an absolute PAIR_HOME
  const registered = readdirOrEmpty(home)
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(home, entry.name))
    .filter((channel) => {
      try {
        return readRegistration(channel)?.thread === thread;
      } catch {
        return false; // another channel's corrupt registration is that channel's problem; status reports it
      }
    });
  if (registered.length === 0) {
    throw new PairError("this session isn't registered: run `pair register` in your shell, then call pair_listen again");
  }
  if (registered.length > 1) {
    throw new PairError(`this session is registered in ${registered.length} channels (${registered.join(", ")}); run \`pair unregister\` in the worktrees you don't want`);
  }
  const [channel] = registered;
  if (watches.get(thread)?.channel !== channel) {
    watches.set(thread, { channel, codex, notifiedAt: 0, stallReported: false, dispatching: false, failures: 0, retryAt: 0 });
    logListen(channel, `listening for ${thread}`);
    pruneClaims(channel);
  }
  return `listening: pair will queue a short "pair:" note into this session when a message for codex arrives in ${channel}. End your turn now.`;
}

/**
 * One nudge per session and message, even with several MCP processes on one session. It says
 * "sending" while a server holds the right to send, and "sent" once `codex queue` succeeded.
 */
function claimPath(channel: string, thread: string, pending: string): string {
  return join(stateDir(channel), "claims", `${basename(dirname(pending))}.${basename(pending)}.${thread}`);
}

/** Claims outlive their threads, so old ones are dropped. A still-pending message may get one more note. */
function pruneClaims(channel: string): void {
  const dir = join(stateDir(channel), "claims");
  try {
    for (const entry of readdirOrEmpty(dir)) {
      const path = join(dir, entry.name);
      const stats = lstatSync(path, { throwIfNoEntry: false });
      if (stats && Date.now() - stats.mtimeMs > CLAIM_MAX_AGE_MS) {
        rmSync(path, { force: true });
      }
    }
  } catch (error) {
    logListen(channel, `couldn't prune old claims: ${String(error)}`);
  }
}

type Claim = "claimed" | "sent" | "busy";

/** Exclusive create: true if this server now holds the claim. O_EXCL never follows a symlink. */
function createClaim(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeChannelFile(path, "sending\n", constants.O_EXCL);
    return true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
    return false;
  }
}

function claim(path: string): Claim {
  if (createClaim(path)) {
    return "claimed";
  }
  const stats = lstatSync(path);
  if (stats.isFile() && readChannelFile(path).trim() === "sent") {
    return "sent";
  }
  if (stats.isFile() && Date.now() - stats.mtimeMs < CLAIM_LEASE_MS) {
    return "busy"; // another server is sending; if it fails it removes the claim and we try again
  }
  // Its sender died mid-send, or this isn't a plain file (say, a planted symlink). Unlinking removes
  // the entry itself, never a link's target. ponytail: two servers taking over at the same moment
  // may both send, which costs one extra short turn; a lock for the takeover would be the upgrade.
  rmSync(path, { force: true });
  return createClaim(path) ? "claimed" : "busy";
}

/** Replaces the claim's directory entry, so a symlink put there is replaced, not written through. */
function markSent(path: string): void {
  const tmpPath = `${path}.${randomBytes(3).toString("hex")}.tmp`;
  writeChannelFile(tmpPath, "sent\n", constants.O_EXCL);
  renameSync(tmpPath, path);
}

function dispatch(thread: string, watch: Watch, pending: string): void {
  watch.dispatching = true;
  const child = execFile(watch.codex, ["queue", "--thread", thread, "--message", NUDGE], { timeout: QUEUE_TIMEOUT_MS }, (error, _stdout, stderr) => {
    watch.dispatching = false;
    if (error) {
      rmSync(claimPath(watch.channel, thread, pending), { force: true }); // let the retry, here or in another process, claim it again
      watch.failures += 1;
      const delay = Math.min(60_000, 1000 * 2 ** watch.failures);
      watch.retryAt = Date.now() + delay;
      logListen(watch.channel, `codex queue failed for ${pending}, retrying in ${delay / 1000}s: ${stderr.trim() || error.message}`);
      return;
    }
    Object.assign(watch, { notified: pending, notifiedAt: Date.now(), stallReported: false, failures: 0 });
    logListen(watch.channel, `notified ${thread} about ${pending}`);
    try {
      markSent(claimPath(watch.channel, thread, pending));
    } catch (claimError) {
      if (!isMissing(claimError)) {
        logListen(watch.channel, `couldn't mark ${pending} as sent, so another server may send it again: ${String(claimError)}`);
      }
    }
  });
  child.stdin?.end();
}

/** One poll for one session. Never archives: reading a closed thread stays the agent's own `pair wait`. */
function tick(thread: string, watch: Watch, watches: Map<string, Watch>): void {
  if (watch.dispatching || Date.now() < watch.retryAt) {
    return;
  }
  try {
    if (readRegistration(watch.channel)?.thread !== thread) {
      watches.delete(thread);
      logListen(watch.channel, `stopped notifying ${thread}: it is no longer the registered session`);
      return;
    }
    const pending = pendingFor(watch.channel, "codex")?.state.last.file;
    if (pending === undefined) {
      return;
    }
    if (pending !== watch.notified) {
      let claimed: Claim;
      try {
        claimed = claim(claimPath(watch.channel, thread, pending));
      } catch (error) {
        if (isMissing(error)) {
          return; // another server released the claim since we looked: look again next tick
        }
        throw error;
      }
      if (claimed === "sent") {
        // Sent by another MCP process on this session, or by an earlier run of this one.
        Object.assign(watch, { notified: pending, notifiedAt: Date.now(), stallReported: false });
      } else if (claimed === "claimed") {
        dispatch(thread, watch, pending);
      }
      return;
    }
    if (!watch.stallReported && Date.now() - watch.notifiedAt > STALL_MS) {
      watch.stallReported = true;
      logListen(
        watch.channel,
        `no reply to ${pending} after 10 minutes. The review may just be long, or the turn failed, was cancelled, or waits for an approval. Pair won't notify again; ask Codex to check pair.`,
      );
    }
  } catch (error) {
    watch.retryAt = Date.now() + 60_000;
    logListen(watch.channel, `poll failed, retrying in 60s: ${errorMessage(error)}`);
  }
}

interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; _meta?: { threadId?: unknown } };
}

const LISTEN_TOOL = {
  name: "pair_listen",
  description:
    "Have pair notify this Codex session when a pair message for codex arrives, so you can end your turn instead of polling. Run `pair register` in your shell first. Takes no arguments.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function mcpResult(request: McpRequest, watches: Map<string, Watch>): unknown {
  switch (request.method) {
    case "initialize": {
      const { version } = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pair", version },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: [LISTEN_TOOL] };
    case "tools/call": {
      if (request.params?.name !== LISTEN_TOOL.name) {
        return { content: [{ type: "text", text: `unknown tool: ${String(request.params?.name)}` }], isError: true };
      }
      try {
        return { content: [{ type: "text", text: listen(request.params._meta?.threadId, watches) }] };
      } catch (error) {
        if (!(error instanceof PairError)) {
          throw error;
        }
        return { content: [{ type: "text", text: `pair: ${error.message}` }], isError: true };
      }
    }
    default:
      return undefined;
  }
}

/** stdio MCP server. Its watches live and die with this process, which Codex ends with the session. */
async function serveMcp(): Promise<void> {
  const watches = new Map<string, Watch>();
  const timer = setInterval(() => {
    for (const [thread, watch] of watches) {
      tick(thread, watch, watches);
    }
  }, POLL_MS);
  const respond = (message: object): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) {
      continue;
    }
    let request: McpRequest;
    try {
      request = JSON.parse(line) as McpRequest;
    } catch {
      respond({ id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (request.id === undefined || request.id === null) {
      continue; // a notification, such as notifications/initialized
    }
    try {
      const result = mcpResult(request, watches);
      respond(result === undefined ? { id: request.id, error: { code: -32601, message: `method not found: ${request.method}` } } : { id: request.id, result });
    } catch (error) {
      // Report it to Codex instead of dying: a crashed server would silently stop every watch.
      respond({ id: request.id, error: { code: -32603, message: errorMessage(error) } });
    }
  }
  clearInterval(timer); // stdin closed: the session is gone, so stop notifying it
}

function describe(channel: string, author: Agent): string {
  const thread = threadFor(channel, author);
  const state = stateOf(listMessages(thread));
  if (state.kind === "idle") {
    return `${basename(thread.lane)}: idle`;
  }
  const turn = state.kind === "awaiting-review" ? thread.reviewer : thread.author;
  return `${basename(thread.lane)}: ${state.kind} (round ${state.last.round}, ${turn}'s turn)`;
}

function instructionState(path: string, expected: string, sectionOnly = false): string {
  try {
    const text = readFileSync(path, "utf8");
    const actual = sectionOnly ? PAIR_SECTION.exec(text)?.[0] : text;
    if (actual === undefined) {
      return "missing"; // AGENTS.md exists but has no complete pair section
    }
    if (unstamped(actual) === unstamped(expected)) {
      return "current";
    }
    const writer = STAMP.exec(actual)?.[1];
    return writer && isNewer(writer, PACKAGE.version) ? `newer (pair ${writer})` : "stale";
  } catch (error) {
    if (isMissing(error)) {
      return "missing";
    }
    const reason = error instanceof Error && "code" in error ? String(error.code) : String(error);
    return `unreadable (${reason})`;
  }
}

function notificationStatus(channel: string): string[] {
  let registration: string;
  try {
    const current = readRegistration(channel);
    registration = current ? `session ${current.thread}, registered ${current.registeredAt}` : "no session registered";
  } catch (error) {
    if (!(error instanceof PairError)) {
      throw error;
    }
    registration = error.message;
  }
  let lastEvent: string | undefined;
  try {
    lastEvent = readChannelFile(join(stateDir(channel), LISTEN_LOG)).trimEnd().split("\n").at(-1);
  } catch (error) {
    if (error instanceof PairError) {
      lastEvent = error.message;
    } else if (!isMissing(error)) {
      throw error;
    }
  }
  return [`codex notifications: ${registration}`, ...(lastEvent ? [`  last listener event: ${lastEvent}`] : [])];
}

function status(channel: string, root: string): string {
  const lanes = channelAccess(channel, () => AGENTS.map((agent) => describe(channel, agent)));
  const agents = instructionState(join(root, "AGENTS.md"), codexSection(), true);
  const skill = instructionState(join(root, ".claude", "skills", "pair", "SKILL.md"), claudeSkill());
  return [
    `channel: ${channel}`,
    `worktree: ${root}`,
    `version: ${PACKAGE.name} ${PACKAGE.version}`,
    ...lanes,
    "instructions on disk (does not verify what running agents loaded):",
    `  AGENTS.md (pair section): ${agents}`,
    `  .claude/skills/pair/SKILL.md: ${skill}`,
    ...channelAccess(channel, () => notificationStatus(channel)),
    ...(agents === "missing" || agents === "stale" || skill === "missing" || skill === "stale"
      ? ["Run `pair init` to refresh missing or stale instructions, then reload agent sessions."] : []),
    ...(agents.startsWith("unreadable") || skill.startsWith("unreadable")
      ? ["Check permissions on the unreadable instruction paths before refreshing them."] : []),
    ...(agents.startsWith("newer") || skill.startsWith("newer")
      ? ["A newer pair wrote these instructions: run `pair upgrade` in your own terminal."] : []),
  ].join("\n");
}

/**
 * Rewrites instructions an older pair wrote; leaves missing, unreadable and newer ones for `pair status` to report.
 * Returns a note for after the command's output: agents read `pair wait`'s first line, with stderr merged.
 */
function refreshInstructions(root: string): string | undefined {
  try {
    return refreshedNote(refreshStale(root));
  } catch (error) {
    // A read-only sandbox: message delivery must still work, so report and go on.
    const reason = errorMessage(error);
    return `pair: couldn't refresh instructions (${reason}); run \`pair init\` in your own terminal`;
  }
}

/** The stale instruction files it rewrote. A write failure throws. */
function refreshStale(root: string): string[] {
  const skillPath = join(root, ".claude", "skills", "pair", "SKILL.md");
  const agentsPath = join(root, "AGENTS.md");
  const refreshed: string[] = [];
  if (instructionState(skillPath, claudeSkill()) === "stale") {
    writeFileSync(skillPath, claudeSkill());
    refreshed.push(skillPath);
  }
  if (instructionState(agentsPath, codexSection(), true) === "stale") {
    writeFileSync(agentsPath, readFileSync(agentsPath, "utf8").replace(PAIR_SECTION, () => codexSection()));
    refreshed.push(`${agentsPath} (pair section)`);
  }
  return refreshed;
}

function refreshedNote(refreshed: string[]): string | undefined {
  return refreshed.length > 0
    ? `pair: refreshed ${refreshed.join(", ")} to pair ${PACKAGE.version}; reload agent sessions to load them`
    : undefined;
}

function unstamped(text: string): string {
  return text.replace(STAMP, "");
}

function isNewer(version: string, than: string): boolean {
  return version.localeCompare(than, "en", { numeric: true }) > 0;
}

/** The latest version on npm, checked at most once a day; undefined when opted out or the check fails. */
async function latestVersion(): Promise<string | undefined> {
  if (process.env.PAIR_NO_UPDATE_CHECK) {
    return undefined;
  }
  const cache = join(stateHome(), "latest.json");
  try {
    const cached = JSON.parse(readFileSync(cache, "utf8"));
    if (Date.now() - cached.checkedAt < UPDATE_CHECK_MS && typeof cached.version === "string") {
      return cached.version;
    }
  } catch {
    // no cache yet, or a corrupt one: check again
  }
  let version: unknown;
  try {
    // ponytail: the public registry, not npm's configured one; read `npm config get registry` if mirrors matter
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE.name}/latest`, { signal: AbortSignal.timeout(2000) });
    version = ((await response.json()) as { version?: unknown }).version;
  } catch {
    return undefined; // offline or sandboxed: the notice is best-effort
  }
  if (typeof version !== "string") {
    return undefined;
  }
  try {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, JSON.stringify({ checkedAt: Date.now(), version }));
  } catch {
    // a read-only state dir only means checking again next time
  }
  return version;
}

async function updateNotice(): Promise<string[]> {
  const latest = await latestVersion();
  return latest && isNewer(latest, PACKAGE.version)
    ? [`update available: ${PACKAGE.name} ${PACKAGE.version} → ${latest}. Run \`pair upgrade\` in your own terminal.`]
    : [];
}

/** Installs the latest pair, then lets the new version refresh this worktree's instructions. */
function upgrade(root: string): number {
  // npm's own answer, from the registry it installs from; if it fails, the install reports why.
  const view = spawnSync("npm", ["view", PACKAGE.name, "version"], { encoding: "utf8" });
  const latest = view.status === 0 ? view.stdout.trim() : undefined;
  if (latest && !isNewer(latest, PACKAGE.version)) {
    let note: string | undefined;
    try {
      note = refreshedNote(refreshStale(root)); // refreshing is all that is left to do, so a failure fails upgrade
    } catch (error) {
      const reason = errorMessage(error);
      throw new PairError(`already up to date, but couldn't refresh instructions (${reason})`);
    }
    console.log(`already up to date: ${PACKAGE.name} ${PACKAGE.version}${note ? `\n${note}` : ""}`);
    return 0;
  }
  const install = spawnSync("npm", ["install", "--global", `${PACKAGE.name}@latest`], { stdio: "inherit" });
  if (install.error) {
    throw new PairError(`couldn't run npm: ${install.error.message}`);
  }
  if (install.status !== 0) {
    return install.status ?? 1;
  }
  const states = [
    instructionState(join(root, ".claude", "skills", "pair", "SKILL.md"), claudeSkill()),
    instructionState(join(root, "AGENTS.md"), codexSection(), true),
  ];
  if (states.some((state) => state !== "missing")) {
    // The package just installed, not whatever `pair` comes first on PATH, which may be an older copy.
    const globalRoot = spawnSync("npm", ["root", "--global"], { encoding: "utf8" });
    if (globalRoot.error || globalRoot.status !== 0) {
      throw new PairError("installed, but `npm root --global` failed; run `pair init` yourself");
    }
    const installed = join(globalRoot.stdout.trim(), PACKAGE.name, "dist", "pair.js");
    const init = spawnSync(process.execPath, [installed, "init"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (init.error || init.status !== 0) {
      throw new PairError(`installed, but the new \`pair init\` failed${init.error ? `: ${init.error.message}` : ""}; run it yourself`);
    }
    // Only what it did to the files: the sandbox and `codex mcp add` setup it also prints is already done.
    console.log(init.stdout.split("\n").filter((line) => /^(?:wrote|kept): /.test(line)).join("\n"));
  }
  console.log(
    `upgraded: ${PACKAGE.name} ${PACKAGE.version} → ${latest ?? "latest"}. Restart Claude Code and Codex sessions to load it; other worktrees refresh on their next pair send or wait.`,
  );
  return 0;
}

interface ArchivedThread {
  id: string;
  finishedAt: number; // directory mtime: when its last message landed
  dir: string;
  laneName: string;
  outcome: ThreadStatus;
  thread: Thread;
}

/** Finished threads, most recently finished first. Entries that aren't archived threads are ignored. */
function listArchived(channel: string): ArchivedThread[] {
  const archiveDir = join(channel, "archive");
  return readdirOrEmpty(archiveDir)
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): ArchivedThread[] => {
      const match = ARCHIVED_THREAD.exec(entry.name);
      if (!match) {
        return [];
      }
      const [, id, author, reviewer, outcome] = match;
      const thread = threadFor(channel, author as Agent);
      if (thread.reviewer !== reviewer) {
        return [];
      }
      const dir = join(archiveDir, entry.name);
      const stats = statSync(dir, { throwIfNoEntry: false });
      if (!stats) {
        return []; // removed by a concurrent clean
      }
      const laneName = `${author}-to-${reviewer}`;
      return [{ id, finishedAt: stats.mtimeMs, dir, laneName, outcome: outcome as ThreadStatus, thread }];
    })
    .sort((a, b) => b.finishedAt - a.finishedAt || b.id.localeCompare(a.id));
}

/** Undefined when `pair clean` removed the thread after the archive was listed. */
function readArchived(entry: ArchivedThread): Message[] | undefined {
  try {
    return readThread(entry.dir, entry.thread);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function requestSummary(messages: Message[]): string {
  const first = messages[0]?.body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "";
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}

function history(channel: string, query: string | undefined): string {
  const archived = listArchived(channel);
  if (query === undefined) {
    if (archived.length === 0) {
      return "no finished threads yet";
    }
    return archived
      .flatMap((entry) => {
        const messages = readArchived(entry);
        return messages ? [`${entry.id}  ${entry.laneName}  ${entry.outcome}  ${messages.length} messages  ${requestSummary(messages)}`] : [];
      })
      .join("\n");
  }
  const matches = archived.filter((entry) => entry.id.includes(query));
  if (matches.length !== 1) {
    const found = matches.length === 0 ? "no finished thread matches" : `${matches.length} finished threads match`;
    throw new PairError(`${found} "${query}"${matches.map((entry) => `\n  ${entry.id}`).join("")}`);
  }
  const [entry] = matches;
  const messages = readArchived(entry);
  if (!messages) {
    throw new PairError(`finished thread ${entry.id} was removed while reading it`);
  }
  const transcript = messages.map((message) => `${messageHeader(message, entry.laneName)}\n${message.body.trimEnd()}`);
  return [`== thread ${entry.id} · ${entry.laneName} · ${entry.outcome} ==`, ...transcript].join("\n\n");
}

function clean(channel: string, keepValue: string | undefined): string {
  if (keepValue === undefined) {
    throw new PairError("clean needs --keep N, the number of newest finished threads to keep");
  }
  const keep = parseKeep(keepValue, "--keep");
  return `removed ${prune(channel, keep)} finished thread(s), kept up to ${keep}`;
}

/** Back up whole lanes so reset also repairs legacy, corrupt, and partially written requests. */
function reset(channel: string, root: string, author: Agent | undefined, dryRun: boolean): string {
  const lanes = (author ? [author] : AGENTS)
    .flatMap((agent) => {
      const lane = threadFor(channel, agent).lane;
      const stat = lstatSync(lane, { throwIfNoEntry: false });
      if (!stat || (stat.isDirectory() && readdirSync(lane).length === 0)) return [];
      let label = `${basename(lane)}: ${stat.isSymbolicLink() ? "symlink" : "unparseable"}`;
      if (stat.isDirectory()) {
        try { label = describe(channel, agent); } catch { /* backup must still work for malformed requests */ }
      }
      return [{ lane, label }];
    });
  if (lanes.length === 0) return `nothing to reset in ${root}`;
  if (dryRun) return [
    `would reset in ${root}:`,
    ...lanes.map(({ label }) => `  ${label}`),
    `would preserve their contents under ${join(channel, "resets")}; no files changed`,
  ].join("\n");

  const resetRoot = join(channel, "resets");
  const stat = lstatSync(resetRoot, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new PairError(`refusing to write reset backups through a non-directory or symlink: ${resetRoot}`);
  const backup = join(resetRoot, newThreadId());
  mkdirSync(backup, { recursive: true });
  const moved: string[] = [];
  try {
    writeFileSync(join(backup, "reset.json"), `${JSON.stringify({ resetAt: new Date().toISOString(), worktree: root, plannedLanes: lanes.map(({ lane }) => basename(lane)) }, null, 2)}\n`);
    for (const { lane } of lanes) {
      renameSync(lane, join(backup, basename(lane)));
      moved.push(basename(lane));
    }
  } catch (error) {
    const failure = channelError(channel, error);
    throw new PairError(`reset failed${moved.length ? ` after moving ${moved.join(", ")}` : ""}; any moved requests are preserved at ${backup}: ${errorMessage(failure)}`);
  }
  return [
    ...lanes.map(({ label }) => `reset: ${label}`),
    `saved pending requests: ${backup}`,
    "Archived history and source files are unchanged. Restart manual agents before sending a fresh request.",
  ].join("\n");
}

function renderPrompt(agent: Agent): string {
  const template = readFileSync(join(PACKAGE_ROOT, "prompts", "pair.md"), "utf8");
  return template.replaceAll("{{AGENT}}", agent).replaceAll("{{PARTNER}}", partnerOf(agent));
}

function claudeSkill(): string {
  const header = `---\nname: pair\ndescription: Request a code review from codex after finishing a task, or act as codex's reviewer ("be my reviewer", "listen"), via the pair CLI.\n---\n\n`;
  return `${header}<!-- pair ${PACKAGE.version} -->\n${renderPrompt("claude")}`;
}

function codexSection(): string {
  return `<!-- pair:start -->\n<!-- pair ${PACKAGE.version} -->\n${renderPrompt("codex").trimEnd()}\n<!-- pair:end -->\n`;
}

function init(channel: string, root: string): string {
  channelAccess(channel, () => mkdirSync(channel, { recursive: true }));

  // Current files keep their stamp too: a newer pair may have written the same text.
  const kept = (state: string): string | undefined =>
    state === "current" ? " (current)" : state.startsWith("newer") ? " (a newer pair wrote it; run `pair upgrade`, or delete it to downgrade)" : undefined;
  const done: string[] = [];
  const skillDir = join(root, ".claude", "skills", "pair");
  const skillPath = join(skillDir, "SKILL.md");
  const skillKept = kept(instructionState(skillPath, claudeSkill()));
  if (skillKept) {
    done.push(`kept: ${skillPath}${skillKept}`);
  } else {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, claudeSkill());
    done.push(`wrote: ${skillPath}`);
  }

  const agentsPath = join(root, "AGENTS.md");
  const section = codexSection();
  const agentsKept = kept(instructionState(agentsPath, section, true));
  if (agentsKept) {
    done.push(`kept: ${agentsPath} (pair section)${agentsKept}`);
  } else {
    const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
    const updated = PAIR_SECTION.test(existing) ? existing.replace(PAIR_SECTION, () => section) : `${existing}${existing ? "\n" : ""}${section}`;
    writeFileSync(agentsPath, updated);
    done.push(`wrote: ${agentsPath} (pair section)`);
  }

  return [
    `channel: ${channel}`,
    ...done,
    "",
    sandboxConfig(channel),
    "",
    ...autoModeNote(channel),
    "To let pair wake Codex when a message arrives, instead of Codex polling, register pair's MCP server once:",
    `  ${mcpAddCommand(root)}`,
  ].join("\n");
}

/** init's job is the instruction files, so a bad socket setting, which only matters to pair start, is reported, not fatal. */
function autoModeNote(channel: string): string[] {
  if (process.platform === "win32") {
    return [];
  }
  try {
    return [`Auto mode: pair start --as claude adds sandbox.network.allowUnixSockets for ${autoSocketPath(stateDir(channel))} to that Claude session only. No persistent socket setting is needed.`, ""];
  } catch (error) {
    return [`Auto mode is unavailable until this is fixed: ${errorMessage(error)}`, ""];
  }
}

/** Codex starts MCP servers with only HOME, PATH and a few more, so the command carries what `pair mcp` reads. */
function mcpAddCommand(root: string): string {
  const stateHome = process.env.XDG_STATE_HOME;
  const env = [
    ...(process.env.PAIR_HOME ? [`PAIR_HOME=${pairHome(root)}`] : []),
    ...(stateHome && isAbsolute(stateHome) ? [`XDG_STATE_HOME=${resolve(stateHome)}`] : []),
    `PAIR_CODEX=${findCodex(root) ?? "<absolute path of codex>"}`,
  ];
  const flags = env.map((entry) => `--env ${shellQuote(entry)}`).join(" ");
  return `codex mcp add ${flags} pair -- ${shellQuote(join(PACKAGE_ROOT, "dist", "pair.js"))} mcp`;
}

/**
 * `init` appends its section after exactly one added line ending. When the last section ends the file,
 * drop it with that one line ending, so the user's text ends exactly as before, final newline or not.
 */
function withoutAppendedSection(text: string): string {
  const end = text.lastIndexOf("<!-- pair:end -->");
  if (end === -1 || text.slice(end + "<!-- pair:end -->".length).trim() !== "") {
    return text;
  }
  const start = text.lastIndexOf("<!-- pair:start -->", end);
  return start === -1 ? text : text.slice(0, start).replace(/\r?\n$/, "");
}

/** Single-quoted for sh: the channel name comes from the worktree's name, which may hold `$(…)`. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Undoes `init` in this worktree. Every version so far wrote the same two paths and section markers,
 * so this also cleans up after older versions. History and global setup are only reported.
 */
function uninit(channel: string, root: string): string {
  const removed: string[] = [];
  const notes: string[] = [];

  const skillDir = join(root, ".claude", "skills", "pair");
  const skillPath = join(skillDir, "SKILL.md");
  if (existsSync(skillPath)) {
    const skill = readFileSync(skillPath, "utf8");
    if (unstamped(skill) === unstamped(claudeSkill()) || RELEASED_SKILL_SHA256.includes(createHash("sha256").update(skill).digest("hex"))) {
      rmSync(skillPath);
      removed.push(skillPath);
      // Drop the directories init created, up to the first one that holds something else.
      for (const dir of [skillDir, dirname(skillDir), dirname(dirname(skillDir))]) {
        try {
          rmdirSync(dir);
        } catch {
          break; // not empty: someone else's files live there
        }
      }
    } else {
      notes.push(`kept: ${skillPath} (it isn't a file pair init wrote, so it may hold your changes; delete it yourself if not)`);
    }
  }

  const agentsPath = join(root, "AGENTS.md");
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  if (PAIR_SECTION.test(agents)) {
    const rest = withoutAppendedSection(agents).replace(PAIR_SECTIONS, "");
    if (rest.trim() === "") {
      rmSync(agentsPath);
      removed.push(`${agentsPath} (it held only the pair section)`);
    } else {
      writeFileSync(agentsPath, rest);
      removed.push(`the pair section of ${agentsPath}`);
    }
  }

  const registration = join(channel, SESSION_FILE);
  if (channelAccess(channel, () => lstatSync(registration, { throwIfNoEntry: false }))) {
    channelAccess(channel, () => rmSync(registration, { force: true }));
    removed.push("the codex session registration, so pair stops notifying it");
  }

  const history = [channel, stateDir(channel)].filter((dir) => existsSync(dir));
  if (history.length > 0) {
    notes.push(`kept: message history. To delete it: rm -rf ${history.map(shellQuote).join(" ")}`);
  }
  notes.push(
    "If no repo uses pair anymore: run `codex mcp remove pair`, then `npm uninstall -g claude-codex-pair`, and remove the pair home from the sandbox settings `pair init` printed.",
  );
  const summary = removed.length > 0 ? removed.map((item) => `removed: ${item}`) : [`nothing from pair init found in ${root}`];
  return [...summary, ...notes].join("\n");
}

interface OsProcess {
  pid: number;
  ppid: number;
  started: string;
  command: string;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/; // lstart is always 5 fields
// node itself runs the script, so a wrapper whose command line mentions it (`zsh -c "… pair.js wait"`) doesn't match
const PAIR_PROCESS = /^(?:\S*\/)?node(?: -\S+)* \S*\/(?:bin\/pair|dist\/pair\.js) ((?:mcp|wait|start|_auto-guardian)\b.*)$/;
const SHELL = /^(?:\S*\/)?(?:zsh|bash|sh|dash|fish)(?: |$)/;

function listProcesses(): OsProcess[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  } catch (error) {
    throw new PairError(`can't list processes (${errorMessage(error)}); agent sandboxes often block ps, so run pair ps in your own terminal`);
  }
  return out.split("\n").flatMap((line) => {
    const match = PS_LINE.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3], command: match[4] }] : [];
  });
}

/** Working directories by pid: /proc on Linux, lsof elsewhere. Unknown ones are left out. */
function workingDirs(pids: number[]): Map<number, string> {
  const dirs = new Map<number, string>();
  if (existsSync("/proc/self/cwd")) {
    for (const pid of pids) {
      try {
        dirs.set(pid, realpathSync(`/proc/${pid}/cwd`));
      } catch {
        // gone, or not ours
      }
    }
    return dirs;
  }
  let out = "";
  try {
    out = execFileSync("lsof", ["-w", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // lsof exits 1 when one of the pids is gone, but still prints the rest
    out = error instanceof Error && "stdout" in error ? String(error.stdout) : "";
  }
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n")) {
      dirs.set(pid, line.slice(1));
    }
  }
  return dirs;
}

/** A short name for what started a pair process; `pair ps -v` shows the full command. */
function hostName(command: string): string {
  if (command.includes("/ChatGPT.app/")) {
    return "ChatGPT app";
  }
  const daemon = /\/app-server-daemon\/releases\/(\d[\w.]*?)-/.exec(command);
  if (daemon) {
    return `Codex CLI ${daemon[1]}`;
  }
  const [argv0 = "", ...args] = command.split(" ");
  const name = basename(argv0);
  if (name === "claude") {
    const worktree = /--worktree (\S+)/.exec(command)?.[1];
    const session = /--resume ([0-9a-f]{8})/.exec(command)?.[1];
    const hint = worktree ? `worktree ${worktree}` : session ? `resume ${session}` : args.includes("--resume") ? "resume" : "";
    return hint ? `Claude Code (${hint})` : "Claude Code";
  }
  return name === "codex" ? "Codex CLI" : name;
}

function age(started: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / (24 * 60))}d`;
}

/** `~` for home, and only the last four parts of a long path. */
function shortPath(path: string): string {
  const home = homedir();
  const tilde = path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
  const parts = tilde.split(sep);
  return tilde.length > 40 && parts.length > 5 ? [parts[0], "…", ...parts.slice(-4)].join(sep) : tilde;
}

/**
 * The worktree's registered Codex session and when pair last woke it, or undefined. It reads with this shell's
 * PAIR_HOME and XDG_STATE_HOME, which may not be the agents', so it only reports what it finds, never an absence.
 */
function codexLine(root: string): string | undefined {
  const channel = channelDir(root);
  try {
    const registration = readRegistration(channel);
    if (!registration) {
      return undefined;
    }
    const mine = ` notified ${registration.thread} about `; // not a note to an earlier session
    const log = join(stateDir(channel), LISTEN_LOG);
    const notified = existsSync(log) ? readChannelFile(log).trimEnd().split("\n").findLast((line) => line.includes(mine)) : undefined;
    const id = registration.thread.slice(0, 8);
    return notified ? `registered ${id} · last note ${age(notified.split(" ")[0])} ago` : `registered ${id}`;
  } catch (error) {
    return errorMessage(error);
  }
}

interface PairProcess extends OsProcess {
  kind: "mcp" | "wait" | "start" | "guardian";
  host: OsProcess | undefined;
}

/** Pair listeners, waits, auto launchers and guardians on this machine, grouped by worktree. */
async function ps(verbose: boolean): Promise<string> {
  const all = listProcesses();
  const byPid = new Map(all.map((proc) => [proc.pid, proc]));
  const ours: PairProcess[] = all.flatMap((proc) => {
    const match = PAIR_PROCESS.exec(proc.command);
    if (!match) {
      return [];
    }
    let host = byPid.get(proc.ppid);
    while (host && SHELL.test(host.command)) {
      host = byPid.get(host.ppid); // an agent runs pair wait through a shell; show the agent
    }
    const command = match[1].split(" ")[0];
    const kind = command === "_auto-guardian" ? "guardian" : command as PairProcess["kind"];
    return [{ ...proc, kind, host }];
  });
  if (ours.length === 0) {
    return "no pair mcp, wait, start or guardian is running";
  }
  const dirs = workingDirs(ours.map((proc) => proc.pid));
  const groups = new Map<string, { root: string | undefined; procs: PairProcess[] }>();
  for (const proc of ours) {
    const dir = dirs.get(proc.pid) ?? "?";
    const top = dir === "?" ? undefined : gitPath("--show-toplevel", dir);
    const root = top ? realpathOrSelf(top) : undefined;
    const key = root ?? dir;
    const group = groups.get(key) ?? { root, procs: [] };
    group.procs.push(proc);
    groups.set(key, group);
  }
  const blocks = [...groups].sort(([a, x], [b, y]) => Number(!x.root) - Number(!y.root) || a.localeCompare(b));
  return (await Promise.all(blocks
    .map(async ([path, { root, procs }]) => {
      const name = root ? basename(root) : path !== "?" && !existsSync(path) ? "(deleted)" : "(no worktree)";
      const lines = [`${name}  ${shortPath(path)}`];
      const codex = root ? codexLine(root) : undefined;
      if (codex) {
        lines.push(`  codex   ${codex}`);
      }
      if (root && procs.some((proc) => proc.kind === "start" || proc.kind === "guardian")) {
        lines.push(...(await autoStatus(stateDir(channelDir(root)), root)).map((line) => `  ${line}`));
      }
      procs.sort((a, b) => a.kind.localeCompare(b.kind) || a.pid - b.pid);
      for (const proc of procs) {
        const host = proc.host ? hostName(proc.host.command) : `⚠ parent gone (${proc.ppid})`;
        lines.push(`  ${proc.kind.padEnd(6)}  ${String(proc.pid).padEnd(6)} ${age(proc.started).padEnd(4)} ${host}`);
        if (verbose && proc.host) {
          lines.push(`          started by ${proc.host.pid}: ${proc.host.command}`);
        }
      }
      return lines.join("\n");
    })))
    .join("\n\n");
}

function readBody(source: string | undefined): string {
  if (!source) {
    throw new PairError("send needs a message file, or - for stdin");
  }
  if (source !== "-" && !existsSync(source)) {
    throw new PairError(`message file not found: ${source}`);
  }
  const body = readFileSync(source === "-" ? 0 : source, "utf8");
  if (!body.trim()) {
    throw new PairError("message body is empty");
  }
  return body;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T {
  if (!value || !allowed.includes(value as T)) {
    throw new PairError(`${what} must be one of: ${allowed.join(", ")}${value ? ` (got "${value}")` : ""}`);
  }
  return value as T;
}

const USAGE = `usage:
  pair start --as <claude|codex> [--worktree NAME] [-y] [--reviewer-model MODEL] [--reviewer-effort LEVEL]
             [--reviewer-args="ARGS"] [--claude /path] [--codex /path] [--timeout seconds]
             [--grace seconds] [-- AUTHOR_ARGS...]
  pair stop                                           (stop this worktree's auto session and its managed agents)
  pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <file|->
  pair wait --as <claude|codex> [--timeout seconds]   (prints "no message … yet" on timeout)
  pair status
  pair history [thread-id]                            (list finished threads, or show one)
  pair clean --keep N                                 (delete all but the N newest finished threads)
  pair reset [--as <claude|codex>] [--dry-run]        (back up pending lanes; --as selects their author, default: both)
  pair init
  pair upgrade                                        (install the latest pair from npm, then refresh this worktree)
  pair uninit                                         (remove what pair init wrote in this worktree; keeps history)
  pair register | unregister                          (in Codex's shell: let pair_listen notify this session)
  pair mcp                                            (stdio MCP server for Codex, providing pair_listen)
  pair ps [-v]                                        (running pair processes, including auto owners, by worktree; -v: full commands)
  pair help [command]                                 (this list, or one command's options; same as pair <command> --help)`;

const HELP = `${USAGE}

environment:
  PAIR_HOME              root directory for channels (default ~/.pair)
  PAIR_AGENT             default for --as
  PAIR_MAX_ROUNDS        review rounds before a thread is escalated (default 3)
  PAIR_KEEP              finished threads to keep: a number, or all (default 100)
  PAIR_NO_UPDATE_CHECK   any value turns off the daily npm version check
  PAIR_AUTO_SOCKET_DIR   private absolute directory for auto-mode sockets (default /tmp/pair-auto-<uid>)`;

const AS_OPTION = "  --as <claude|codex>          who is running the command (default: $PAIR_AGENT)";

const REGISTER_HELP = `usage: pair register | pair unregister

Run by Codex in its own shell. register records this Codex session so the pair_listen tool from
pair mcp wakes it when a message arrives. unregister stops the notifications; run it before
pair start in this worktree.`;

const COMMAND_HELP: Record<string, string> = {
  start: `usage: pair start --as <claude|codex> [options] [-- AUTHOR_ARGS...]

Auto mode (macOS and Linux). Opens the --as agent interactively as the author. Each review request
starts the other agent as a non-interactive reviewer for one round, and the review comes back
inline to the author's pair send. Run it in your own terminal, outside Claude or Codex; it runs
pair init where the session runs if pair's instructions are missing there. A Codex session
registered with pair register blocks it; run pair unregister first.
It first prints where it will run, the author's session and the reviewer's settings, and in a
terminal waits for Enter.

options:
  --as <claude|codex>          the interactive author (default: $PAIR_AGENT)
  --worktree NAME              run everything in the git worktree ../<repo>-NAME on branch NAME.
                               The first run creates them (a new branch from HEAD, so uncommitted
                               changes stay here, or one tracking a remote branch NAME). Later runs
                               reuse it while it still has branch NAME checked out.
  -y, --yes                    start without waiting for Enter
  --reviewer-model MODEL       the reviewer CLI's model ID or alias (default: that CLI's default)
  --reviewer-effort LEVEL      reviewer reasoning effort (default: that CLI's default)
                               codex: none, minimal, low, medium, high, xhigh, max, ultra
                               claude: low, medium, high, xhigh, max, ultracode
  --reviewer-args="ARGS"       more reviewer options, split on spaces. A claude reviewer accepts
                               --fallback-model, --max-budget-usd and --strict-mcp-config; a codex
                               reviewer -c/--config model_*=VALUE (effort: --reviewer-effort).
                               Nothing that changes its tools or sandbox. Use = since the value
                               starts with a dash.
  --claude /ABSOLUTE/PATH      claude executable (default: first claude on PATH)
  --codex /ABSOLUTE/PATH       codex executable (default: first codex on PATH)
  --timeout SECONDS            limit for each review round (default 900, max 86400)
  --grace SECONDS              wait between terminating and killing a process (default 2, max 30)
  -- AUTHOR_ARGS...            pass the rest to the interactive claude or codex. Only options that
                               keep it an interactive session in this worktree are accepted, each
                               with at most one value; others are refused with the supported list.
                               A codex author resumes with -- resume <UUID> [options]. pair status
                               and pair stop show the author's conversation ID with a command that
                               resumes it: a new claude conversation gets an ID pair picks, and a
                               resumed one keeps its ID. Otherwise (a new codex conversation,
                               --continue, --fork-session, a --resume name), pair learns the ID from
                               the author's first review request.

  pair start --as claude --reviewer-effort high -- --model opus --permission-mode acceptEdits
  pair start --as codex --worktree feature/login
  pair start --as claude --reviewer-args="-c model_verbosity=low" -- --model opus
  pair start --as codex --reviewer-args="--fallback-model sonnet" -- --model MODEL --search

Inspect it from another terminal in the same worktree (with --worktree, the new one) with
pair status or pair ps -v; stop it with pair stop.`,
  stop: `usage: pair stop

Stop this worktree's auto session (pair start): the author, its managed reviewers, and their tools.
When pair knows the claude author's conversation ID, it prints a command that starts the session
again in this worktree and resumes that conversation.`,
  send: `usage: pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <FILE|->

Send a message on this worktree's channel. The body is read from FILE, or from stdin with -.
  request    as the author, open a review thread (fails while your previous thread is still open)
  review     as the reviewer, reply to the waiting request or response; needs --verdict
  response   as the author, answer a review: what you fixed, rejected or deferred, and why

options:
${AS_OPTION}
  --verdict <approve|changes>  required for review; approve closes the thread

A thread is escalated when changes are still requested after PAIR_MAX_ROUNDS rounds (default 3).
In auto mode, request and response wait for the managed review and print it.`,
  wait: `usage: pair wait --as <claude|codex> [--timeout SECONDS]

Wait until a message for --as arrives, print it with what to do next, and exit. On timeout it prints
"pair: no message for <agent> yet." and exits 0. In auto mode, the author's wait retries a failed
review round.

options:
${AS_OPTION}
  --timeout SECONDS            give up after this long (default ${DEFAULT_WAIT_SECONDS})`,
  status: `usage: pair status

Show this worktree's channel, the installed version, each lane's state, whether the instruction
files on disk are current, the Codex notification registration, and auto mode. It doesn't modify
the worktree or the channel.`,
  history: `usage: pair history [THREAD]

With no argument, list finished threads, newest first. With THREAD (any unique part of a thread
id), print that thread's messages.`,
  clean: `usage: pair clean --keep N

Delete all but the N newest finished threads. Pair also does this whenever a thread finishes,
keeping PAIR_KEEP threads (default 100).`,
  reset: `usage: pair reset [--as <claude|codex>] [--dry-run]

Clear stale pending requests by moving whole lanes into a timestamped backup under the channel's
resets/ directory, and print its path. Source files and finished history are left alone. Stop
manual agent sessions first; it refuses while auto mode owns the worktree (run pair stop).

options:
  --as <claude|codex>          reset only the lane of requests this agent authored (default: both)
  --dry-run                    show the lanes it would reset without changing anything`,
  init: `usage: pair init

Set up this worktree: create its channel and write the agent instructions (the pair section of
AGENTS.md and .claude/skills/pair/SKILL.md), then print the sandbox and codex mcp add setup.
Rerun it to refresh stale instructions; it keeps files that a newer pair wrote.`,
  upgrade: `usage: pair upgrade

Run in your own terminal. If npm has a newer version, install it globally, then refresh this
worktree's instructions. Restart Claude Code and Codex afterwards.`,
  uninit: `usage: pair uninit

Undo pair init in this worktree: remove the pair section of AGENTS.md, the pair skill (unless you
changed it), and the Codex session registration. Message history is kept.`,
  help: HELP,
  register: REGISTER_HELP,
  unregister: REGISTER_HELP,
  mcp: `usage: pair mcp

The stdio MCP server that gives Codex the pair_listen tool. Codex starts it; add it with the
codex mcp add command that pair init prints.`,
  ps: `usage: pair ps [-v]

List running pair processes by worktree, including auto launchers and guardians.

options:
  -v, --verbose                show full command lines`,
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: { as: { type: "string" }, verdict: { type: "string" }, timeout: { type: "string" }, keep: { type: "string" }, verbose: { type: "boolean", short: "v" }, claude: { type: "string" }, codex: { type: "string" }, grace: { type: "string" }, help: { type: "boolean", short: "h" }, "reviewer-model": { type: "string" }, "reviewer-effort": { type: "string" }, "reviewer-args": { type: "string" }, worktree: { type: "string" }, "dry-run": { type: "boolean" }, yes: { type: "boolean", short: "y" } },
  });
  const [command, ...rest] = positionals;
  const terminator = tokens.find((token) => token.kind === "option-terminator");
  const passthrough = terminator ? argv.slice(terminator.index + 1) : [];
  if (values.help || command === "help") {
    const topic = command === "help" ? rest[0] : command;
    if (topic && !Object.hasOwn(COMMAND_HELP, topic)) {
      throw new PairError(`unknown command "${topic}"; run pair help for the list`);
    }
    console.log(topic ? COMMAND_HELP[topic] : HELP);
    return 0;
  }
  if (values["dry-run"] && command !== "reset") throw new PairError("--dry-run is only supported by pair reset");
  if (values.yes && command !== "start") {
    throw new PairError("--yes is only supported by pair start");
  }
  if (values.worktree !== undefined && command !== "start") {
    throw new PairError("--worktree is only supported by pair start");
  }
  const root = worktreeRoot();
  const channel = channelDir(root);
  const agent = (): Agent => oneOf(values.as ?? process.env.PAIR_AGENT, AGENTS, "--as (or PAIR_AGENT)");
  const managedReviewer = process.env.PAIR_AUTO_ROLE === "reviewer";
  if (managedReviewer && !REVIEWER_COMMANDS.includes(command)) {
    throw new PairError(`a managed reviewer may only run pair ${REVIEWER_COMMANDS.join(", ")}`);
  }
  // Refreshing rewrites files in the worktree, which a reviewer must not modify.
  const refreshNote = REFRESHING_COMMANDS.includes(command) && !managedReviewer ? refreshInstructions(root) : undefined;
  const managedReview = async (me: Agent): Promise<boolean> => {
    if (process.env.PAIR_AUTO_ROLE !== "author" || !process.env.PAIR_AUTO_RUN) return false;
    const thread = threadFor(channel, me);
    const state = channelAccess(channel, () => stateOf(listMessages(thread)));
    if (state.kind !== "awaiting-review") return false;
    try {
      // The author's own conversation ID, which its CLI sets for the commands it runs; the owner records it for pair stop.
      const author = me === "claude" ? process.env.CLAUDE_CODE_SESSION_ID : process.env.CODEX_THREAD_ID;
      await autoCall(stateDir(channel), { action: "review", run: process.env.PAIR_AUTO_RUN, file: state.last.file, author }, 24 * 60 * 60 * 1000);
    } catch (error) {
      if (hasCode(error, "EPERM", "EACCES")) {
        throw new PairError(`managed review cannot connect to ${autoSocketPath(stateDir(channel))}. Claude needs sandbox.network.allowUnixSockets for this exact socket. pair start --as claude supplies it through --settings; check managed sandbox policy if access is still denied. The request remains on disk.`);
      }
      throw new PairError(`managed review failed: ${errorMessage(error)}. The request remains on disk.`);
    }
    return true;
  };
  try {
    switch (command) {
      case "_auto-guardian":
        await runGuardian();
        return 0;
      case "start": {
        const me = agent();
        try {
          if (rest.length !== passthrough.length) {
            throw new PairError("pair start takes no arguments of its own; put the author's claude or codex options after --");
          }
          const timeout = positiveNumber(values.timeout ?? "900", "--timeout");
          const grace = positiveNumber(values.grace ?? "2", "--grace");
          if (timeout > 86400 || grace > 30) throw new PairError("--timeout must be at most 86400 seconds and --grace at most 30 seconds");
          const choices = {
            author: me, claude: values.claude, codex: values.codex, reviewerModel: values["reviewer-model"], reviewerEffort: values["reviewer-effort"],
            authorArgs: passthrough, reviewerArgs: values["reviewer-args"]?.split(/\s+/).filter(Boolean) ?? [],
          };
          checkStart(choices);
          const session = authorSession(me, passthrough);
          const plan = values.worktree === undefined ? undefined : planWorktree(root, values.worktree);
          const reviewer = me === "claude" ? "codex" : "claude";
          console.error([
            `pair: start auto mode in ${plan?.path ?? root}${plan ? ` (${plan.add ? "new" : "existing"} worktree, branch ${plan.name})` : ""}${plan?.add ? "; pair init runs there if its branch lacks the instructions" : needsInit(plan?.path ?? root) ? "; pair init runs there first" : ""}`,
            `pair:   author ${me} · session ${describeSession(session)}`,
            `pair:   reviewer ${reviewer} · model ${choices.reviewerModel ?? "CLI default"} · effort ${choices.reviewerEffort ?? "CLI default"}${choices.reviewerArgs.length ? ` · args ${choices.reviewerArgs.join(" ")}` : ""}`,
          ].join("\n"));
          // Before anything is created: a worktree, instruction files, the author record, the socket, any agent.
          if (!values.yes && process.stdin.isTTY && process.stdout.isTTY && !(await confirm("Start? [Y/n] "))) {
            throw new PairError("pair start cancelled; nothing was started");
          }
          const startRoot = plan ? openWorktree(root, plan) : root;
          // The agents follow these instructions (finding, severity and verdict rules), so auto mode can't do without them.
          if (needsInit(startRoot)) {
            const wrote = init(channelDir(startRoot), startRoot).split("\n").filter((line) => line.startsWith("wrote: "));
            console.error(wrote.map((line) => `pair: ${line}`).join("\n"));
          }
          process.chdir(startRoot); // so pair ps groups this launcher with the worktree it runs
          const startChannel = channelDir(startRoot);
          // Its listener would wake that session for either lane, and its pair wait could take the auto author's reviews.
          if (readRegistration(startChannel)) {
            throw new PairError("a manual Codex session is registered here; stop it and run pair unregister before starting auto mode");
          }
          return await startAuto({
            ...choices, root: startRoot, channel: startChannel, stateDir: stateDir(startChannel), entry: fileURLToPath(import.meta.url), session,
            restartOptions: [
              ["--as", me], ["--claude", values.claude], ["--codex", values.codex], ["--reviewer-model", values["reviewer-model"]],
              ["--reviewer-effort", values["reviewer-effort"]], ["--timeout", values.timeout], ["--grace", values.grace],
            ].flatMap(([name, value]) => value === undefined ? [] : [name!, value]).concat(values["reviewer-args"] === undefined ? [] : [`--reviewer-args=${values["reviewer-args"]}`]),
            timeoutMs: timeout * 1000,
            graceMs: grace * 1000,
            target: () => {
              const state = stateOf(listMessages(threadFor(startChannel, me)));
              return state.kind === "awaiting-review" ? { file: state.last.file, thread: basename(dirname(state.last.file)) } : undefined;
            },
            reviewed: (file) => {
              const messages = listMessages(threadFor(startChannel, me));
              const index = messages.findIndex((message) => message.file === file);
              return index >= 0 && messages[index + 1]?.type === "review";
            },
          });
        } catch (error) { throw new PairError(errorMessage(error)); }
      }
      case "stop":
        try { console.log(await stopAuto(stateDir(channel), root)); }
        catch (error) { throw new PairError(errorMessage(error)); }
        return 0;
      case "send": {
        autoKeep(); // reject a bad PAIR_KEEP before touching any thread
        const type = oneOf(rest[0], MESSAGE_TYPES, "message type");
        const verdict = values.verdict === undefined ? undefined : oneOf(values.verdict, VERDICTS, "--verdict");
        const me = agent();
        if (process.env.PAIR_AUTO_ROLE && me !== process.env.PAIR_AGENT) throw new PairError("auto mode agent identity does not match --as");
        if (managedReviewer && (me !== process.env.PAIR_AGENT || type !== "review")) {
          throw new PairError("a managed reviewer may only send its own review verdict");
        }
        const body = readBody(rest[1]);
        console.log(`sent: ${channelAccess(channel, () => send(channel, me, type, body, verdict))}`);
        if (type !== "review" && await managedReview(me) && !(await wait(channel, me, 1))) {
          throw new PairError("the managed review finished, but another pair wait already took it; run pair history to read it");
        }
        return 0;
      }
      case "wait": {
        autoKeep(); // reject a bad PAIR_KEEP before touching any thread
        const me = agent();
        if (process.env.PAIR_AUTO_ROLE && me !== process.env.PAIR_AGENT) throw new PairError("auto mode agent identity does not match --as");
        const timeout = positiveNumber(values.timeout ?? String(DEFAULT_WAIT_SECONDS), "--timeout");
        await managedReview(me); // explicit retry after a failed managed round
        if (!(await wait(channel, me, timeout))) {
          // Exit 0: a timeout is routine, and agent UIs show any non-zero exit as a failure. No "run it
          // again" here: whether to wait again differs by agent (Codex must not poll), so the prompt says.
          console.log(`pair: no message for ${me} yet.`);
        }
        return 0;
      }
      case "status":
        console.log([status(channel, root), ...(await autoStatus(stateDir(channel), root)), ...(await updateNotice())].join("\n"));
        return 0;
      case "history":
        console.log(channelAccess(channel, () => history(channel, rest[0])));
        return 0;
      case "clean":
        console.log(channelAccess(channel, () => clean(channel, values.keep)));
        return 0;
      case "reset": {
        if (rest.length) throw new PairError("reset accepts no positional arguments; use --as claude|codex to select an author lane");
        const author = values.as === undefined ? undefined : oneOf(values.as, AGENTS, "--as");
        const operation = () => channelAccess(channel, () => reset(channel, root, author, values["dry-run"] ?? false));
        try {
          console.log(values["dry-run"] ? operation() : await withAutoStopped(stateDir(channel), operation));
        } catch (error) { throw new PairError(errorMessage(error)); }
        return 0;
      }
      case "init":
        console.log([init(channel, root), ...(await updateNotice())].join("\n"));
        return 0;
      case "upgrade":
        return upgrade(root);
      case "uninit":
        console.log(uninit(channel, root));
        return 0;
      case "register":
        if (process.env.PAIR_AUTO_ROLE) throw new PairError("auto mode delivers reviews inline; session registration is unnecessary");
        console.log(channelAccess(channel, () => register(channel, root)));
        return 0;
      case "unregister":
        console.log(channelAccess(channel, () => unregister(channel)));
        return 0;
      case "mcp":
        await serveMcp();
        return 0;
      case "ps":
        console.log(await ps(values.verbose ?? false));
        return 0;
      default:
        console.error(USAGE);
        return 1;
    }
  } finally {
    if (refreshNote) {
      console.error(refreshNote);
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const isUsageError =
      error instanceof PairError || (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"));
    if (isUsageError) {
      console.error(`pair: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  },
);
