#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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
type ThreadStatus = "open" | "approved" | "escalated";

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_WAIT_SECONDS = 540; // stays under Claude Code's 10-minute Bash cap
const POLL_MS = 1000;
const EXIT_TIMEOUT = 2;
const MESSAGE_FILE = /^(\d{3})-(request|review|response)\.md$/;

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
  dir: string;
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
  return { dir: join(channel, `${author}-to-${reviewer}`), author, reviewer };
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

function readMessage(path: string): Message {
  const { fields, body } = parseFrontmatter(readFileSync(path, "utf8"));
  return {
    file: path,
    from: fields.from as Agent,
    type: fields.type as MessageType,
    round: Number(fields.round),
    verdict: fields.verdict as Verdict | undefined,
    status: (fields.status ?? "open") as ThreadStatus,
    body,
  };
}

function listMessages(thread: Thread): Message[] {
  try {
    return readdirSync(thread.dir)
      .filter((name) => MESSAGE_FILE.test(name))
      .sort()
      .map((name) => readMessage(join(thread.dir, name)));
  } catch (error) {
    // No dir means idle. The author's wait may also archive the dir mid-read, which means closed.
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

function archive(channel: string, thread: Thread, status: ThreadStatus): void {
  const archiveDir = join(channel, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    renameSync(thread.dir, join(archiveDir, `${stamp}-${basename(thread.dir)}-${status}`));
  } catch (error) {
    // A concurrent wait for the same agent already archived it.
    if (!isMissing(error)) {
      throw error;
    }
  }
}

function writeMessage(thread: Thread, seq: number, message: Omit<Message, "file" | "body">, body: string): string {
  mkdirSync(thread.dir, { recursive: true });
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
  const finalPath = join(thread.dir, name);
  const tmpPath = join(thread.dir, `.${name}.tmp`);
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
      archive(channel, thread, state.last.status);
    }
    return writeMessage(thread, 1, { from: me, type, round: 1, status: "open" }, body);
  }
  if (state.kind !== "awaiting-response") {
    throw new PairError(`cannot send response: no open review from ${thread.reviewer} (thread is ${state.kind})`);
  }
  const round = state.last.round + 1;
  return writeMessage(thread, messages.length + 1, { from: me, type, round, status: "open" }, body);
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
  const path = writeMessage(thread, messages.length + 1, { from: me, type: "review", round, verdict, status }, body);
  return status === "escalated" ? `${path}\nthread escalated: round cap (${maxRounds()}) reached. The user decides next.` : path;
}

/** Returns a thread where it is `me`'s turn to act, if any. Author duties come first. */
function pendingFor(channel: string, me: Agent): { thread: Thread; state: ActiveState } | undefined {
  const asAuthor = threadFor(channel, me);
  const authorState = stateOf(listMessages(asAuthor));
  if (authorState.kind === "awaiting-response" || authorState.kind === "closed") {
    return { thread: asAuthor, state: authorState };
  }
  const asReviewer = threadFor(channel, partnerOf(me));
  const reviewerState = stateOf(listMessages(asReviewer));
  if (reviewerState.kind === "awaiting-review") {
    return { thread: asReviewer, state: reviewerState };
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
        : `ESCALATED: round cap (${maxRounds()}) reached with open findings. STOP and ask the user how to proceed.`;
  }
}

function formatMessage(me: Agent, thread: Thread, state: ActiveState): string {
  const { last } = state;
  const verdict = last.verdict ? ` · verdict ${last.verdict}` : "";
  const header = `== pair: ${last.type} from ${last.from} · ${basename(thread.dir)} · round ${last.round}${verdict} ==`;
  return `${header}\n${last.body.trimEnd()}\n== next: ${nextStep(me, state)} ==`;
}

async function wait(channel: string, me: Agent, timeoutSeconds: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const pending = pendingFor(channel, me);
    if (pending) {
      const output = formatMessage(me, pending.thread, pending.state);
      if (pending.state.kind === "closed") {
        archive(channel, pending.thread, pending.state.last.status);
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
    return `${basename(thread.dir)}: idle`;
  }
  const turn = state.kind === "awaiting-review" ? thread.reviewer : thread.author;
  return `${basename(thread.dir)}: ${state.kind} (round ${state.last.round}, ${turn}'s turn)`;
}

function status(channel: string): string {
  return [`channel: ${channel}`, ...AGENTS.map((agent) => describe(channel, agent))].join("\n");
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
  pair init`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { as: { type: "string" }, verdict: { type: "string" }, timeout: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  const channel = channelDir();
  const agent = (): Agent => oneOf(values.as ?? process.env.PAIR_AGENT, AGENTS, "--as (or PAIR_AGENT)");

  switch (command) {
    case "send": {
      const type = oneOf(rest[0], MESSAGE_TYPES, "message type");
      const verdict = values.verdict === undefined ? undefined : oneOf(values.verdict, VERDICTS, "--verdict");
      console.log(`sent: ${send(channel, agent(), type, readBody(rest[1]), verdict)}`);
      return 0;
    }
    case "wait": {
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
