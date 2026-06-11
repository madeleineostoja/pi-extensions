import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, sep } from "node:path";
export type RunMode = "auto" | "serial" | "parallel";

export type RunJson = {
  version: 1;
  runId: string;
  mode: RunMode;
  strategyReason: string;
  repoRoot: string;
  checkoutRoot?: string;
  planPath: string;
  planHash: string;
  baseSha: string;
  currentPhase: string;
  maxConcurrency: number;
  startedAt: string;
  updatedAt: string;
};

export type TaskStatus =
  | "pending"
  | "ready"
  | "coding"
  | "reviewing"
  | "approved"
  | "integrating"
  | "landed"
  | "satisfied"
  | "blocked"
  | "needs_rework"
  | "integration_failed"
  | "failed"
  | "stopped";

export type TaskJson = {
  id: string;
  planIndex: number;
  title: string;
  status: TaskStatus;
  dependsOn: string[];
  attempts: number;
  integrationAttempts: number;
  baseSha?: string;
  worktreePath?: string;
  branchName?: string;
  taskCommitSha?: string;
  landedCommitSha?: string;
  activeSubagentIds?: string[];
  lastReason?: string;
  commitMessage?: string;
  selfHealAttempts?: number;
  scout?: {
    calls: number;
    lastStatus?: "completed" | "failed" | "stopped" | "skipped";
    lastReason?: string;
  };
  review?: {
    lastDecision: "reviewed" | "skipped" | "required";
    lastReason?: string;
    skippedCount?: number;
    reviewedCount?: number;
  };
};

export type EventEntry =
  | { type: "strategy_selected"; reason: string; mode: RunMode }
  | { type: "task_started"; taskId: string }
  | { type: "task_approved"; taskId: string; commitSha?: string }
  | { type: "integration_failed"; taskId: string; reason: string }
  | { type: "task_landed"; taskId: string; commitSha: string }
  | { type: "task_satisfied"; taskId: string }
  | { type: "cleanup_failed"; reason: string }
  | { type: "run_started"; runId: string }
  | { type: "run_stopped" }
  | { type: "run_blocked"; reason: string }
  | { type: "run_done" }
  | { type: "self_heal_started"; taskId: string; attempt: number }
  | {
      type: "self_heal_completed";
      taskId: string;
      attempt: number;
      result: string;
    }
  | {
      type: "self_heal_failed";
      taskId: string;
      attempt: number;
      reason: string;
    }
  | { type: "scheduler_self_heal_started"; attempt: number }
  | {
      type: "scheduler_self_heal_completed";
      attempt: number;
      result: string;
    }
  | { type: "scheduler_self_heal_failed"; attempt: number; reason: string }
  | { type: "task_self_heal_requeued"; taskId: string; reason: string }
  | { type: "overall_review_changes_requested"; requiredChanges: string[] }
  | { type: "overall_review_approved" }
  | { type: "overall_rework_started"; attempt: number; artifactPath?: string }
  | { type: "overall_rework_failed"; attempt: number; reason: string }
  | { type: "overall_rework_committed"; attempt: number; commitSha: string };

export type DurableEvent = EventEntry & { timestamp: string };

export type RunLock = {
  version: 1;
  runId: string;
  runDir: string;
  startedAt: string;
  pid: number;
  hostname: string;
  checkoutRoot?: string;
};

export type StatePaths = {
  baseDir: string;
  runDir: string;
  runJson: string;
  eventsJsonl: string;
  planSnapshot: string;
  tasksDir: string;
  worktreesDir: string;
  locksDir?: string;
  lockFile: string;
};

export type LockCheckResult =
  | { active: false; staleRemoved?: string }
  | { active: true; reason: string; lock?: Partial<RunLock> };

export type AcquireRunLockResult =
  | { ok: true; staleRemoved?: string }
  | { ok: false; reason: string; lock?: Partial<RunLock> };

export type CheckRunLocksResult = {
  active: Array<{ reason: string; lock?: Partial<RunLock> }>;
  staleRemoved: string[];
};

export function getBaseDir(repoRoot: string): string {
  return join(repoRoot, ".pi", "implement");
}

