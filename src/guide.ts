import { createInterface } from "node:readline";
import type { ModelList } from "./auto.js";

/** Guided pair start: asks for what the command line left out and returns the pair start arguments that say it. */

export type Cli = "claude" | "codex";

export interface Prompter {
  /** The answer, or undefined once the person cancelled (Ctrl-C or end of input). */
  ask(question: string): Promise<string | undefined>;
  say(text: string): void;
}

/** Read-only facts about this machine and checkout. */
export interface StartFacts {
  /** The CLIs pair can run, after --claude and --codex. */
  installed: Cli[];
  /** A git repository: --worktree is possible. */
  git: boolean;
  /** This checkout's directory name: --worktree NAME runs in ../<repo>-NAME. */
  repo: string;
  /** Throws why NAME can't be a --worktree. */
  checkWorktree(name: string): void;
  /** The conversation pair start --resume would continue for this author CLI and --worktree, if any. */
  recorded(cli: Cli, worktree: string | undefined): { id: string; at: string } | undefined;
  /** Throws why MODEL can't be a --reviewer-model. */
  checkModel(model: string): void;
  /** The models a reviewer CLI is known to accept: the ones not hidden are offered, any other is typed. */
  models(cli: Cli): ModelList;
  efforts: Record<Cli, readonly string[]>;
}

/** What the command line already chose; its questions are skipped. */
export interface StartGiven {
  worktree?: string;
  resume: boolean;
  /** --reviewer-model: its efforts, if known, are the ones offered. */
  model?: string;
  effort: boolean;
  /** A custom PAIR_AGENT name: a CLI word would make pair start ignore it, so it is kept with --as. */
  envName?: string;
}

const CLIS: readonly Cli[] = ["claude", "codex"];

/** The arguments to add after the command word, or undefined when the person cancelled. */
export async function guideStart(prompter: Prompter, facts: StartFacts, given: StartGiven): Promise<string[] | undefined> {
  if (facts.installed.length === 0) {
    throw new Error("neither claude nor codex was found; install one, or pass --claude or --codex /absolute/path");
  }
  const missing = CLIS.filter((cli) => !facts.installed.includes(cli));
  const flags = given.envName ? ["--as", given.envName] : [];
  // A conversation to resume comes first: it names the author's CLI and the checkout.
  let author: Cli | undefined;
  const found = facts.installed.map((cli) => ({ cli, record: facts.recorded(cli, given.worktree) })).find((each) => each.record);
  let resumed = given.resume;
  if (found && given.resume) {
    author = found.cli;
  } else if (found?.record) {
    const resume = await yesNo(prompter, `Resume the ${found.cli} conversation ${found.record.id} (recorded ${found.record.at})? [y/N] `);
    if (resume === undefined) return undefined;
    if (resume) {
      author = found.cli;
      resumed = true;
      flags.push("--resume");
    }
  }
  author ??= await choose(prompter, "Author CLI", CLIS, undefined, missing);
  if (author === undefined) return undefined;
  const other: Cli = author === "claude" ? "codex" : "claude";
  const reviewer = await choose(prompter, "Reviewer CLI", CLIS, facts.installed.includes(other) ? other : undefined, missing);
  if (reviewer === undefined) return undefined;

  if (given.worktree === undefined && !resumed && facts.git) {
    const worktree = await validated(prompter, `Run in: Enter for this checkout, or a branch name for a worktree ../${facts.repo}-NAME: `, (name) => facts.checkWorktree(name));
    if (worktree === undefined) return undefined;
    // Another checkout: its own recorded conversation, if any.
    const record = worktree ? facts.recorded(author, worktree) : undefined;
    if (worktree) flags.push("--worktree", worktree);
    if (record) {
      const resume = await yesNo(prompter, `Resume the ${author} conversation ${record.id} (recorded ${record.at})? [y/N] `);
      if (resume === undefined) return undefined;
      if (resume) flags.push("--resume");
    }
  }
  const fallback = `${reviewer}'s default`;
  const known = facts.models(reviewer);
  const offered = known.models.filter((each) => !each.hidden);
  let model = given.model;
  while (model === undefined) {
    const answer = offered.length === 0
      ? await validated(prompter, `Reviewer model: Enter for ${fallback}, or a model ID or alias: `, (value) => facts.checkModel(value))
      : await choose(prompter, "Reviewer model (a number, or any model ID)", [fallback, ...offered.map((each) => each.id)], fallback, [], (text) => {
        facts.checkModel(text);
        return text;
      });
    if (answer === undefined) return undefined;
    if (!answer || answer === fallback) break;
    // A typo is likelier than a model the CLI's own list lacks, but that list can lag a new model.
    if (known.complete && !known.models.some((each) => each.id === answer)) {
      const anyway = await yesNo(prompter, `${answer} isn't one of the models ${reviewer} lists for your account; use it anyway? [y/N] `);
      if (anyway === undefined) return undefined;
      if (!anyway) continue;
    }
    model = answer;
    flags.push("--reviewer-model", model);
  }
  if (!given.effort) {
    // The model's own efforts, when its CLI lists them; pair still accepts only its own.
    const supported = known.models.find((each) => each.id === model)?.efforts;
    const efforts = facts.efforts[reviewer].filter((effort) => supported?.includes(effort) ?? true);
    const effort = await choose(prompter, "Reviewer effort", [fallback, ...(efforts.length ? efforts : facts.efforts[reviewer])], fallback);
    if (effort === undefined) return undefined;
    if (effort !== fallback) flags.push("--reviewer-effort", effort);
  }
  return [author, ...(reviewer === other ? [] : [reviewer]), ...flags];
}

