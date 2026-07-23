import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type CanonicalRunState, RunStore } from "./canonical-state.js";
import { SchedulerActor } from "./scheduler-actor.js";

function state(): CanonicalRunState {
  return {
    schemaVersion: 7,
    revision: 0,
    run: {
      id: "run-1",
      target: {
        checkoutRoot: "/repo",
        gitDir: "/repo/.git",
        commonGitDir: "/repo/.git",
        branchRef: "refs/heads/main",
        startHead: "base",
      },
      plan: {
        path: "/repo/plan.md",
        hash: "plan",
        indexConvention: "zero-based",
      },
      configuredWorkerConcurrency: 2,
      effectiveWorkerConcurrency: 2,
    },
    graph: {
      tasks: [
        {
          id: "a",
          planIndex: 0,
          title: "A",
          taskHash: "a",
          dependsOn: [],
        },
        {
          id: "b",
          planIndex: 1,
          title: "B",
          taskHash: "b",
          dependsOn: [],
        },
      ],
    },
    runtime: {
      phase: "preflight",
      tasks: { a: { phase: "queued" }, b: { phase: "queued" } },
      overall: { phase: "pending" },
    },
    candidates: {},
    taskExecution: {},
    taskMetadata: {},
    reviewConvergence: {},
    workerLeases: [],
    integrationAttempts: [],
    landingReceipts: [],
    projectionDebt: [],
    cleanupDebt: [],
    createdAt: "now",
    updatedAt: "now",
  };
}

function store(): RunStore {
  const directory = mkdtempSync(join(tmpdir(), "pi-implement-actor-"));
  return RunStore.create(join(directory, "run.json"), state());
}

