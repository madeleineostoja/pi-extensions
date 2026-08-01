import { afterEach, describe, expect, it } from "vitest";
import { reduceRunEvent } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
} from "./scheduler-test-support.js";

afterEach(() => cleanupSchedulerStores());

describe("revision policy", () => {
  it("binds review findings to one exact candidate and returns an observed revision to anchored review", async () => {
    const store = await createSchedulerStore();
    const started = reduceRunEvent(store.read(), {
      kind: "workstreams_selected",
      now: "2026-01-01T00:00:00.000Z",
      baseShas: { "first-stream": "base-sha" },
    });
    const implementation = started.effects[0]!;
    if (implementation.kind !== "run_implementation") {
      throw new Error("expected implementation");
    }
    const admitted = reduceRunEvent(started.state, {
      kind: "implementation_completed",
      workstream: implementation.workstream,
      leaseId: implementation.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate: candidate(
          "candidate:first",
          "first-sha",
          "first-tree",
          "integration-base",
        ),
        checkpoints: { first: "first-sha" },
        satisfied: {},
      },
    });
    const reviewRequested = reduceRunEvent(admitted.state, {
      kind: "review_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:01:00.000Z",
    });
    const review = reviewRequested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected review");
    }
    const findings = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "initial",
        candidateId: "candidate:first",
        evidence: "review artifact",
        completion: {
          publicationCommitSubject: "fix: implement first task",
          findings: [
            {
              summary: "missing behavior",
              evidence: "the endpoint is incomplete",
              requiredChange: "complete the endpoint",
              acceptanceCriteria: ["endpoint responds"],
              disposition: "blocking",
            },
          ],
        },
      },
    });

    const assignment = Object.values(findings.state.revisionAssignments)[0]!;
    expect(findings.state.workstreams.source["first-stream"]?.phase).toBe(
      "revising",
    );
    expect(findings.state.failures).toEqual({});
    expect(assignment).toMatchObject({
      candidateId: "candidate:first",
      comparisonBase: "first-sha",
      findingEpoch: 0,
      pendingCorrectionIds: ["source-first-stream-r1"],
    });

    const revisionRequested = reduceRunEvent(findings.state, {
      kind: "revision_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:02:00.000Z",
    });
    const revision = revisionRequested.effects[0]!;
    if (revision.kind !== "run_revision") {
      throw new Error("expected revision");
    }
    const completed = reduceRunEvent(revisionRequested.state, {
      kind: "revision_completed",
      workstream: revision.workstream,
      leaseId: revision.leaseId,
      assignmentId: revision.assignmentId,
      outcome: {
        kind: "candidate_ready",
        candidate: candidate(
          "revision:first",
          "revision-sha",
          "revision-tree",
          "integration-base",
        ),
        correction: {
          fromCandidateId: "candidate:first",
          changedPaths: ["src/endpoint.ts"],
          evidence: "revision artifact",
        },
      },
    });

    expect(
      completed.state.workstreams.source["first-stream"]?.candidateId,
    ).toBe("revision:first");
    expect(completed.state.reviews["source:first-stream"]).toMatchObject({
      candidateId: "revision:first",
      previousCandidateId: "candidate:first",
      publicationCommitSubject: "fix: implement first task",
    });
    expect(
      completed.state.candidates["revision:first"]?.integrationBaseSha,
    ).toBe("integration-base");
    expect(
      reduceRunEvent(completed.state, {
        kind: "revision_completed",
        workstream: revision.workstream,
        leaseId: revision.leaseId,
        assignmentId: revision.assignmentId,
        outcome: {
          kind: "unchanged",
          evidence: "late result",
        },
      }).accepted,
    ).toBe(false);
  });

  it("settles the first unchanged revision as no progress without a duplicate revision", async () => {
    const state = await stateAtRevision();
    const settled = requestAndLeaveUnchanged(state, "first wording");
    const assignment = Object.values(settled.revisionAssignments)[0]!;

    expect(settled.phase).toBe("running");
    expect(settled.workstreams.source).toMatchObject({
      "first-stream": {
        phase: "failed",
        candidateId: "candidate:first",
      },
      "second-stream": { phase: "dependency_skipped" },
    });
    expect(assignment).toMatchObject({
      status: "blocked",
      noProgress: { attempts: 1 },
    });
    expect(settled.reviews["source:first-stream"]).toMatchObject({
      candidateId: "candidate:first",
      pendingCorrectionIds: ["source-first-stream-r1"],
    });
    expect(settled.candidates["candidate:first"]).toBeDefined();
    expect(Object.values(settled.failures)).toContainEqual(
      expect.objectContaining({
        category: "no_progress",
        assignment: "blocked",
        evidence: "first wording",
      }),
    );
    expect(
      reduceRunEvent(settled, {
        kind: "revision_requested",
        workstream: { kind: "source", id: "first-stream" },
        now: "2026-01-01T00:03:00.000Z",
      }),
    ).toMatchObject({ accepted: false, effects: [] });
    expect(reduceRunEvent(settled, { kind: "run_incomplete" })).toMatchObject({
      accepted: true,
      state: { phase: "incomplete" },
    });
  });

  it("leaves independent workstreams active after an unchanged revision settles", async () => {
    const state = await stateAtRevision(2, true);
    const settled = requestAndLeaveUnchanged(state, "no semantic change");

    expect(settled.workstreams.source["first-stream"]?.phase).toBe("failed");
    expect(settled.workstreams.source["second-stream"]?.phase).toBe(
      "implementing",
    );
    expect(Object.values(settled.processLeases)).toContainEqual(
      expect.objectContaining({
        workstream: { kind: "source", id: "second-stream" },
        kind: "implementation",
      }),
    );
    expect(reduceRunEvent(settled, { kind: "run_incomplete" }).accepted).toBe(
      false,
    );
  });

  it("keeps protocol retries separate from semantic no progress", async () => {
    let state = await stateAtRevision();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const requested = reduceRunEvent(state, {
        kind: "revision_requested",
        workstream: { kind: "source", id: "first-stream" },
        now: `2026-01-01T00:0${attempt}:00.000Z`,
      });
      const revision = requested.effects[0]!;
      if (revision.kind !== "run_revision") {
        throw new Error("expected revision");
      }
      state = reduceRunEvent(requested.state, {
        kind: "revision_failed",
        workstream: revision.workstream,
        leaseId: revision.leaseId,
        assignmentId: revision.assignmentId,
        category: "protocol_failure",
        evidence: `malformed response ${attempt}`,
      }).state;
    }
    expect(state.phase).toBe("running");
    expect(state.workstreams.source["first-stream"]?.phase).toBe("failed");
    expect(Object.values(state.failures)).toContainEqual(
      expect.objectContaining({ category: "protocol_failure" }),
    );
    expect(
      Object.values(state.revisionAssignments)[0]?.noProgress.attempts,
    ).toBe(0);
  });

  it("uses an exact scheduler-owned workspace recreation operation", async () => {
    const state = await stateAtRevision();
    const requested = reduceRunEvent(state, {
      kind: "revision_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:02:00.000Z",
    });
    const revision = requested.effects[0]!;
    if (revision.kind !== "run_revision") {
      throw new Error("expected revision");
    }
    const quarantined = reduceRunEvent(requested.state, {
      kind: "revision_failed",
      workstream: revision.workstream,
      leaseId: revision.leaseId,
      assignmentId: revision.assignmentId,
      category: "workspace_unsafe",
      evidence: "worker left an uncommitted file",
      observation: observation(false),
    });
    const recreation = Object.values(
      quarantined.state.workspaceRecreations,
    )[0]!;
    expect(recreation).toMatchObject({
      candidateId: "candidate:first",
      checkpoint: "first-sha",
      resumePhase: "revising",
      status: "pending",
    });
    const started = reduceRunEvent(quarantined.state, {
      kind: "workspace_recreation_requested",
      id: recreation.id,
      now: "2026-01-01T00:03:00.000Z",
    });
    const effect = started.effects[0]!;
    if (effect.kind !== "recreate_workspace") {
      throw new Error("expected workspace recreation");
    }
    const restored = reduceRunEvent(started.state, {
      kind: "workspace_recreation_completed",
      id: recreation.id,
      leaseId: effect.leaseId,
      before: observation(false),
      after: observation(true),
      outcome: "restored",
    });
    expect(restored.state.workstreams.source["first-stream"]?.phase).toBe(
      "revising",
    );
    expect(restored.state.workspaceRecreations[recreation.id]).toMatchObject({
      status: "restored",
      before: observation(false),
      after: observation(true),
    });
  });
});

