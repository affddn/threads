import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { z } from "zod";
import { serialized, workflowExecutionAuthorized } from "./threads";
import type { WorktreeKeptReason, WorkflowRun, WorkflowStep } from "./workflow-types";
import { WORKTREE_PARENT, inside, workflowWorktreeName } from "./workflow-worker";

export type CheckoutState = "clean" | "changes" | "commits" | "nested";
export type InspectCheckout = (directory: string, signal?: AbortSignal) => Promise<CheckoutState>;
export type Sweep = {
  outcome: "removed" | "would-remove" | "kept" | "missing";
  reason?: z.infer<typeof WorktreeKeptReason>;
  message?: string;
};

const MESSAGE_LIMIT = 500;
const OUTPUT_LIMIT = 4_096;
const COMPLETE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const IDLE_PROBE_MS = 250;
const ended = new Set<string>(["completed", "failed", "stopped"]);
const bounded = (text: string) => text.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT)}…`;
const describe = (error: unknown) => bounded(error instanceof Error ? error.message
  : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message
  : String(error));
const resolved = (path: string) => realpath(path).catch(() => path);
const kept = {
  changes: { outcome: "kept", reason: "changes", message: "The checkout has uncommitted or untracked changes." },
  commits: { outcome: "kept", reason: "commits", message: "HEAD has commits that no branch, tag, or remote contains." },
  nested: { outcome: "kept", reason: "nested", message: "Another worktree is inside this checkout." },
  unregistered: { outcome: "kept", reason: "unregistered", message: "No known project lists this directory as a worktree." },
  located: { outcome: "kept", reason: "in-use", message: "A conversation is located in this directory." },
  running: { outcome: "kept", reason: "in-use", message: "A worker in this directory is still running." },
  stopped: { outcome: "kept", reason: "error", message: "Cleanup stopped before it finished." },
} satisfies Record<string, Sweep>;
const missingSession = (error: unknown, sessionID: string) => typeof error === "object" && error !== null &&
  "_tag" in error && error._tag === "Session.NotFoundError" && "sessionID" in error && error.sessionID === sessionID;

// `complete` output must be read whole; otherwise only whether there is output matters.
function git(directory: string, args: string[], complete: boolean, signal?: AbortSignal) {
  const limit = complete ? COMPLETE_OUTPUT_LIMIT : OUTPUT_LIMIT;
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Cleanup stopped"));
    const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...env } = process.env;
    const child = spawn("git", ["-C", directory, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const stop = () => child.kill();
    const timer = setTimeout(stop, GIT_TIMEOUT_MS);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > limit) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (truncated && complete) reject(new Error(`git ${args[0]} output is too long to check`));
      else if (code === 0 || truncated) resolve(stdout);
      else reject(new Error(stderr.trim() || `git ${args[0]} exited with ${code ?? "a signal"}`));
    });
  });
}

// Read-only. `git worktree remove` refuses "changes" by itself, but it deletes ignored files, which can
// hide a nested worktree. "commits" are reachable only from this checkout's detached HEAD.
export const inspectCheckout: InspectCheckout = async (directory, signal) => {
  const real = await realpath(directory);
  const top = (await git(directory, ["rev-parse", "--show-toplevel"], true, signal)).trim();
  if (await realpath(top) !== real) throw new Error(`${directory} is not the top of a git checkout`);
  const linked = (await git(directory, ["worktree", "list", "--porcelain"], true, signal)).split("\n")
    .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  for (const path of linked) {
    const other = await resolved(path);
    if (other !== real && inside(other, real)) return "nested";
  }
  if ((await git(directory, ["status", "--porcelain", "--untracked-files=normal"], false, signal)).trim()) return "changes";
  if ((await git(directory, ["rev-list", "-n", "1", "HEAD", "--not", "--branches", "--tags", "--remotes"], false, signal)).trim()) return "commits";
  return "clean";
};

// Only checkouts at the exact path this engine planned for the step. Shared steps run in their source.
// Deepest first, so a pass clears a nested checkout before the one that contains it.
export function worktreeSteps(run: WorkflowRun): WorkflowStep[] {
  const depth = (step: WorkflowStep) => step.directory.split(sep).length;
  return run.steps.filter((step) => step.input.isolation === "worktree"
    && basename(dirname(step.directory)) === WORKTREE_PARENT
    && basename(step.directory) === workflowWorktreeName(run.id, step.key))
    .sort((a, b) => depth(b) - depth(a));
}

function checkoutRoots(path: string) {
  const parts = path.split(sep);
  return parts.flatMap((part, index) => part === WORKTREE_PARENT && index + 1 < parts.length ? [parts.slice(0, index + 2).join(sep)] : []);
}

// Recording a workflow directory and removing a checkout that contains it exclude each other.
export async function withCheckouts<T>(paths: readonly string[], task: () => Promise<T>): Promise<T> {
  const roots = [...new Set((await Promise.all(paths.map(resolved))).flatMap(checkoutRoots))]
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return roots.reduceRight<() => Promise<T>>((inner, root) => () => serialized(`workflow-checkout:${root}`, inner), task)();
}

// Follow-up admission to these workers waits until the removal settles.
function withFollowups<T>(workerIDs: readonly string[], task: () => Promise<T>): Promise<T> {
  return [...new Set(workerIDs)].sort().reduceRight<() => Promise<T>>((inner, workerID) => () => serialized(`followup/${workerID}`, inner), task)();
}

function forceRequired(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  if ("forceRequired" in error && error.forceRequired === true) return true;
  return "data" in error && typeof error.data === "object" && error.data !== null &&
    "forceRequired" in error.data && error.data.forceRequired === true;
}

export async function isDirectory(path: string) {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

async function anyInside(paths: readonly string[], directory: string) {
  for (const path of paths) if (inside(await resolved(path), directory)) return true;
  return false;
}

// One sweeper per pass. `runs` returns current records of every run whose steps could use or nest
// within a checkout. `occupied` lists other conversation locations to keep, such as the caller's.
// `signal` stops the pass before its next removal.
export function worktreeSweeper(
  ctx: Pick<Plugin.Context, "session" | "worktree">,
  inspect: InspectCheckout,
  runs: () => Promise<WorkflowRun[]>,
  options: { occupied?: readonly string[]; signal?: AbortSignal } = {},
) {
  const { occupied = [], signal } = options;
  const inventories = new Map<string, Promise<string[]>>();
  const inventory = (projectID: string) => {
    let entries = inventories.get(projectID);
    if (!entries) {
      entries = ctx.worktree.list({ projectID }).then((items) => items.map((item) => item.directory)).catch(() => []);
      inventories.set(projectID, entries);
    }
    return entries;
  };
  // Idle only when the wait settles promptly, or the session no longer exists.
  const activity = async (workerID: string): Promise<Sweep | undefined> => {
    if (workflowExecutionAuthorized(workerID)) return kept.running;
    const probe = await Promise.race([
      ctx.session.wait({ sessionID: workerID }).then(() => "idle" as const, (error: unknown) => missingSession(error, workerID) ? "idle" as const : error),
      Bun.sleep(IDLE_PROBE_MS).then(() => "running" as const),
    ]);
    if (probe === "idle") return undefined;
    if (probe === "running") return kept.running;
    return { outcome: "kept", reason: "error", message: `Could not confirm that a worker in this directory is idle: ${describe(probe)}` };
  };
  // The checkout belongs to the project of the step's source, which the worker session records.
  async function locate(run: WorkflowRun, step: WorkflowStep) {
    const worker = await ctx.session.get({ sessionID: step.workerID }).then((session) => session.projectID as string).catch(() => undefined);
    const real = await resolved(step.directory);
    for (const projectID of new Set([worker, run.projectID])) {
      if (projectID === undefined) continue;
      const directory = (await inventory(projectID)).find((entry) => entry === step.directory || entry === real);
      if (directory !== undefined) return { projectID, directory };
    }
    return undefined;
  }
  async function sweep(run: WorkflowRun, location: { projectID: string; directory: string }, apply: boolean): Promise<Sweep> {
    const candidate = location.directory;
    const current = await runs();
    for (const other of current) {
      if (ended.has(other.status) || other.id === run.id) continue;
      if (await anyInside([other.directory, ...other.steps.flatMap((step) => [step.directory, ...(step.input.directory === undefined ? [] : [step.input.directory])])], candidate)) {
        return { outcome: "kept", reason: "in-use", message: `Unfinished workflow ${other.id} (${other.status}) uses this directory.` };
      }
    }
    for (const step of current.flatMap(worktreeSteps)) {
      if (step.directory !== candidate && inside(await resolved(step.directory), candidate) && await isDirectory(step.directory)) return kept.nested;
    }
    const owner = await ctx.session.get({ sessionID: run.ownerID }).then((session) => session.location.directory as string).catch(() => undefined);
    if (await anyInside([...(owner === undefined ? [] : [owner]), ...occupied], candidate)) return kept.located;
    const workers = current.flatMap((other) => other.steps.filter((step) => inside(step.directory, candidate)).map((step) => step.workerID));
    return withFollowups(workers, async () => {
      for (const workerID of workers) {
        const active = await activity(workerID);
        if (active) return active;
      }
      let state: CheckoutState;
      try {
        state = await inspect(candidate, signal);
      } catch (error) {
        if (signal?.aborted) return kept.stopped;
        return { outcome: "kept", reason: "error", message: `Could not inspect the checkout: ${describe(error)}` };
      }
      if (state !== "clean") return kept[state];
      if (!apply) return { outcome: "would-remove" };
      if (signal?.aborted) return kept.stopped;
      try {
        await ctx.worktree.remove({ projectID: location.projectID, directory: candidate, force: false });
        return { outcome: "removed" };
      } catch (error) {
        if (forceRequired(error)) return kept.changes;
        return { outcome: "kept", reason: "error", message: `Could not remove the worktree: ${describe(error)}` };
      }
    });
  }
  return async (run: WorkflowRun, step: WorkflowStep, apply: boolean): Promise<Sweep> => {
    if (signal?.aborted) return kept.stopped;
    if (!await isDirectory(step.directory)) return { outcome: "missing" };
    const location = await locate(run, step);
    if (!location) return kept.unregistered;
    return withCheckouts([location.directory], () => sweep(run, location, apply));
  };
}
