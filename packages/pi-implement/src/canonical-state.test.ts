import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunStateError,
  RunStore,
  StaleRunStateRevisionError,
  canCleanupCanonicalRun,
  loadCanonicalRunState,
  type CanonicalRunState,
} from "./canonical-state.js";

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
        branchRef: "main",
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
          id: "task-1",
          planIndex: 0,
          title: "Task one",
          taskHash: "hash-1",
          dependsOn: [],
        },
        {
          id: "task-2",
          planIndex: 1,
          title: "Task two",
          taskHash: "hash-2",
          dependsOn: ["task-1"],
        },
      ],
    },
    runtime: {
      phase: "running",
      tasks: { "task-1": { phase: "queued" }, "task-2": { phase: "queued" } },
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function statePath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "pi-implement-canonical-")),
    "canonical.json",
  );
}

describe("RunStore", () => {
  it("writes a strict canonical aggregate and supports deliberate runtime clearing", async () => {
    const store = RunStore.create(statePath(), state());
    const created = store.read();
    const next = await store.update(created.revision, (current) => ({
      ...current,
      runtime: { ...current.runtime, phase: "completed" },
      projectionDebt: [
        { id: "checkbox", kind: "checkbox", reason: "source unavailable" },
      ],
    }));

    expect(next.revision).toBe(1);
    expect(next.runtime.phase).toBe("completed");
    expect(canCleanupCanonicalRun(next)).toBe(false);

    const cleared = await store.update(next.revision, (current) => ({
      ...current,
      projectionDebt: [],
    }));
    expect(cleared.projectionDebt).toEqual([]);
    expect(canCleanupCanonicalRun(cleared)).toBe(true);
  });

  it("serializes separate in-process stores and rejects stale revisions", async () => {
    const path = statePath();
    const store = RunStore.create(path, state());
    const competingStore = RunStore.open(path);
    const revision = store.read().revision;
    const first = store.update(revision, (current) => ({
      ...current,
      runtime: { ...current.runtime, phase: "stopping" },
    }));
    const stale = competingStore.update(revision, (current) => ({
      ...current,
      runtime: { ...current.runtime, phase: "blocked", terminalReason: "late" },
    }));

    await expect(first).resolves.toMatchObject({
      revision: 1,
      runtime: { phase: "stopping" },
    });
    await expect(stale).rejects.toBeInstanceOf(StaleRunStateRevisionError);
    expect(store.read().runtime.phase).toBe("stopping");
  });

  it("keeps the previous aggregate readable when replacement fails before rename", async () => {
    const path = statePath();
    RunStore.create(path, state());
    const failingStore = RunStore.open(path, undefined, {
      beforeRename: () => {
        throw new Error("injected interruption");
      },
    });

    await expect(
      failingStore.update(0, (current) => ({
        ...current,
        runtime: { ...current.runtime, phase: "stopping" },
      })),
    ).rejects.toThrow("injected interruption");

    expect(loadCanonicalRunState(path)).toMatchObject({
      revision: 0,
      runtime: { phase: "running" },
    });
  });

  it("fails closed for malformed, legacy, and invariant-invalid state", () => {
    const path = statePath();
    expect(() => loadCanonicalRunState(path)).toThrow(/legacy state/);

    RunStore.create(path, state());
    const malformed = JSON.parse(readFileSync(path, "utf-8"));
    malformed.unknown = true;
    expect(() => RunStore.create(path, malformed)).toThrow(RunStateError);

    const cyclicPath = statePath();
    const cyclic = state();
    cyclic.graph.tasks[0]!.dependsOn = ["task-2"];
    expect(() => RunStore.create(cyclicPath, cyclic)).toThrow(
      /dependency cycle/,
    );
  });

  it("rejects invalid review coverage and lifecycle states", () => {
    const invalid = state();
    invalid.reviewConvergence.a = {
      owner: { kind: "task", taskId: "task-1" },
      stage: "approved",
      candidate: { current: "commit", latestDeltaPaths: [] },
      epoch: 1,
      round: 0,
      proposals: [
        {
          id: "P1",
          summary: "summary",
          evidence: "evidence",
          basis: "requirement",
        },
      ],
      admissions: [
        {
          proposalId: "P1",
          disposition: "admit",
          rationale: "required",
          findingId: "R1",
        },
      ],
      findings: [
        {
          id: "R1",
          proposalId: "P1",
          summary: "summary",
          evidence: "evidence",
          requiredChange: "change",
          acceptanceCriteria: ["criterion"],
          introducedRound: 0,
          origin: "initial",
        },
      ],
      outstandingFindingIds: ["R1"],
      deferredConcerns: [],
      observationIds: [],
      bestOutstandingCount: 1,
      consecutiveStalledRounds: 0,
      evidenceRefs: ["review.json"],
      verificationFailures: [],
    };
    expect(() => RunStore.create(statePath(), invalid)).toThrow(
      /approved review convergence.*outstanding/,
    );
  });

  it("rejects broken lease, candidate, and receipt ownership", () => {
    const invalid = state();
    invalid.workerLeases = [
      { id: "lease", taskId: "task-1", attempt: 1, acquiredAt: "now" },
    ];
    expect(() => RunStore.create(statePath(), invalid)).toThrow(
      /does not match executing/,
    );

    const candidate = state();
    candidate.candidates.candidate = {
      id: "candidate",
      sourceBaseSha: "source",
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
      branchName: "branch",
      worktreePath: "/worktree",
      reviewReceipt: {
        id: "review",
        candidateId: "different",
        candidateCommitSha: "commit",
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
    };
    expect(() => RunStore.create(statePath(), candidate)).toThrow(/not bound/);
  });
});