describe("SchedulerActor", () => {
  it("persists every worker lease before dispatching its worker", async () => {
    const runStore = store();
    const seenLeases: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: async () => {
        seenLeases.push(runStore.read().workerLeases.map((lease) => lease.id));
        await gate;
        return { kind: "satisfied" };
      },
    });

    await actor.start();
    expect(seenLeases).toEqual([
      ["worker:run-1:2:0", "worker:run-1:2:1"],
      ["worker:run-1:2:0", "worker:run-1:2:1"],
    ]);

    release();
    await actor.settle();
    expect(runStore.read().runtime.tasks).toEqual({
      a: { phase: "completed", result: "satisfied" },
      b: { phase: "completed", result: "satisfied" },
    });
    expect(runStore.read().workerLeases).toEqual([]);
  });

  it("persists a review transition through the actor's stale-safe dispatcher", async () => {
    const runStore = store();
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: async () => ({ kind: "satisfied" }),
    });

    await actor.transitionReview("a", {
      owner: { kind: "task", taskId: "a" },
      stage: "initial_review",
      candidate: { current: "candidate", latestDeltaPaths: [] },
      epoch: 1,
      round: 0,
      proposals: [],
      admissions: [],
      findings: [],
      outstandingFindingIds: [],
      deferredConcerns: [],
      observationIds: [],
      bestOutstandingCount: 0,
      consecutiveStalledRounds: 0,
      evidenceRefs: ["initial.json"],
      verificationFailures: [],
    });

    expect(runStore.read().reviewConvergence.a?.stage).toBe("initial_review");
  });

  it("reconciles retained leases instead of assuming an in-memory worker survived", async () => {
    const runStore = store();
    const current = runStore.read();
    await runStore.update(current.revision, (state) => ({
      ...state,
      runtime: {
        ...state.runtime,
        phase: "running",
        tasks: {
          ...state.runtime.tasks,
          a: { phase: "executing", workerLeaseId: "retained" },
        },
      },
      workerLeases: [
        { id: "retained", taskId: "a", attempt: 1, acquiredAt: "earlier" },
      ],
    }));
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: async () => ({ kind: "satisfied" }),
    });

    await actor.start();
    await actor.settle();

    expect(runStore.read().runtime.tasks.a).toEqual({
      phase: "completed",
      result: "satisfied",
    });
    expect(runStore.read().workerLeases).toEqual([]);
  });

  it("resumes a retained integration attempt after reconciling its lease", async () => {
    const runStore = store();
    const current = runStore.read();
    await runStore.update(current.revision, (state) => ({
      ...state,
      runtime: {
        ...state.runtime,
        phase: "running",
        tasks: {
          ...state.runtime.tasks,
          a: {
            phase: "integrating",
            candidateId: "candidate:a",
            integrationAttemptId: "attempt-a",
          },
        },
      },
      candidates: {
        "candidate:a": {
          id: "candidate:a",
          sourceBaseSha: "base",
          baseSha: "base",
          commitSha: "candidate",
          treeSha: "tree",
          branchName: "branch/a",
          worktreePath: "/worktrees/a",
          reviewReceipt: {
            id: "review:a",
            candidateId: "candidate:a",
            candidateCommitSha: "candidate",
            candidateTreeSha: "tree",
            verdict: "approved",
            convergence: {
              round: 1,
              outstandingFindingIds: [],
              bestOutstandingCount: 0,
              evidenceRefs: [],
            },
            assessedAt: "now",
          },
        },
      },
      integrationAttempts: [
        {
          id: "attempt-a",
          owner: { kind: "task", taskId: "a" },
          candidateId: "candidate:a",
          targetBaseSha: "base",
          pipelineHash: "pipeline",
          startedAt: "now",
          phase: "prepared",
          preparedCommitSha: "prepared",
        },
      ],
    }));
    const executions: string[] = [];
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: async () => ({ kind: "satisfied" }),
      executeIntegration: async ({ attemptId, dispatch }) => {
        executions.push(attemptId);
        await dispatch({ kind: "integration_paused", attemptId });
      },
    });

    await actor.start();
    await actor.stop();

    expect(executions).toEqual(["attempt-a"]);
    expect(runStore.read().integrationAttempts[0]).toMatchObject({
      phase: "paused",
      resumePhase: "prepared",
      preparedCommitSha: "prepared",
    });
  });

  it("reports integration rework as needs_rework rather than a landing", async () => {
    const runStore = store();
    const current = runStore.read();
    await runStore.update(current.revision, (state) => ({
      ...state,
      runtime: {
        ...state.runtime,
        phase: "running",
        tasks: {
          ...state.runtime.tasks,
          a: {
            phase: "integrating",
            candidateId: "candidate:a",
            integrationAttemptId: "attempt-a",
          },
        },
      },
      candidates: {
        "candidate:a": {
          id: "candidate:a",
          sourceBaseSha: "base",
          baseSha: "base",
          commitSha: "candidate",
          treeSha: "tree",
          branchName: "branch/a",
          worktreePath: "/worktrees/a",
          reviewReceipt: {
            id: "review:a",
            candidateId: "candidate:a",
            candidateCommitSha: "candidate",
            candidateTreeSha: "tree",
            verdict: "approved",
            convergence: {
              round: 1,
              outstandingFindingIds: [],
              bestOutstandingCount: 0,
              evidenceRefs: [],
            },
            assessedAt: "now",
          },
        },
      },
      integrationAttempts: [
        {
          id: "attempt-a",
          owner: { kind: "task", taskId: "a" },
          candidateId: "candidate:a",
          targetBaseSha: "base",
          pipelineHash: "pipeline",
          startedAt: "now",
          phase: "preparing",
        },
      ],
    }));
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: async () => ({ kind: "satisfied" }),
      executeIntegration: async ({ attemptId, candidateId, dispatch }) => {
        await dispatch({
          kind: "integration_needs_rework",
          attemptId,
          candidateId,
          reason: "Candidate requires rework.",
        });
      },
    });

    await actor.start();
    await expect(actor.nextCompletion()).resolves.toMatchObject({
      kind: "integration",
      outcome: "needs_rework",
    });
  });

  it("retries retained cleanup debt before scheduling new work", async () => {
    const runStore = store();
    const current = runStore.read();
    await runStore.update(current.revision, (state) => ({
      ...state,
      runtime: { ...state.runtime, phase: "running" },
      cleanupDebt: [
        {
          id: "integration:attempt-a",
          kind: "integration-worktree",
          reason: "cleanup pending",
        },
      ],
    }));
    const cleaned: string[] = [];
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: async () => ({ kind: "satisfied" }),
      executeCleanup: async ({ debtId }) => {
        cleaned.push(debtId);
      },
    });

    await actor.start();
    await actor.stop();

    expect(cleaned).toEqual(["integration:attempt-a"]);
    expect(runStore.read().cleanupDebt).toEqual([]);
  });

  it("persists stopping and settles aborted workers before returning", async () => {
    const runStore = store();
    let settled = false;
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              settled = true;
              resolve({ kind: "cancelled" });
            },
            { once: true },
          );
        }),
    });

    await actor.start();
    await actor.stop();

    expect(settled).toBe(true);
    expect(runStore.read().runtime.phase).toBe("stopping");
    expect(runStore.read().workerLeases).toEqual([]);
    expect(runStore.read().runtime.tasks).toEqual({
      a: { phase: "queued" },
      b: { phase: "queued" },
    });
  });
});
