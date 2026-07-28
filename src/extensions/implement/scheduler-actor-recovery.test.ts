import { afterEach, describe, expect, it } from "vitest";
import { reduceRunEvent, SchedulerActor } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
  deferred,
} from "./scheduler-test-support.js";
import { WorkstreamCandidateLifecycleError } from "./workstream-candidate.js";

afterEach(cleanupSchedulerStores);

describe("scheduler actor recovery lifecycle", () => {
  it("retains a failed checkpoint through a successful implementation retry", async () => {
    const run = await store();
    const failed = deferred();
    const completed = deferred();
    let implementationAttempts = 0;
    const actor = new SchedulerActor({
      store: run,
      targetHead: async () => "base-sha",
      onTransition: (_state, event) => {
        if (event.kind === "implementation_failed") {
          failed.resolve();
        }
        if (event.kind === "implementation_completed") {
          completed.resolve();
        }
      },
      executeEffect: async ({ effect, dispatch }) => {
        if (effect.kind === "run_implementation") {
          implementationAttempts += 1;
          if (implementationAttempts > 1) {
            await dispatch({
              kind: "implementation_completed",
              workstream: effect.workstream,
              leaseId: effect.leaseId,
              outcome: {
                kind: "candidate_ready",
                candidate: {
                  id: "candidate:first-stream:checkpoint-1",
                  workstream: { kind: "source", id: "first-stream" },
                  baseSha: "base-sha",
                  commitSha: "checkpoint-1",
                  treeSha: "tree-1",
                },
                checkpoints: { first: "checkpoint-1" },
                satisfied: {},
              },
            });
            return;
          }
          throw new WorkstreamCandidateLifecycleError(
            "provider disconnected",
            "checkpoint-1",
            {
              id: "checkpoint:first-stream:checkpoint-1",
              workstream: { kind: "source", id: "first-stream" },
              baseSha: "base-sha",
              commitSha: "checkpoint-1",
              treeSha: "tree-1",
            },
            {
              id: "source:first-stream",
              checkpoint: "checkpoint-1",
              changedPaths: [],
              stateEvidence: "Owned workspace is clean at checkpoint-1.",
            },
          );
        }
        if (effect.kind === "run_recovery") {
          await dispatch({
            kind: "recovery_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            action: {
              kind: "recreate_workspace",
              outcome: "completed",
              summary: "Recreated the owned workspace.",
              evidence: "The workspace is clean at checkpoint-1.",
              at: "now",
            },
          });
        }
      },
    });

    await actor.start();
    await failed.promise;

    expect(run.read()).toMatchObject({
      workstreams: {
        source: {
          "first-stream": {
            candidateId: "checkpoint:first-stream:checkpoint-1",
          },
        },
      },
      candidates: {
        "checkpoint:first-stream:checkpoint-1": {
          commitSha: "checkpoint-1",
        },
      },
    });
    expect(Object.values(run.read().recoveryEpisodes)).toContainEqual(
      expect.objectContaining({
        candidateId: "checkpoint:first-stream:checkpoint-1",
        workspace: expect.objectContaining({ checkpoint: "checkpoint-1" }),
      }),
    );
    await completed.promise;
    expect(run.read()).toMatchObject({
      workstreams: {
        source: {
          "first-stream": {
            phase: "candidate_ready",
            candidateId: "candidate:first-stream:checkpoint-1",
          },
        },
      },
      recoveryEpisodes: {
        "recovery:environment:source:first-stream:1": {
          status: "completed",
        },
      },
    });
    await actor.stop("test complete");
    const retained = run.read();
    await expect(
      run.update(retained.revision, (current) => {
        const episode =
          current.recoveryEpisodes[
            "recovery:environment:source:first-stream:1"
          ]!;
        episode.executionFailures += 1;
        return current;
      }),
    ).rejects.toThrow("run state violates lifecycle invariants");
  });

  it("supersedes an open recovery episode when a retry advances its checkpoint", async () => {
    const state = (await store()).read();
    const workstream = { kind: "source" as const, id: "first-stream" };
    state.workstreams.source["first-stream"] = {
      ...state.workstreams.source["first-stream"]!,
      phase: "implementing",
      baseSha: "base-sha",
      candidateId: "checkpoint:first-stream:checkpoint-1",
    };
    state.candidates["checkpoint:first-stream:checkpoint-1"] = {
      id: "checkpoint:first-stream:checkpoint-1",
      workstream,
      baseSha: "base-sha",
      commitSha: "checkpoint-1",
      treeSha: "tree-1",
    };
    state.gates.push({
      id: "environment:source:first-stream:1",
      kind: "environment",
      workstream,
      candidateId: "checkpoint:first-stream:checkpoint-1",
      attempt: 1,
      outcome: "failed",
      evidence: "first validation failure",
      outstandingFindingIds: [],
    });
    state.recoveryEpisodes["recovery:first-checkpoint"] = {
      id: "recovery:first-checkpoint",
      gateId: "environment:source:first-stream:1",
      gateAttempts: ["environment:source:first-stream:1"],
      workstream,
      candidateId: "checkpoint:first-stream:checkpoint-1",
      workspace: {
        id: "source:first-stream",
        checkpoint: "checkpoint-1",
        changedPaths: [],
        stateEvidence: "First checkpoint retained.",
      },
      outstandingFindingIds: [],
      status: "open",
      cycle: {
        signature: "first",
        identicalNoActionCycles: 0,
        independentlyEscalated: false,
      },
      executionFailures: 0,
      actions: [
        {
          kind: "recreate_workspace",
          outcome: "completed",
          summary: "Recreated the workspace.",
          evidence: "Retrying from checkpoint-1.",
          at: "now",
        },
      ],
    };
    state.processLeases["implementation:retry"] = {
      id: "implementation:retry",
      workstream,
      kind: "implementation",
      candidateId: "checkpoint:first-stream:checkpoint-1",
      attempt: 2,
      acquiredAt: "later",
    };

    const failed = reduceRunEvent(state, {
      kind: "implementation_failed",
      workstream,
      leaseId: "implementation:retry",
      evidence: "second validation failure",
      trustedCheckpoint: "checkpoint-2",
      trustedCandidate: {
        id: "checkpoint:first-stream:checkpoint-2",
        workstream,
        baseSha: "base-sha",
        commitSha: "checkpoint-2",
        treeSha: "tree-2",
      },
      workspace: {
        id: "source:first-stream",
        checkpoint: "checkpoint-2",
        changedPaths: [],
        stateEvidence: "Second checkpoint retained.",
      },
    });

    expect(failed.accepted).toBe(true);
    expect(failed.state).toMatchObject({
      workstreams: {
        source: {
          "first-stream": {
            phase: "recovering",
            candidateId: "checkpoint:first-stream:checkpoint-2",
          },
        },
      },
      recoveryEpisodes: {
        "recovery:first-checkpoint": { status: "completed" },
        "recovery:environment:source:first-stream:2": {
          status: "open",
          candidateId: "checkpoint:first-stream:checkpoint-2",
          workspace: { checkpoint: "checkpoint-2" },
        },
      },
    });
  });

  it("routes a thrown review effect into durable recovery evidence", async () => {
    const run = await store();
    const recovered = deferred();
    const retried = deferred();
    let reviewAttempts = 0;
    const actor = new SchedulerActor({
      store: run,
      targetHead: async () => "base-sha",
      onTransition: (_state, event) => {
        if (event.kind === "effect_failed") {
          recovered.resolve();
        }
      },
      executeEffect: async ({ effect, signal, dispatch }) => {
        if (effect.kind === "run_implementation") {
          await dispatch({
            kind: "implementation_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            outcome: {
              kind: "candidate_ready",
              candidate: {
                id: "candidate:first",
                workstream: { kind: "source", id: "first-stream" },
                baseSha: "base-sha",
                commitSha: "checkpoint:first",
                treeSha: "tree:first",
              },
              checkpoints: { first: "checkpoint:first" },
              satisfied: {},
            },
          });
          return;
        }
        if (effect.kind === "run_review") {
          reviewAttempts += 1;
          if (reviewAttempts === 1) {
            throw new Error("review provider disconnected");
          }
          retried.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        if (effect.kind === "run_recovery") {
          await dispatch({
            kind: "recovery_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            action: {
              kind: "retry",
              outcome: "completed",
              summary: "Restored the review environment.",
              evidence: "Review workspace is unchanged and ready to retry.",
              at: "now",
            },
          });
        }
      },
    });

    await actor.start();
    await recovered.promise;
    await retried.promise;

    expect(run.read()).toMatchObject({
      workstreams: { source: { "first-stream": { phase: "reviewing" } } },
      gates: [
        expect.objectContaining({
          kind: "environment",
          evidence: "review provider disconnected",
        }),
      ],
    });
    expect(Object.values(run.read().recoveryEpisodes)).toContainEqual(
      expect.objectContaining({
        status: "open",
        candidateId: "candidate:first",
      }),
    );
    await actor.stop("test complete");
  });
});
