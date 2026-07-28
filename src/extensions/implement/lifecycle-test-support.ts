import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import {
  checkoutPaths,
  createPlanningRun,
  RunStore,
  sourceIdentityForExecutionPlan,
  type CheckoutLeaseCapability,
} from "./store.js";

export type LifecycleFixture = {
  root: string;
  plan: ExecutionPlan;
  lease: CheckoutLeaseCapability;
  store: RunStore;
  reopen(): Promise<RunStore>;
  dispose(): void;
};

export async function createLifecycleFixture(): Promise<LifecycleFixture> {
  const root = mkdtempSync(join(tmpdir(), "pipkin-implement-lifecycle-"));
  const planPath = join(root, "plan.md");
  const content = "# Plan\n\n## Tasks\n\n- [ ] First task\n- [ ] Second task\n";
  writeFileSync(planPath, content);
  const parsed = parsePlan(planPath, content);
  const materialStore = buildMaterialStore({
    plan: parsed,
    planPath,
    repoRoot: root,
  });
  const compiled = compileExecutionPlan(
    {
      version: 1,
      tasks: [
        task("first", 1, "First task", planPath),
        task("second", 2, "Second task", planPath, ["first"]),
      ],
      workstreams: [
        {
          id: "first-stream",
          taskIds: ["first"],
          dependsOn: [],
        },
        {
          id: "second-stream",
          taskIds: ["second"],
          dependsOn: ["first-stream"],
        },
      ],
    },
    {
      plan: parsed,
      planHash: sha256(content),
      materialStore,
      checkoutId: join(root, ".git"),
      baseSha: "base-sha",
      workerConcurrency: 1,
    },
  );
  if (!compiled.ok) {
    throw new Error(compiled.reason);
  }
  const lease = fakeLease(root);
  const store = createPlanningRun({
    lease,
    runId: "run-1",
    checkout: {
      root,
      gitDir: join(root, ".git"),
      commonGitDir: join(root, ".git"),
      branchRef: "refs/heads/main",
      startHead: "base-sha",
    },
    source: sourceIdentityForExecutionPlan(compiled.value),
    workerConcurrency: 1,
  });
  await store.bindExecutionPlan(compiled.value);
  return {
    root,
    plan: compiled.value,
    lease,
    store,
    reopen: () => Promise.resolve(RunStore.open(lease, store.path)),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function task(
  id: string,
  planIndex: number,
  title: string,
  path: string,
  dependsOn: string[] = [],
) {
  return {
    id,
    planIndex,
    title,
    dependsOn,
    sourcePaths: [path],
    compiledContract: {
      objective: `Implement ${title}.`,
      inScope: ["Required behavior"],
      acceptanceCriteria: ["Observable behavior works"],
      outOfScope: ["Unrelated work"],
    },
  };
}

function fakeLease(root: string): CheckoutLeaseCapability {
  const paths = checkoutPaths(root);
  return {
    paths,
    owner: {
      runId: "run-1",
      runPath: join(paths.runs, "run-1"),
      checkoutRoot: root,
      gitDir: join(root, ".git"),
      pid: process.pid,
      hostname: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
    assertOwned() {},
    async release() {},
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
