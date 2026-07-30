import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import { buildMaterialStore } from "./material-store.js";
import { settleProjectionTransactions } from "./transaction-settlement.js";
import { parsePlan } from "./plan.js";
import { createCheckboxProjectionIntent } from "./projection.js";
import {
  checkoutPaths,
  createPlanningRun,
  executionPlanPath,
  protectedArtifactsMatch,
  sourceIdentityForExecutionPlan,
  RunStore,
  StateError,
  sourceIdentityMatches,
  type CheckoutLeaseCapability,
} from "./store.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "pipkin-implement-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const directory of roots) {
    rmSync(directory, { recursive: true, force: true });
  }
  roots.length = 0;
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function planFor(directory: string): ExecutionPlan {
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
        plannerTask("second", 2, "Second task"),
      ],
      workstreams: [
        {
          id: "implementation",
          taskIds: ["first", "second"],
          dependsOn: [],
        },
      ],
    },
    {
      plan,
      planHash: sha256(content),
      materialStore,
      checkoutId: join(directory, ".git"),
      baseSha: "base-sha",
      workerConcurrency: 1,
    },
  );
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.value;
}

function plannerTask(id: string, planIndex: number, title: string) {
  return {
    id,
    planIndex,
    title,
    dependsOn: [],
    compiledContract: {
      objective: `Implement ${title}.`,
      inScope: ["Required behavior"],
      acceptanceCriteria: ["Observable behavior works"],
      outOfScope: ["Unrelated changes"],
    },
  };
}

