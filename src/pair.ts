#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, appendFileSync, constants, type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // any UUID version; Codex uses v7
const SESSION_FILE = "codex.session"; // the Codex session that pair_listen may notify, per channel
const LISTEN_LOG = "codex.listen.log";
const LISTEN_LOG_MAX_BYTES = 256 * 1024; // then it becomes codex.listen.log.1, replacing the previous one
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

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

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
      `${thread.lane} still uses the old flat layout (${legacy.name}). Move its NNN-*.md files into a new subdirectory of it, or delete them if that thread is finished.`,
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

function gitPath(flag: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", flag], {
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

function pairHome(): string {
  return resolve(process.env.PAIR_HOME ?? join(homedir(), ".pair"));
}

function channelDir(root: string): string {
  // One channel per worktree: a reviewer reads the author's files, so both must share a checkout.
  // realpath so /tmp/x and /private/tmp/x (or any symlinked checkout) share one channel.
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return join(pairHome(), `${basename(root)}-${hash}`);
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
  const { fields, body } = parseFrontmatter(readFileSync(path, "utf8"));
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
    const reason = failure instanceof Error ? failure.message : String(failure);
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
      throw new PairError(`a review thread to ${thread.reviewer} is already open (${state.kind}); finish it first`);
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

function readRegistration(channel: string): Registration | undefined {
  const path = join(channel, SESSION_FILE);
  let parsed: Partial<Registration>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Registration>;
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
  if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) <= LISTEN_LOG_MAX_BYTES) {
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

function logListen(channel: string, text: string): void {
  try {
    const path = join(channel, LISTEN_LOG);
    rotateLog(path);
    appendFileSync(path, `${new Date().toISOString()} ${text}\n`);
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

/** For `init`: the codex a shell here would run, unless it is, or links to, a file agents can write. */
function findCodex(root: string): string | undefined {
  const agentWritable = (path: string): boolean =>
    [root, pairHome()].some((dir) => path === dir || path.startsWith(`${dir}${sep}`));
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
  const registered = readdirOrEmpty(pairHome())
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pairHome(), entry.name))
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
  }
  return `listening: pair will queue a short "pair:" note into this session when a message for codex arrives in ${channel}. End your turn now.`;
}

/**
 * One nudge per session and message, even with several MCP processes on one session. The file sits in
 * the thread directory, so it's archived with the thread. It says "sending" while a server holds the
 * right to send, and "sent" once `codex queue` succeeded.
 */
function claimPath(thread: string, pending: string): string {
  return join(dirname(pending), `.${basename(pending)}.${thread}.notified`);
}

type Claim = "claimed" | "sent" | "busy";

/** Throws ENOENT when the thread was archived since it was read. */
function claim(path: string): Claim {
  try {
    writeFileSync(path, "sending\n", { flag: "wx" });
    return "claimed";
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }
  if (readFileSync(path, "utf8").trim() === "sent") {
    return "sent";
  }
  if (Date.now() - statSync(path).mtimeMs < CLAIM_LEASE_MS) {
    return "busy"; // another server is sending; if it fails it removes the claim and we try again
  }
  // Its sender died mid-send. ponytail: two servers taking over at the same moment may both send,
  // which costs one extra short turn; a lock for the takeover would be the upgrade.
  writeFileSync(path, "sending\n");
  return "claimed";
}

function dispatch(thread: string, watch: Watch, pending: string): void {
  watch.dispatching = true;
  const child = execFile(watch.codex, ["queue", "--thread", thread, "--message", NUDGE], { timeout: QUEUE_TIMEOUT_MS }, (error, _stdout, stderr) => {
    watch.dispatching = false;
    if (error) {
      rmSync(claimPath(thread, pending), { force: true }); // let the retry, here or in another process, claim it again
      watch.failures += 1;
      const delay = Math.min(60_000, 1000 * 2 ** watch.failures);
      watch.retryAt = Date.now() + delay;
      logListen(watch.channel, `codex queue failed for ${pending}, retrying in ${delay / 1000}s: ${stderr.trim() || error.message}`);
      return;
    }
    Object.assign(watch, { notified: pending, notifiedAt: Date.now(), stallReported: false, failures: 0 });
    logListen(watch.channel, `notified ${thread} about ${pending}`);
    try {
      writeFileSync(claimPath(thread, pending), "sent\n");
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
        claimed = claim(claimPath(thread, pending));
      } catch (error) {
        if (isMissing(error)) {
          return; // the thread was archived, or the claim released, since we looked: look again next tick
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
        `no reply to ${pending} after 10 minutes. The review may just be long, or the turn failed, was cancelled, or waits for an approval. Pair won't notify again; tell Codex to run \`pair wait --as codex\`.`,
      );
    }
  } catch (error) {
    watch.retryAt = Date.now() + 60_000;
    logListen(watch.channel, `poll failed, retrying in 60s: ${error instanceof Error ? error.message : String(error)}`);
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
      respond({ id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
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
    return actual === expected ? "current" : "stale";
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
    lastEvent = readFileSync(join(channel, LISTEN_LOG), "utf8").trimEnd().split("\n").at(-1);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  return [`codex notifications: ${registration}`, ...(lastEvent ? [`  last listener event: ${lastEvent}`] : [])];
}

function status(channel: string, root: string): string {
  const lanes = channelAccess(channel, () => AGENTS.map((agent) => describe(channel, agent)));
  const { name, version } = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const agents = instructionState(join(root, "AGENTS.md"), codexSection(), true);
  const skill = instructionState(join(root, ".claude", "skills", "pair", "SKILL.md"), claudeSkill());
  return [
    `channel: ${channel}`,
    `worktree: ${root}`,
    `version: ${name} ${version}`,
    ...lanes,
    "instructions on disk (does not verify what running agents loaded):",
    `  AGENTS.md (pair section): ${agents}`,
    `  .claude/skills/pair/SKILL.md: ${skill}`,
    ...channelAccess(channel, () => notificationStatus(channel)),
    ...(agents === "missing" || agents === "stale" || skill === "missing" || skill === "stale"
      ? ["Run `pair init` to refresh missing or stale instructions, then reload agent sessions."] : []),
    ...(agents.startsWith("unreadable") || skill.startsWith("unreadable")
      ? ["Check permissions on the unreadable instruction paths before refreshing them."] : []),
  ].join("\n");
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

function renderPrompt(agent: Agent): string {
  const template = readFileSync(join(PACKAGE_ROOT, "prompts", "pair.md"), "utf8");
  return template.replaceAll("{{AGENT}}", agent).replaceAll("{{PARTNER}}", partnerOf(agent));
}

function claudeSkill(): string {
  const header = `---\nname: pair\ndescription: Request a code review from codex after finishing a task, or act as codex's reviewer ("be my reviewer", "listen"), via the pair CLI.\n---\n\n`;
  return header + renderPrompt("claude");
}

function codexSection(): string {
  return `<!-- pair:start -->\n${renderPrompt("codex").trimEnd()}\n<!-- pair:end -->\n`;
}

function init(channel: string, root: string): string {
  channelAccess(channel, () => mkdirSync(channel, { recursive: true }));

  const skillDir = join(root, ".claude", "skills", "pair");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), claudeSkill());

  const agentsPath = join(root, "AGENTS.md");
  const section = codexSection();
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const updated = PAIR_SECTION.test(existing) ? existing.replace(PAIR_SECTION, () => section) : `${existing}${existing ? "\n" : ""}${section}`;
  writeFileSync(agentsPath, updated);

  return [
    `channel: ${channel}`,
    `wrote: ${join(skillDir, "SKILL.md")}`,
    `wrote: ${agentsPath} (pair section)`,
    "",
    sandboxConfig(channel),
    "",
    "To let pair wake Codex when a message arrives, instead of Codex polling, register pair's MCP server once:",
    `  codex mcp add --env ${JSON.stringify(`PAIR_CODEX=${findCodex(root) ?? "<absolute path of codex>"}`)} pair -- ${JSON.stringify(join(PACKAGE_ROOT, "dist", "pair.js"))} mcp`,
  ].join("\n");
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
  pair send <request|review|response> --as <claude|codex> [--verdict approve|changes] <file|->
  pair wait --as <claude|codex> [--timeout seconds]   (prints "no message … yet" on timeout: run again)
  pair status
  pair history [thread-id]                            (list finished threads, or show one)
  pair clean --keep N                                 (delete all but the N newest finished threads)
  pair init
  pair register | unregister                          (in Codex's shell: let pair_listen notify this session)
  pair mcp                                            (stdio MCP server for Codex, providing pair_listen)`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { as: { type: "string" }, verdict: { type: "string" }, timeout: { type: "string" }, keep: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  const root = worktreeRoot();
  const channel = channelDir(root);
  const agent = (): Agent => oneOf(values.as ?? process.env.PAIR_AGENT, AGENTS, "--as (or PAIR_AGENT)");

  switch (command) {
    case "send": {
      autoKeep(); // reject a bad PAIR_KEEP before touching any thread
      const type = oneOf(rest[0], MESSAGE_TYPES, "message type");
      const verdict = values.verdict === undefined ? undefined : oneOf(values.verdict, VERDICTS, "--verdict");
      const me = agent();
      const body = readBody(rest[1]);
      console.log(`sent: ${channelAccess(channel, () => send(channel, me, type, body, verdict))}`);
      return 0;
    }
    case "wait": {
      autoKeep(); // reject a bad PAIR_KEEP before touching any thread
      const me = agent();
      const timeout = positiveNumber(values.timeout ?? String(DEFAULT_WAIT_SECONDS), "--timeout");
      if (!(await wait(channel, me, timeout))) {
        // Exit 0: a timeout is routine, and agent UIs show any non-zero exit as a failure.
        console.log(`pair: no message for ${me} yet. Run \`pair wait --as ${me}\` again.`);
      }
      return 0;
    }
    case "status":
      console.log(status(channel, root));
      return 0;
    case "history":
      console.log(channelAccess(channel, () => history(channel, rest[0])));
      return 0;
    case "clean":
      console.log(channelAccess(channel, () => clean(channel, values.keep)));
      return 0;
    case "init":
      console.log(init(channel, root));
      return 0;
    case "register":
      console.log(channelAccess(channel, () => register(channel, root)));
      return 0;
    case "unregister":
      console.log(channelAccess(channel, () => unregister(channel)));
      return 0;
    case "mcp":
      await serveMcp();
      return 0;
    default:
      console.error(USAGE);
      return 1;
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
