import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CandidateRef, CanonicalRunState } from "./canonical-state.js";
import {
  selectIntegrationTask,
  selectWorkerTasks,
  transition,
} from "./scheduler.js";

function state(
  tasks: Array<{ id: string; planIndex: number; dependsOn?: string[] }>,
  concurrency = 2,
): CanonicalRunState {
  return {
    schemaVersion: 4,
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
      configuredWorkerConcurrency: concurrency,
      effectiveWorkerConcurrency: concurrency,
    },
    graph: {
      tasks: tasks.map((task) => ({
        id: task.id,
        planIndex: task.planIndex,
        title: task.id,
        taskHash: `${task.id}-hash`,
        dependsOn: task.dependsOn ?? [],
      })),
    },
    runtime: {
      phase: "running",
      tasks: Object.fromEntries(
        tasks.map((task) => [task.id, { phase: "queued" }]),
      ),
    },
    candidates: {},
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

function candidate(id = "candidate-1"): CandidateRef {
  return {
    id,
    sourceBaseSha: "source-base",
    baseSha: "base",
    commitSha: `${id}-commit`,
    treeSha: `${id}-tree`,
    branchName: `branch/${id}`,
    worktreePath: `/worktrees/${id}`,
    reviewReceipt: {
      id: `receipt-${id}`,
      candidateId: id,
      candidateCommitSha: `${id}-commit`,
      candidateTreeSha: `${id}-tree`,
      verdict: "approved",
      convergence: {
        round: 0,
        outstandingFindingIds: [],
        bestOutstandingCount: 0,
        evidenceRefs: [],
      },
      assessedAt: "now",
    },
  };
}

describe("scheduler reducer", () => {
  it("reserves worker capacity atomically in one scheduling tick", () => {
    const initial = state(
      [
        { id: "a", planIndex: 0 },
        { id: "b", planIndex: 1 },
      ],
      1,
    );

    const result = transition(initial, {
      kind: "workers_selected",
      now: "now",
    });

    expect(result.accepted).toBe(true);
    expect(result.effects).toEqual([
      { kind: "start_worker", taskId: "a", leaseId: "worker:run-1:1:0" },
    ]);
    expect(result.state.workerLeases).toHaveLength(1);
    expect(result.state.runtime.tasks).toMatchObject({
      a: { phase: "executing" },
      b: { phase: "queued" },
    });
    expect(initial.runtime.tasks.a).toEqual({ phase: "queued" });
  });

  it("never schedules a task before its dependencies complete", () => {
    const initial = state([
      { id: "a", planIndex: 0 },
      { id: "b", planIndex: 1, dependsOn: ["a"] },
    ]);

    expect(selectWorkerTasks(initial)).toEqual(["a"]);
    initial.runtime.tasks.a = { phase: "completed", result: "satisfied" };
    expect(selectWorkerTasks(initial)).toEqual(["b"]);
  });

  it("rejects stale worker completion without changing state", () => {
    const initial = state([{ id: "a", planIndex: 0 }]);
    const result = transition(initial, {
      kind: "worker_finished",
      taskId: "a",
      leaseId: "missing",
      outcome: { kind: "satisfied" },
    });

    expect(result).toMatchObject({ accepted: false, state: initial });
  });

  it("preserves candidate identity after a worker result is replayed", () => {
    const started = transition(state([{ id: "a", planIndex: 0 }]), {
      kind: "workers_selected",
      now: "now",
    }).state;
    const leaseId = started.workerLeases[0]!.id;
    const complete = transition(started, {
      kind: "worker_finished",
      taskId: "a",
      leaseId,
      outcome: { kind: "candidate_ready", candidate: candidate() },
    });
    const replay = transition(complete.state, {
      kind: "worker_finished",
      taskId: "a",
      leaseId,
      outcome: { kind: "candidate_ready", candidate: candidate("other") },
    });

    expect(complete.accepted).toBe(true);
    expect(replay.accepted).toBe(false);
    expect(replay.state).toEqual(complete.state);
  });

  it("rejects candidates without an approved review receipt", () => {
    const started = transition(state([{ id: "a", planIndex: 0 }]), {
      kind: "workers_selected",
      now: "now",
    }).state;
    const unapproved = candidate();
    unapproved.reviewReceipt.verdict = "changes_requested";

    const result = transition(started, {
      kind: "worker_finished",
      taskId: "a",
      leaseId: started.workerLeases[0]!.id,
      outcome: { kind: "candidate_ready", candidate: unapproved },
    });

    expect(result.accepted).toBe(false);
    expect(result.state).toEqual(started);
  });

  it("returns an integration rework task to worker selection", () => {
    const initial = state([{ id: "a", planIndex: 0 }]);
    initial.candidates = { first: candidate("first") };
    initial.runtime.tasks.a = {
      phase: "candidate_ready",
      candidateId: "first",
    };
    const integrating = transition(initial, {
      kind: "integration_requested",
      taskId: "a",
      attemptId: "attempt-a",
      pipelineHash: "pipeline",
      now: "now",
    }).state;

    const rework = transition(integrating, {
      kind: "integration_needs_rework",
      attemptId: "attempt-a",
      candidateId: "first",
    });

    expect(rework.accepted).toBe(true);
    expect(selectWorkerTasks(rework.state)).toEqual(["a"]);
    expect(selectIntegrationTask(rework.state)).toBeUndefined();
    const worked = transition(rework.state, {
      kind: "workers_selected",
      now: "later",
    }).state;
    const nextCandidate = candidate("second");
    const ready = transition(worked, {
      kind: "worker_finished",
      taskId: "a",
      leaseId: worked.workerLeases[0]!.id,
      outcome: { kind: "candidate_ready", candidate: nextCandidate },
    }).state;
    expect(selectIntegrationTask(ready)).toBe("a");
    expect(
      transition(ready, {
        kind: "integration_needs_rework",
        attemptId: "attempt-a",
        candidateId: "first",
      }).accepted,
    ).toBe(false);
  });

  it("resumes a retained preparing integration without creating another attempt", () => {
    const initial = state([{ id: "a", planIndex: 0 }]);
    initial.candidates = { first: candidate("first") };
    initial.runtime.tasks.a = {
      phase: "integrating",
      candidateId: "first",
      integrationAttemptId: "attempt-a",
    };
    initial.integrationAttempts = [
      {
        id: "attempt-a",
        owner: { kind: "task", taskId: "a" },
        candidateId: "first",
        targetBaseSha: "base",
        pipelineHash: "pipeline",
        startedAt: "now",
        phase: "paused",
        resumePhase: "preparing",
      },
    ];

    const resumed = transition(initial, {
      kind: "integration_resumed",
      attemptId: "attempt-a",
    });

    expect(resumed.accepted).toBe(true);
    expect(resumed.state.integrationAttempts).toEqual([
      expect.objectContaining({ phase: "preparing" }),
    ]);
  });

  it("resumes a retained prepared integration without creating another attempt", () => {
    const initial = state([{ id: "a", planIndex: 0 }]);
    initial.candidates = { first: candidate("first") };
    initial.runtime.tasks.a = {
      phase: "integrating",
      candidateId: "first",
      integrationAttemptId: "attempt-a",
    };
    initial.integrationAttempts = [
      {
        id: "attempt-a",
        owner: { kind: "task", taskId: "a" },
        candidateId: "first",
        targetBaseSha: "base",
        pipelineHash: "pipeline",
        startedAt: "now",
        phase: "paused",
        resumePhase: "prepared",
        preparedCommitSha: "prepared",
      },
    ];

    const resumed = transition(initial, {
      kind: "integration_resumed",
      attemptId: "attempt-a",
    });

    expect(resumed.accepted).toBe(true);
    expect(resumed.state.integrationAttempts).toEqual([
      expect.objectContaining({
        phase: "prepared",
        preparedCommitSha: "prepared",
      }),
    ]);
    expect(resumed.effects).toEqual([
      {
        kind: "start_integration",
        taskId: "a",
        attemptId: "attempt-a",
        candidateId: "first",
      },
    ]);
  });

  it("records cleanup debt before requesting cleanup", () => {
    const initial = state([{ id: "a", planIndex: 0 }]);
    initial.candidates = { first: candidate("first") };
    initial.runtime.tasks.a = {
      phase: "candidate_ready",
      candidateId: "first",
    };
    const requested = transition(initial, {
      kind: "integration_requested",
      taskId: "a",
      attemptId: "attempt-a",
      pipelineHash: "pipeline",
      now: "now",
    }).state;
    const prepared = transition(requested, {
      kind: "integration_prepared",
      attemptId: "attempt-a",
      preparedCommitSha: "prepared",
    }).state;
    const publishing = transition(prepared, {
      kind: "integration_publishing",
      attemptId: "attempt-a",
    }).state;
    const landed = transition(publishing, {
      kind: "integration_landed",
      attemptId: "attempt-a",
      receipt: {
        attemptId: "attempt-a",
        owner: { kind: "task", taskId: "a" },
        candidateCommitSha: "first-commit",
        targetCheckoutId: "/repo/.git",
        targetRef: "refs/heads/main",
        targetBaseSha: "base",
        integrationCommitSha: "prepared",
        treeSha: "first-tree",
        pipelineHash: "pipeline",
        publishedAt: "now",
      },
    });

    expect(landed.state.cleanupDebt).toEqual([
      expect.objectContaining({ id: "integration:attempt-a" }),
    ]);
    expect(landed.effects).toEqual([
      { kind: "cleanup", debtId: "integration:attempt-a" },
    ]);
  });

  it("keeps integration independently serialized", () => {
    const initial = state([
      { id: "a", planIndex: 0 },
      { id: "b", planIndex: 1 },
    ]);
    initial.candidates = {
      first: candidate("first"),
      second: candidate("second"),
    };
    initial.runtime.tasks.a = {
      phase: "candidate_ready",
      candidateId: "first",
    };
    initial.runtime.tasks.b = {
      phase: "candidate_ready",
      candidateId: "second",
    };

    const requested = transition(initial, {
      kind: "integration_requested",
      taskId: "a",
      attemptId: "attempt-a",
      pipelineHash: "pipeline",
      now: "now",
    });

    expect(requested.accepted).toBe(true);
    expect(selectIntegrationTask(requested.state)).toBeUndefined();
    expect(
      transition(requested.state, {
        kind: "integration_requested",
        taskId: "b",
        attemptId: "attempt-b",
        pipelineHash: "pipeline",
        now: "now",
      }).accepted,
    ).toBe(false);
  });

  it("keeps generated DAG selections within capacity and dependency constraints", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.boolean(), { minLength: 0, maxLength: 7 }),
        (count, concurrency, completed) => {
          const tasks = Array.from({ length: count }, (_, planIndex) => ({
            id: `t${planIndex}`,
            planIndex,
            dependsOn: planIndex === 0 ? [] : [`t${planIndex - 1}`],
          }));
          const generated = state(tasks, concurrency);
          for (
            let index = 0;
            index < Math.min(completed.length, count);
            index++
          ) {
            if (completed[index]) {
              generated.runtime.tasks[`t${index}`] = {
                phase: "completed",
                result: "satisfied",
              };
            }
          }
          const selected = selectWorkerTasks(generated);
          expect(selected.length).toBeLessThanOrEqual(concurrency);
          for (const taskId of selected) {
            const task = generated.graph.tasks.find(
              (entry) => entry.id === taskId,
            )!;
            expect(
              task.dependsOn.every(
                (dependency) =>
                  generated.runtime.tasks[dependency]?.phase === "completed",
              ),
            ).toBe(true);
          }
        },
      ),
      { seed: 20260314, numRuns: 100 },
    );
  });
});