function fakeLease(directory: string): CheckoutLeaseCapability {
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

describe("checkout store transitions", () => {
  it("writes planning state before binding one immutable execution plan", async () => {
    const directory = root();
    const plan = planFor(directory);
    const lease = fakeLease(directory);
    const store = createPlanningRun({
      lease,
      runId: "run-1",
      checkout: {
        root: directory,
        gitDir: join(directory, ".git"),
        commonGitDir: join(directory, ".git"),
        branchRef: "main",
        startHead: "base-sha",
      },
      source: sourceIdentityForExecutionPlan(plan),
      workerConcurrency: 1,
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(store.read().phase).toBe("planning");
    expect(store.read().executionPlan).toBeUndefined();
    const bound = await store.bindExecutionPlan(plan);

    expect(bound).toMatchObject({
      phase: "running",
      executionPlan: { hash: plan.executionPlanHash },
      workstreams: {
        source: { implementation: { taskIds: ["first", "second"] } },
      },
    });
    expect(
      readFileSync(executionPlanPath(lease.paths, "run-1"), "utf-8"),
    ).toContain(plan.executionPlanHash);
    await expect(store.bindExecutionPlan(plan)).rejects.toThrow(
      "Only an unbound",
    );
  });

  it("rejects legacy state rather than interpreting it as an active operation", () => {
    const directory = root();
    const lease = fakeLease(directory);
    const store = createPlanningRun({
      lease,
      runId: "run-1",
      checkout: {
        root: directory,
        gitDir: join(directory, ".git"),
        commonGitDir: join(directory, ".git"),
        branchRef: "main",
        startHead: "base-sha",
      },
      source: {
        entry: { path: join(directory, "plan.md"), normalizedHash: sha256("") },
        corpus: [{ path: join(directory, "plan.md"), hash: sha256("") }],
        protectedArtifactHashes: { [join(directory, "plan.md")]: sha256("") },
      },
      workerConcurrency: 1,
    });
    const legacy = { ...store.read(), version: 1 };
    writeFileSync(store.path, JSON.stringify(legacy));

    expect(() => RunStore.open(lease, store.path)).toThrow(StateError);
    expect(() => RunStore.open(lease, store.path)).toThrow(
      "legacy schema version 1",
    );
  });

  it("binds an exact retained plan after interruption between plan and state persistence", async () => {
    const directory = root();
    const plan = planFor(directory);
    const lease = fakeLease(directory);
    const initial = createPlanningRun({
      lease,
      runId: "run-1",
      checkout: {
        root: directory,
        gitDir: join(directory, ".git"),
        commonGitDir: join(directory, ".git"),
        branchRef: "main",
        startHead: "base-sha",
      },
      source: sourceIdentityForExecutionPlan(plan),
      workerConcurrency: 1,
    });
    const interrupted = RunStore.open(lease, initial.path, {
      beforeRename: () => {
        throw new Error("interrupted state replacement");
      },
    });

    await expect(interrupted.bindExecutionPlan(plan)).rejects.toThrow(
      "interrupted state replacement",
    );
    const continued = RunStore.open(lease, initial.path);
    await expect(continued.bindExecutionPlan(plan)).resolves.toMatchObject({
      phase: "running",
      executionPlan: { hash: plan.executionPlanHash },
    });
  });

  it("accepts only checkbox-normalized source identity after host advances protected hashes", async () => {
    const directory = root();
    const plan = planFor(directory);
    const lease = fakeLease(directory);
    const store = createPlanningRun({
      lease,
      runId: "run-1",
      checkout: {
        root: directory,
        gitDir: join(directory, ".git"),
        commonGitDir: join(directory, ".git"),
        branchRef: "main",
        startHead: "base-sha",
      },
      source: sourceIdentityForExecutionPlan(plan),
      workerConcurrency: 1,
    });
    await store.bindExecutionPlan(plan);
    const planPath = join(directory, "plan.md");
    writeFileSync(
      planPath,
      readFileSync(planPath, "utf-8").replace(
        "- [ ] First task",
        "- [x] First task",
      ),
    );

    expect(sourceIdentityMatches(store.read())).toBe(false);
    expect(protectedArtifactsMatch(store.read())).toBe(false);

    const current = store.read();
    await store.update(current.revision, (state) => ({
      ...state,
      tasks: {
        ...state.tasks,
        first: {
          ...state.tasks.first!,
          phase: "checkpointed",
          checkpoint: "first-checkpoint",
        },
      },
    }));
    const checkpointed = store.read();
    await store.recordProjection(checkpointed.revision, ["first"], {
      ...checkpointed.protectedArtifactHashes,
      [planPath]: sha256(readFileSync(planPath, "utf-8")),
    });
    expect(sourceIdentityMatches(store.read())).toBe(true);
    expect(protectedArtifactsMatch(store.read())).toBe(true);

    writeFileSync(
      planPath,
      readFileSync(planPath, "utf-8").replace("Second task", "Changed task"),
    );
    expect(sourceIdentityMatches(store.read())).toBe(false);
  });

  it("settles retained post-write projection debt", async () => {
    const directory = root();
    const plan = planFor(directory);
    const lease = fakeLease(directory);
    const store = createPlanningRun({
      lease,
      runId: "run-1",
      checkout: {
        root: directory,
        gitDir: join(directory, ".git"),
        commonGitDir: join(directory, ".git"),
        branchRef: "refs/heads/main",
        startHead: "base-sha",
      },
      source: sourceIdentityForExecutionPlan(plan),
      workerConcurrency: 1,
    });
    await store.bindExecutionPlan(plan);
    const planPath = join(directory, "plan.md");
    const debt = createCheckboxProjectionIntent({
      id: "projection:run-1:first",
      checkoutRoot: directory,
      taskIds: ["first"],
      checkboxes: [
        { path: planPath, lineNumber: 5, lineText: "- [ ] First task" },
      ],
    });
    const current = store.read();
    await store.update(current.revision, (state) => ({
      ...state,
      tasks: {
        ...state.tasks,
        first: {
          ...state.tasks.first!,
          phase: "checkpointed",
          checkpoint: "first-checkpoint",
        },
      },
      projectionDebt: [
        {
          ...debt,
          reason: "test post-write interruption",
          artifactPath: debt.canonicalPath,
        },
      ],
    }));
    writeFileSync(planPath, debt.expectedNewContent);

    await settleProjectionTransactions({ store });

    expect(store.read().projectionDebt).toEqual([]);
    expect(protectedArtifactsMatch(store.read())).toBe(true);
    expect(sourceIdentityMatches(store.read())).toBe(true);
  });
});
