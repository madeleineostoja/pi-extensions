import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export type RunMode = "auto" | "serial" | "parallel";

export type RunJson = {
  version: 1;
  runId: string;
  mode: RunMode;
  strategyReason: string;
  repoRoot: string;
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
  | "coding"
  | "reviewing"
  | "committing"
  | "approved"
  | "integration_failed"
  | "landed"
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
};

export type EventEntry =
  | { type: "strategy_selected"; reason: string; mode: RunMode }
  | { type: "task_started"; taskId: string }
  | { type: "task_approved"; taskId: string; commitSha?: string }
  | { type: "integration_failed"; taskId: string; reason: string }
  | { type: "task_landed"; taskId: string; commitSha: string }
  | { type: "cleanup_failed"; reason: string }
  | { type: "run_started"; runId: string }
  | { type: "run_stopped" }
  | { type: "run_blocked"; reason: string }
  | { type: "run_done" };

export type DurableEvent = EventEntry & { timestamp: string };

export type StatePaths = {
  baseDir: string;
  runDir: string;
  runJson: string;
  eventsJsonl: string;
  planSnapshot: string;
  tasksDir: string;
  worktreesDir: string;
  lockFile: string;
};

export function getStatePaths(repoRoot: string, runId: string): StatePaths {
  const baseDir = join(repoRoot, ".pi", "implement");
  const runDir = join(baseDir, "runs", runId);
  return {
    baseDir,
    runDir,
    runJson: join(runDir, "run.json"),
    eventsJsonl: join(runDir, "events.jsonl"),
    planSnapshot: join(runDir, "plan.snapshot.md"),
    tasksDir: join(runDir, "tasks"),
    worktreesDir: join(baseDir, "worktrees", runId),
    lockFile: join(baseDir, "locks", "run.lock"),
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
  mkdirSync(dirname(paths.runJson), { recursive: true });
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(dirname(paths.lockFile), { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
  writeAtomic(paths.runJson, JSON.stringify(run, null, 2));
  writeAtomic(
    paths.lockFile,
    JSON.stringify(
      {
        runId: run.runId,
        runDir: paths.runDir,
        startedAt: run.startedAt,
      },
      null,
      2,
    ),
  );
  writeAtomic(paths.planSnapshot, planContent);
  if (!existsSync(paths.eventsJsonl)) {
    writeFileSync(paths.eventsJsonl, "", "utf-8");
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
  const runId = readRunJson(paths)?.runId ?? basename(paths.runDir);
  if (existsSync(paths.runDir)) {
    rmSync(paths.runDir, { recursive: true, force: true });
  }
  // TODO(plan-03): refuse cleanup if any task in this run is non-terminal,
  // since plan-03 worktrees may host live subagent processes.
  if (existsSync(paths.worktreesDir)) {
    rmSync(paths.worktreesDir, { recursive: true, force: true });
  }
  if (existsSync(paths.lockFile)) {
    let lockRunId: string | undefined;
    try {
      lockRunId = (
        JSON.parse(readFileSync(paths.lockFile, "utf-8")) as {
          runId?: string;
        }
      ).runId;
    } catch {
      lockRunId = undefined;
    }
    if (lockRunId === runId) {
      rmSync(paths.lockFile, { force: true });
    }
  }
}

export function listRunIds(repoRoot: string): string[] {
  const runsDir = join(repoRoot, ".pi", "implement", "runs");
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

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}