async function stateAtRevision(concurrency = 1, independent = false) {
  const store = await createSchedulerStore(concurrency, independent);
  const started = reduceRunEvent(store.read(), {
    kind: "workstreams_selected",
    now: "2026-01-01T00:00:00.000Z",
    baseShas: {
      "first-stream": "base-sha",
      ...(independent ? { "second-stream": "base-sha" } : {}),
    },
  });
  const implementation = started.effects[0]!;
  if (implementation.kind !== "run_implementation") {
    throw new Error("implementation");
  }
  const admitted = reduceRunEvent(started.state, {
    kind: "implementation_completed",
    workstream: implementation.workstream,
    leaseId: implementation.leaseId,
    outcome: {
      kind: "candidate_ready",
      candidate: candidate("candidate:first", "first-sha", "first-tree"),
      checkpoints: { first: "first-sha" },
      satisfied: {},
    },
  });
  const requested = reduceRunEvent(admitted.state, {
    kind: "review_requested",
    workstream: { kind: "source", id: "first-stream" },
    now: "2026-01-01T00:01:00.000Z",
  });
  const review = requested.effects[0]!;
  if (review.kind !== "run_review") {
    throw new Error("review");
  }
  return reduceRunEvent(requested.state, {
    kind: "review_completed",
    workstream: review.workstream,
    leaseId: review.leaseId,
    outcome: {
      kind: "initial",
      candidateId: "candidate:first",
      evidence: "review artifact",
      completion: {
        publicationCommitSubject: "fix: implement first task",
        findings: [
          {
            summary: "missing behavior",
            evidence: "the endpoint is incomplete",
            requiredChange: "complete the endpoint",
            acceptanceCriteria: ["endpoint responds"],
            disposition: "blocking",
          },
        ],
      },
    },
  }).state;
}

