import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileExecutionPlan, type ExecutionPlan } from "../execution-plan.js";
import { buildMaterialStore } from "../material-store.js";
import { writeSourceCorpus } from "../requirements-context.js";
import { parsePlan } from "../plan.js";
import {
  checkoutPaths,
  createPlanningRun,
  sourceIdentityForExecutionPlan,
  type CheckoutLeaseCapability,
  type RunStore,
} from "../store.js";

const temporaryDirectories = new Set<string>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function plannerTask(
  id: string,
  planIndex: number,
  title: string,
  dependsOn: string[] = [],
) {
  return {
    id,
    planIndex,
    title,
    dependsOn,
    compiledContract: {
      objective: `Implement ${title}.`,
      inScope: ["Required behavior"],
      acceptanceCriteria: ["Observable behavior works"],
      outOfScope: ["Unrelated changes"],
    },
  };
}

export function planFor(
  directory: string,
  concurrency = 1,
  independent = false,
): ExecutionPlan {
  const planPath = join(directory, "plan.md");
  const content = "# Plan\n\n## Tasks\n\n- [ ] First task\n- [ ] Second task\n";
  writeFileSync(planPath, content);
  const plan = parsePlan(planPath, content);
  const materialStore = buildMaterialStore({
    plan,
    planPath,
    repoRoot: directory,
  });
  const result = compileExecutionPlan(
    {
      version: 1,
      tasks: [
        plannerTask("first", 1, "First task"),
        plannerTask("second", 2, "Second task", independent ? [] : ["first"]),
      ],
      workstreams: [
        {
          id: "first-stream",
          taskIds: ["first"],
        },
        {
          id: "second-stream",
          taskIds: ["second"],
        },
      ],
    },
    {
      plan,
      planHash: sha256(content),
      materialStore,
      checkoutId: join(directory, ".git"),
      baseSha: "base-sha",
      workerConcurrency: concurrency,
    },
  );
  if (!result.ok) {
    throw new Error(result.reason);
  }
  writeSourceCorpus(
    join(checkoutPaths(directory).runs, "run-1"),
    materialStore,
    result.value,
  );
  return result.value;
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

export function fakeLease(directory: string): CheckoutLeaseCapability {
  const paths = checkoutPaths(directory);
  return {
    paths,
    owner: {
      runId: "run-1",
      runPath: join(paths.runs, "run-1"),
      checkoutRoot: directory,
      gitDir: join(directory, ".git"),
      pid: process.pid,
      hostname: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
    assertOwned() {},
    async release() {},
  };
}

export function createUnboundSchedulerRun(
  concurrency = 1,
  independent = false,
): { run: RunStore; plan: ExecutionPlan } {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-implement-scheduler-"));
  temporaryDirectories.add(directory);
  const plan = planFor(directory, concurrency, independent);
  const run = createPlanningRun({
    lease: fakeLease(directory),
    runId: "run-1",
    checkout: {
      root: directory,
      gitDir: join(directory, ".git"),
      commonGitDir: join(directory, ".git"),
      branchRef: "refs/heads/main",
      startHead: "base-sha",
    },
    source: sourceIdentityForExecutionPlan(plan),
    workerConcurrency: concurrency,
  });
  return { run, plan };
}

export async function createSchedulerStore(
  concurrency = 1,
  independent = false,
): Promise<RunStore> {
  const { run, plan } = createUnboundSchedulerRun(concurrency, independent);
  await run.bindExecutionPlan(plan);
  return run;
}

export function cleanupSchedulerStores(): void {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
}