export function getStatePaths(
  repoRoot: string,
  runId: string,
  checkoutRoot = repoRoot,
): StatePaths {
  const baseDir = getBaseDir(repoRoot);
  const runDir = join(baseDir, "runs", runId);
  const locksDir = join(baseDir, "locks");
  return {
    baseDir,
    runDir,
    runJson: join(runDir, "run.json"),
    eventsJsonl: join(runDir, "events.jsonl"),
    planSnapshot: join(runDir, "plan.snapshot.md"),
    tasksDir: join(runDir, "tasks"),
    worktreesDir: join(baseDir, "worktrees", runId),
    locksDir,
    lockFile: join(locksDir, `checkout-${checkoutLockHash(checkoutRoot)}.lock`),
  };
}

export function makeRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `r${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return base;
}

export function makeRunIdWithSuffix(
  base: string,
  existing: Set<string>,
): string {
  if (!existing.has(base)) {
    return base;
  }
  let suffix = 1;
  while (existing.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

export function taskIdFromTask(planIndex: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const index = String(planIndex + 1).padStart(3, "0");
  return `t${index}-${slug || "task"}`;
}

export function createRunState(
  paths: StatePaths,
  run: RunJson,
  planContent: string,
): void {
  mkdirSync(dirname(paths.runDir), { recursive: true });
  mkdirSync(paths.runDir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(getLocksDir(paths), { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
  writeAtomic(paths.runJson, JSON.stringify(run, null, 2));
  if (!existsSync(paths.lockFile)) {
    writeLockFile(paths.lockFile, makeRunLock(paths, run), "w");
  }
  writeAtomic(paths.planSnapshot, planContent);
  if (!existsSync(paths.eventsJsonl)) {
    writeFileSync(paths.eventsJsonl, "", "utf-8");
  }
}

export function acquireRunLock(
  paths: StatePaths,
  run: RunJson,
): AcquireRunLockResult {
  mkdirSync(getLocksDir(paths), { recursive: true });
  const lock = makeRunLock(paths, run);
  let staleRemoved: string | undefined;

  for (;;) {
    try {
      writeLockFile(paths.lockFile, lock, "wx");
      return { ok: true, staleRemoved };
    } catch (err) {
      const nodeError = err as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") {
        return {
          ok: false,
          reason: `Could not acquire pi-implement run lock: ${nodeError.message}`,
        };
      }
    }

    const existing = checkRunLock(paths);
    if (!existing.active) {
      staleRemoved = existing.staleRemoved;
      continue;
    }
    return {
      ok: false,
      reason: `Another pi-implement run appears active: ${existing.reason}`,
      lock: existing.lock,
    };
  }
}

export function checkRunLock(paths: StatePaths): LockCheckResult {
  return checkRunLockFile(paths, paths.lockFile);
}

export function checkRunLocks(paths: StatePaths): CheckRunLocksResult {
  const locksDir = getLocksDir(paths);
  if (!existsSync(locksDir)) {
    return { active: [], staleRemoved: [] };
  }
  const active: Array<{ reason: string; lock?: Partial<RunLock> }> = [];
  const staleRemoved: string[] = [];
  for (const dirent of readdirSync(locksDir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".lock")) {
      continue;
    }
    const lockFile = join(locksDir, dirent.name);
    const result = checkRunLockFile({ ...paths, lockFile }, lockFile);
    if (result.active) {
      active.push({ reason: result.reason, lock: result.lock });
    } else if (result.staleRemoved) {
      staleRemoved.push(result.staleRemoved);
    }
  }
  return { active, staleRemoved };
}

function checkRunLockFile(
  paths: StatePaths,
  lockFile: string,
): LockCheckResult {
  if (!existsSync(lockFile)) {
    return { active: false };
  }

  const lockPaths = { ...paths, lockFile };
  const staleReason = staleRunLockReason(lockPaths);
  if (staleReason) {
    rmSync(lockFile, { force: true });
    return { active: false, staleRemoved: staleReason };
  }

  const lock = readRunLock(lockPaths);
  return {
    active: true,
    reason: formatRunLockReason(lock, lockFile),
    lock,
  };
}

export function releaseRunLock(paths: StatePaths, runId: string): void {
  const lock = readRunLock(paths);
  if (lock?.runId === runId) {
    rmSync(paths.lockFile, { force: true });
  }
}

export function writeRunJson(paths: StatePaths, run: RunJson): void {
  writeAtomic(paths.runJson, JSON.stringify(run, null, 2));
}

export function writeTaskJson(
  paths: StatePaths,
  taskId: string,
  task: TaskJson,
): void {
  const path = join(paths.tasksDir, taskId, "task.json");
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify(task, null, 2));
}

export function appendEvent(paths: StatePaths, entry: EventEntry): void {
  const event: DurableEvent = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  const line = JSON.stringify(event) + "\n";
  writeFileSync(paths.eventsJsonl, line, { flag: "a", encoding: "utf-8" });
}

export function readEvents(paths: StatePaths): DurableEvent[] {
  if (!existsSync(paths.eventsJsonl)) {
    return [];
  }
  const content = readFileSync(paths.eventsJsonl, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const events: DurableEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as DurableEvent);
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

export function readRunJson(paths: StatePaths): RunJson | undefined {
  if (!existsSync(paths.runJson)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(paths.runJson, "utf-8")) as RunJson;
  } catch {
    return undefined;
  }
}

export function readTaskJson(
  paths: StatePaths,
  taskId: string,
): TaskJson | undefined {
  const path = join(paths.tasksDir, taskId, "task.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TaskJson;
  } catch {
    return undefined;
  }
}

export function cleanupRun(paths: StatePaths): void {
  const run = readRunJson(paths);
  const runId = run?.runId ?? basename(paths.runDir);
  const cleanupEntries = readTaskCleanupEntries(paths);
  if (run?.repoRoot) {
    for (const entry of cleanupEntries) {
      if (entry.worktreePath) {
        runGitCleanup(run.repoRoot, [
          "worktree",
          "remove",
          "--force",
          entry.worktreePath,
        ]);
      }
    }
    for (const entry of cleanupEntries) {
      if (entry.branchName?.startsWith(`pi-implement/${runId}/`)) {
        runGitCleanup(run.repoRoot, ["branch", "-D", entry.branchName]);
      }
    }
  }
  if (existsSync(paths.runDir)) {
    rmSync(paths.runDir, { recursive: true, force: true });
  }
  if (existsSync(paths.worktreesDir)) {
    rmSync(paths.worktreesDir, { recursive: true, force: true });
  }
  removeLocksForRun(paths, runId);
}

export function cleanupAllRuns(
  repoRoot: string,
  excludeRunIds?: string[],
): { cleaned: number; warnings: string[] } {
  const warnings: string[] = [];
  const runIds = listRunIds(repoRoot);
  let cleaned = 0;
  for (const runId of runIds) {
    if (excludeRunIds?.includes(runId)) {
      continue;
    }
    try {
      const paths = getStatePaths(repoRoot, runId);
      cleanupRun(paths);
      cleaned++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`${runId}: ${reason}`);
    }
  }
  return { cleaned, warnings };
}

// Removes pi-implement worktrees and branches whose owning run no longer has
// a run dir under .pi/implement/runs (i.e. true orphans left behind by an
// interrupted run or a partially-deleted state dir). Runs that still have a
// run dir are owned by cleanupRun and are left untouched, so this never
// destroys artifacts for a run that callers can still resume or inspect.
export function sweepRunArtifacts(repoRoot: string): {
  worktrees: number;
  branches: number;
} {
  const worktreesBase = safeRealpath(join(getBaseDir(repoRoot), "worktrees"));
  const knownRunIds = new Set(listRunIds(repoRoot));
  let worktrees = 0;
  let branches = 0;

  try {
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    for (const line of list.split("\n")) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const wtPath = safeRealpath(line.slice("worktree ".length).trim());
      const runId = worktreeRunId(wtPath, worktreesBase);
      if (runId === undefined || knownRunIds.has(runId)) {
        continue;
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", wtPath], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        worktrees++;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    // ignore
  }

  try {
    const list = execFileSync("git", ["branch", "--list", "pi-implement/*"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const names = list
      .split("\n")
      .map((b) => b.trim().replace(/^\*\s*/, ""))
      .filter(Boolean);
    for (const name of names) {
      const runId = branchRunId(name);
      if (runId === undefined || knownRunIds.has(runId)) {
        continue;
      }
      try {
        execFileSync("git", ["branch", "-D", name], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        branches++;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return { worktrees, branches };
}

// Worktrees live at <worktreesBase>/<runId>/<taskId>; returns the runId for a
// path inside that tree, or undefined for anything outside it.
function worktreeRunId(
  worktreePath: string,
  worktreesBase: string,
): string | undefined {
  const prefix = worktreesBase.endsWith(sep)
    ? worktreesBase
    : worktreesBase + sep;
  if (!worktreePath.startsWith(prefix)) {
    return undefined;
  }
  const [runId] = worktreePath.slice(prefix.length).split(sep);
  return runId || undefined;
}

// Task branches are named pi-implement/<runId>/<taskId>.
function branchRunId(branchName: string): string | undefined {
  const parts = branchName.split("/");
  return parts[0] === "pi-implement" && parts.length >= 3
    ? parts[1]
    : undefined;
}

export function listRunIds(repoRoot: string): string[] {
  const runsDir = join(getBaseDir(repoRoot), "runs");
  if (!existsSync(runsDir)) {
    return [];
  }
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readTaskCleanupEntries(
  paths: StatePaths,
): Array<{ worktreePath?: string; branchName?: string }> {
  if (!existsSync(paths.tasksDir)) {
    return [];
  }
  const entries: Array<{ worktreePath?: string; branchName?: string }> = [];
  for (const dirent of readdirSync(paths.tasksDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const task = readTaskJson(paths, dirent.name);
    if (task?.worktreePath || task?.branchName) {
      entries.push({
        worktreePath: task.worktreePath,
        branchName: task.branchName,
      });
    }
  }
  return entries;
}

function safeRealpath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function runGitCleanup(repoRoot: string, args: string[]): void {
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  } catch {
    return;
  }
}

function makeRunLock(paths: StatePaths, run: RunJson): RunLock {
  return {
    version: 1,
    runId: run.runId,
    runDir: paths.runDir,
    startedAt: run.startedAt,
    pid: process.pid,
    hostname: hostname(),
    checkoutRoot: run.checkoutRoot ?? run.repoRoot,
  };
}

function writeLockFile(path: string, lock: RunLock, flag: "w" | "wx"): void {
  writeFileSync(path, JSON.stringify(lock, null, 2), {
    encoding: "utf-8",
    flag,
  });
}

function readRunLock(paths: StatePaths): Partial<RunLock> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(paths.lockFile, "utf-8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return parsed as Partial<RunLock>;
  } catch {
    return undefined;
  }
}

function removeLocksForRun(paths: StatePaths, runId: string): void {
  const locksDir = getLocksDir(paths);
  if (!existsSync(locksDir)) {
    return;
  }
  for (const dirent of readdirSync(locksDir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".lock")) {
      continue;
    }
    const lockFile = join(locksDir, dirent.name);
    const lock = readRunLock({ ...paths, lockFile });
    if (lock?.runId === runId) {
      rmSync(lockFile, { force: true });
    }
  }
}

function formatRunLockReason(
  lock: Partial<RunLock> | undefined,
  lockFile: string,
): string {
  const details = [
    lock?.runId ? `run ${lock.runId}` : undefined,
    typeof lock?.pid === "number" ? `pid ${lock.pid}` : undefined,
    lock?.hostname ? `host ${lock.hostname}` : undefined,
    lock?.checkoutRoot ? `checkout ${lock.checkoutRoot}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return details || lockFile;
}

function checkoutLockHash(checkoutRoot: string): string {
  return createHash("sha256").update(checkoutRoot).digest("hex").slice(0, 16);
}

function getLocksDir(paths: StatePaths): string {
  return paths.locksDir ?? dirname(paths.lockFile);
}

function staleRunLockReason(paths: StatePaths): string | undefined {
  const lock = readRunLock(paths);
  if (!lock) {
    return "invalid lock file";
  }
  if (
    typeof lock.pid !== "number" ||
    !Number.isInteger(lock.pid) ||
    lock.pid <= 0
  ) {
    return "lock file does not include a valid pid";
  }
  if (lock.hostname && lock.hostname !== hostname()) {
    return undefined;
  }
  if (!processIsRunning(lock.pid)) {
    return `process ${lock.pid} is not running`;
  }
  return undefined;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const nodeError = err as NodeJS.ErrnoException;
    return nodeError.code !== "ESRCH";
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}