function requestAndLeaveUnchanged(
  state: Awaited<ReturnType<typeof stateAtRevision>>,
  evidence: string,
) {
  const requested = reduceRunEvent(state, {
    kind: "revision_requested",
    workstream: { kind: "source", id: "first-stream" },
    now: "2026-01-01T00:02:00.000Z",
  });
  const revision = requested.effects[0]!;
  if (revision.kind !== "run_revision") {
    throw new Error("revision");
  }
  return reduceRunEvent(requested.state, {
    kind: "revision_completed",
    workstream: revision.workstream,
    leaseId: revision.leaseId,
    assignmentId: revision.assignmentId,
    outcome: { kind: "unchanged", evidence },
  }).state;
}

function observation(clean: boolean) {
  return {
    branch: "pipkin/implement/run-1/first-stream",
    head: "first-sha",
    tree: "first-tree",
    clean,
    status: clean ? [] : [{ status: " M", path: "src/endpoint.ts" }],
  };
}

function candidate(
  id: string,
  commitSha: string,
  treeSha: string,
  integrationBaseSha?: string,
) {
  return {
    id,
    workstream: { kind: "source" as const, id: "first-stream" },
    baseSha: "base-sha",
    ...(integrationBaseSha ? { integrationBaseSha } : {}),
    commitSha,
    treeSha,
    evidenceStatus: "reported" as const,
    changedPaths: ["src/endpoint.ts"],
    implementationEvidence: {
      summary: "implemented",
      verification: ["tests pass"],
    },
  };
}