/** A numbered menu answered by number or name; Enter takes the fallback, if there is one. With other, any other text it accepts. */
async function choose<T extends string>(prompter: Prompter, question: string, choices: readonly T[], fallback?: T, unavailable: readonly T[] = [], other?: (text: string) => T): Promise<T | undefined> {
  const menu = choices.map((choice, index) => `${index + 1}) ${choice}${unavailable.includes(choice) ? " (not found)" : ""}`).join("  ");
  for (;;) {
    const answer = await prompter.ask(`${question}: ${menu}${fallback === undefined ? "" : ` [${fallback}]`} `);
    if (answer === undefined) return undefined;
    const text = answer.trim();
    const chosen = text === "" ? fallback : choices[Number(text) - 1] ?? choices.find((choice) => choice === text);
    if (chosen !== undefined && !unavailable.includes(chosen)) return chosen;
    if (chosen === undefined && other !== undefined && !/^\d*$/.test(text)) {
      try {
        return other(text);
      } catch (error) {
        prompter.say(reason(error));
        continue;
      }
    }
    const available = choices.filter((choice) => !unavailable.includes(choice));
    prompter.say(chosen === undefined ? `Choose ${available.map((choice) => `${choices.indexOf(choice) + 1} (${choice})`).join(" or ")}.` : `${chosen} was not found; choose another.`);
  }
}

/** Free text checked by check; Enter answers "". */
async function validated(prompter: Prompter, question: string, check: (value: string) => void): Promise<string | undefined> {
  for (;;) {
    const answer = await prompter.ask(question);
    if (answer === undefined) return undefined;
    const text = answer.trim();
    if (!text) return "";
    try {
      check(text);
      return text;
    } catch (error) {
      prompter.say(reason(error));
    }
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function yesNo(prompter: Prompter, question: string): Promise<boolean | undefined> {
  for (;;) {
    const answer = await prompter.ask(question);
    if (answer === undefined) return undefined;
    const text = answer.trim().toLowerCase();
    if (text === "" || text === "n" || text === "no") return false;
    if (text === "y" || text === "yes") return true;
    prompter.say("Answer y or n.");
  }
}

/** argv with the guided arguments right after the command word, so they stay before any --. */
export function guidedArgv(argv: readonly string[], commandIndex: number, added: readonly string[]): string[] {
  return [...argv.slice(0, commandIndex + 1), ...added, ...argv.slice(commandIndex + 1)];
}

/** Questions over readline. Lines typed ahead wait for their question; Ctrl-C and end of input cancel. */
export function linePrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream & { isTTY?: boolean }): Prompter & { close(): void } {
  const prompt = createInterface({ input, output, terminal: Boolean(output.isTTY) });
  let closed = false;
  prompt.once("close", () => { closed = true; });
  prompt.on("SIGINT", () => {
    output.write("\n");
    prompt.close();
  });
  const lines = prompt[Symbol.asyncIterator]();
  return {
    async ask(question) {
      if (closed) return undefined;
      prompt.setPrompt(question);
      prompt.prompt();
      const next = await lines.next();
      return next.done ? undefined : next.value;
    },
    say(text) {
      output.write(`${text}\n`);
    },
    close() {
      prompt.close();
      input.pause();
    },
  };
}
