#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
const EXIT_TIMEOUT = 2;
const MESSAGE_FILE = /^(\d{3})-(request|review|response)\.md$/;
// archive/<thread id>-<author>-to-<reviewer>-<outcome>; the id starts with a timestamp
const ARCHIVED_THREAD = /^(.+)-(claude|codex)-to-(claude|codex)-(approved|escalated)$/;

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
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

function channelDir(): string {
  // realpath so /tmp/x and /private/tmp/x (or any symlinked checkout) share one channel
  const key = realpathSync(gitPath("--git-common-dir") ?? process.cwd());
  const name = basename(key) === ".git" ? basename(dirname(key)) : basename(key);
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return join(process.env.PAIR_HOME ?? join(homedir(), ".pair"), `${name}-${hash}`);
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
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`pair: warning: automatic cleanup failed (${reason}). Fix it, then run \`pair clean --keep ${keep}\`.`);
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

async function wait(channel: string, me: Agent, timeoutSeconds: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const pending = pendingFor(channel, me);
    if (pending) {
      const output = formatMessage(me, pending);
      if (pending.state.kind === "closed") {
        archive(channel, pending.state.last);
      }
      return output;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await sleep(POLL_MS);
  }
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

function status(channel: string): string {
  return [`channel: ${channel}`, ...AGENTS.map((agent) => describe(channel, agent))].join("\n");
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
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "pair.md"), "utf8");
  return template.replaceAll("{{AGENT}}", agent).replaceAll("{{PARTNER}}", partnerOf(agent));
}

function init(channel: string): string {
  mkdirSync(channel, { recursive: true });
  const root = gitPath("--show-toplevel") ?? process.cwd();

  const skillDir = join(root, ".claude", "skills", "pair");
  mkdirSync(skillDir, { recursive: true });
  const skillHeader = `---\nname: pair\ndescription: Request a code review from codex after finishing a task, or act as codex's reviewer ("be my reviewer", "listen"), via the pair CLI.\n---\n\n`;
  writeFileSync(join(skillDir, "SKILL.md"), skillHeader + renderPrompt("claude"));

  const agentsPath = join(root, "AGENTS.md");
  const section = `<!-- pair:start -->\n${renderPrompt("codex").trimEnd()}\n<!-- pair:end -->\n`;
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const marked = /<!-- pair:start -->[\s\S]*?<!-- pair:end -->\n?/;
  const updated = marked.test(existing) ? existing.replace(marked, () => section) : `${existing}${existing ? "\n" : ""}${section}`;
  writeFileSync(agentsPath, updated);

  const pairHome = dirname(channel);
  return [
    `channel: ${channel}`,
    `wrote: ${join(skillDir, "SKILL.md")}`,
    `wrote: ${agentsPath} (pair section)`,
    "",
    "Both sandboxes must allow writes to the channel. Add:",
    "",
    "  ~/.codex/config.toml",
    "    [sandbox_workspace_write]",
    `    writable_roots = ["${pairHome}"]`,
    "",
    "  ~/.claude/settings.json",
    `    "sandbox": { "filesystem": { "allowWrite": ["${pairHome}"] } }`,
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
  pair wait --as <claude|codex> [--timeout seconds]   (exit ${EXIT_TIMEOUT} = nothing yet, run again)
  pair status
  pair history [thread-id]                            (list finished threads, or show one)
  pair clean --keep N                                 (delete all but the N newest finished threads)
  pair init`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { as: { type: "string" }, verdict: { type: "string" }, timeout: { type: "string" }, keep: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  const channel = channelDir();
  const agent = (): Agent => oneOf(values.as ?? process.env.PAIR_AGENT, AGENTS, "--as (or PAIR_AGENT)");

  switch (command) {
    case "send": {
      autoKeep(); // reject a bad PAIR_KEEP before touching any thread
      const type = oneOf(rest[0], MESSAGE_TYPES, "message type");
      const verdict = values.verdict === undefined ? undefined : oneOf(values.verdict, VERDICTS, "--verdict");
      console.log(`sent: ${send(channel, agent(), type, readBody(rest[1]), verdict)}`);
      return 0;
    }
    case "wait": {
      autoKeep(); // reject a bad PAIR_KEEP before touching any thread
      const me = agent();
      const timeout = positiveNumber(values.timeout ?? String(DEFAULT_WAIT_SECONDS), "--timeout");
      const output = await wait(channel, me, timeout);
      if (!output) {
        console.log(`pair: no message for ${me} yet. Run \`pair wait --as ${me}\` again.`);
        return EXIT_TIMEOUT;
      }
      console.log(output);
      return 0;
    }
    case "status":
      console.log(status(channel));
      return 0;
    case "history":
      console.log(history(channel, rest[0]));
      return 0;
    case "clean":
      console.log(clean(channel, values.keep));
      return 0;
    case "init":
      console.log(init(channel));
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
