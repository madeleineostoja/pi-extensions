import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerActor } from "./scheduler-actor.js";
import { reduceRunEvent } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
  createUnboundSchedulerRun,
  deferred,
} from "./scheduler-test-support.js";
import type { RunState, RunStore } from "./store.js";
import { WorkstreamCandidateLifecycleError } from "./workstream-candidate.js";
import { WorkerPacketError } from "./worker-invocation.js";

afterEach(cleanupSchedulerStores);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("scheduler actor safety boundaries", () => {
  it("persists a lease before its effect and ignores a throwing projection callback", async () => {
    const run = await store();
    const seenLeases: string[][] = [];
    const actor = new SchedulerActor({
      store: run,
      onTransition: () => {
        throw new Error("status sink failed");
      },
      executeEffect: async ({ effect, dispatch }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        seenLeases.push(Object.keys(run.read().processLeases));
        await dispatch({
          kind: "implementation_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          outcome: {
            kind: "satisfaction_claimed",
            candidate: {
              id: "satisfied:first-stream:base-sha",
              workstream: { kind: "source", id: "first-stream" },
              baseSha: "base-sha",
              commitSha: "base-sha",
              treeSha: "base-tree",
            },
            evidence: {
              first: "Repository state already provides this behavior.",
            },
          },
        });
      },
    });

    await actor.start();
    await actor.stop("test stopped after the implementation outcome");

    expect(seenLeases).toEqual([["implementation:run-1:2:0"]]);
    expect(run.read().workstreams.source["first-stream"]?.phase).toBe(
      "candidate_ready",
    );
    expect(run.read().processLeases).toEqual({});
  });

  it("terminally fails a failed projection instead of relaunching it", async () => {
    const run = await store();
    const content =
      "# Plan\n\n## Tasks\n\n- [ ] First task\n- [ ] Second task\n";
    const projected = content.replace("- [ ] First task", "- [x] First task");
    const initial = run.read();
    await run.update(initial.revision, (state) => ({
      ...state,
      tasks: {
        ...state.tasks,
        first: {
          workstreamId: "first-stream",
          phase: "checkpointed",
          checkpoint: "checkpoint:first",
        },
      },
      projectionDebt: [
        {
          id: "projection:run-1:first",
          reason: "Publish first task.",
          artifactPath: join(state.run.checkout.root, "plan.md"),
          canonicalPath: join(state.run.checkout.root, "plan.md"),
          expectedOldContent: content,
          expectedOldHash: sha256(content),
          expectedNewContent: projected,
          expectedNewHash: sha256(projected),
          taskIds: ["first"],
        },
      ],
    }));
    const failed = deferred();
    let attempts = 0;
    const actor = new SchedulerActor({
      store: run,
      onTransition: (_state, event) => {
        if (event.kind === "failure_requested") {
          failed.resolve();
        }
      },
      executeEffect: async ({ effect }) => {
        if (effect.kind === "run_projection") {
          attempts += 1;
          throw new Error("projection store write failed");
        }
      },
    });

    await actor.start();
    await failed.promise;

    expect(run.read()).toMatchObject({
      phase: "stopping",
      projectionDebt: [{ id: "projection:run-1:first" }],
    });
    expect(attempts).toBe(1);
    await actor.stop("test complete");
  });

  it("terminally fails a failed whole-plan closure instead of relaunching it", async () => {
    let state = (await store()).read();
    state.phase = "whole_plan_review";
    for (const workstream of Object.values(state.workstreams.source)) {
      workstream.phase = "completed";
    }
    state.wholePlanReview = {
      status: "approved",
      evidence: "whole-plan-review.json",
      reviewedTargetSha: "target",
      reviewedTargetTreeSha: "tree",
    };
    const fakeStore = {
      read: () => structuredClone(state),
      update: async (
        expectedRevision: number,
        update: (current: RunState) => RunState,
      ) => {
        expect(expectedRevision).toBe(state.revision);
        state = {
          ...update(structuredClone(state)),
          revision: state.revision + 1,
        };
        return structuredClone(state);
      },
    } as RunStore;
    const failed = deferred();
    let attempts = 0;
    const actor = new SchedulerActor({
      store: fakeStore,
      onTransition: (_state, event) => {
        if (event.kind === "failure_requested") {
          failed.resolve();
        }
      },
      executeEffect: async ({ effect }) => {
        if (effect.kind === "complete_whole_plan_run") {
          attempts += 1;
          throw new Error("reviewed target moved before closure");
        }
      },
    });

    await actor.start();
    await failed.promise;
    await actor.settle();

    expect(state).toMatchObject({
      phase: "failed",
    });
    expect(attempts).toBe(1);
    await actor.stop("test complete");
  });
});

describe("scheduler actor stop and reload lifecycle", () => {
  it("aborts, settles, and terminally fails with retained workstreams requeued", async () => {
    const run = await store();
    let aborted = false;
    const actor = new SchedulerActor({
      store: run,
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    await actor.start();
    await actor.stop("operator stopped the run");

    expect(aborted).toBe(true);
    expect(run.read()).toMatchObject({
      phase: "failed",
      failure: {
        category: "stopped",
        reason: "operator stopped the run",
        originPhase: "running",
      },
      workstreams: { source: { "first-stream": { phase: "queued" } } },
      processLeases: {},
    });
  });

  it("retains an implementation result that settles after stopping", async () => {
    const run = await store();
    const started = deferred();
    const actor = new SchedulerActor({
      store: run,
      executeEffect: async ({ effect, signal, dispatch }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await dispatch({
          kind: "implementation_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          outcome: {
            kind: "candidate_ready",
            candidate: {
              id: "candidate:first-stream",
              workstream: effect.workstream,
              baseSha: "base-sha",
              commitSha: "checkpoint:first-stream",
              treeSha: "tree:first-stream",
            },
            checkpoints: { first: "checkpoint:first-stream" },
            satisfied: {},
          },
        });
      },
    });

    await actor.start();
    await started.promise;
    await actor.stop("operator stopped the run");

    expect(run.read()).toMatchObject({
      phase: "failed",
      processLeases: {},
      candidates: {
        "candidate:first-stream": { commitSha: "checkpoint:first-stream" },
      },
      workstreams: { source: { "first-stream": { phase: "candidate_ready" } } },
    });
  });

  it("retains an interrupted implementation checkpoint while stopping", async () => {
    const run = await store();
    const actor = new SchedulerActor({
      store: run,
      targetHead: async () => "base-sha",
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new WorkstreamCandidateLifecycleError(
          "interrupted",
          "checkpoint-on-stop",
        );
      },
    });

    await actor.start();
    await actor.stop("operator stopped the run");

    expect(run.read().phase).toBe("failed");
    expect(Object.values(run.read().recoveryEpisodes)).toContainEqual(
      expect.objectContaining({
        workspace: expect.objectContaining({
          checkpoint: "checkpoint-on-stop",
        }),
      }),
    );
  });

  it("settles a late review completion after a concurrent recovery stops", async () => {
    const run = await store(2, true);
    const reviewStarted = deferred();
    const allowImplementationFailure = deferred();
    const recoveryStopped = deferred();
    const actor = new SchedulerActor({
      store: run,
      targetHead: async () => "base-sha",
      executeEffect: async ({ effect, dispatch }) => {
        if (effect.kind === "run_implementation") {
          if (effect.workstream.kind !== "source") {
            throw new Error("Expected a source implementation.");
          }
          if (effect.workstream.id === "first-stream") {
            await allowImplementationFailure.promise;
            throw new WorkstreamCandidateLifecycleError(
              "implementation failed",
            );
          }
          await dispatch({
            kind: "implementation_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            outcome: {
              kind: "candidate_ready",
              candidate: {
                id: "candidate:second-stream",
                workstream: effect.workstream,
                baseSha: "base-sha",
                commitSha: "checkpoint:second-stream",
                treeSha: "tree:second-stream",
              },
              checkpoints: { second: "checkpoint:second-stream" },
              satisfied: {},
            },
          });
          return;
        }
        if (effect.kind === "run_recovery") {
          await dispatch({
            kind: "recovery_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            action: {
              kind: "no_safe_action",
              outcome: "no_safe_action",
              summary: "Recovery cannot continue safely.",
              evidence: "recovery safety boundary failed",
              at: "now",
            },
          });
          recoveryStopped.resolve();
          return;
        }
        if (effect.kind === "run_review") {
          reviewStarted.resolve();
          await recoveryStopped.promise;
          await dispatch({
            kind: "review_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            outcome: {
              kind: "initial",
              candidateId: "candidate:second-stream",
              completion: { verdict: "approved" },
              evidence: "Review completed after the stop boundary.",
            },
          });
        }
      },
    });

    await actor.start();
    await reviewStarted.promise;
    allowImplementationFailure.resolve();
    await actor.settle();

    expect(run.read()).toMatchObject({
      phase: "failed",
      processLeases: {},
      workstreams: {
        source: { "second-stream": { phase: "candidate_ready" } },
      },
    });
  });

  it("settles a planner before pausing an unbound planning run", async () => {
    const { run, plan } = createUnboundSchedulerRun();
    let aborted = false;
    const actor = new SchedulerActor({
      store: run,
      executePlanner: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return plan;
      },
    });

    await actor.start();
    await actor.stop("operator stopped planning");

    expect(aborted).toBe(true);
    expect(run.read()).toMatchObject({
      phase: "failed",
    });
    expect(run.read().executionPlan).toBeUndefined();
  });

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

describe("scheduler actor scheduling and publication", () => {
  it("assigns one captured target base to concurrently eligible workstreams", async () => {
    const run = await store(2, true);
    const started = deferred();
    const bases: string[] = [];
    let count = 0;
    const actor = new SchedulerActor({
      store: run,
      targetHead: async () => "current-target-sha",
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        const id =
          effect.workstream.kind === "source" ? effect.workstream.id : "";
        bases.push(run.read().workstreams.source[id]!.baseSha!);
        count += 1;
        if (count === 2) {
          started.resolve();
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    await actor.start();
    await started.promise;

    expect(bases).toEqual(["current-target-sha", "current-target-sha"]);
    await actor.stop("test complete");
  });

  it("prioritizes a candidate-ready review over another implementation at capacity one", async () => {
    const run = await store(1, true);
    const reviewStarted = deferred();
    const launches: string[] = [];
    const actor = new SchedulerActor({
      store: run,
      executeEffect: async ({ effect, signal, dispatch }) => {
        if (effect.kind === "run_implementation") {
          const workstreamId =
            effect.workstream.kind === "source"
              ? effect.workstream.id
              : effect.workstream.repairId;
          launches.push(`implementation:${workstreamId}`);
          await dispatch({
            kind: "implementation_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            outcome: {
              kind: "satisfaction_claimed",
              candidate: {
                id: `satisfied:${workstreamId}:base-sha`,
                workstream: effect.workstream,
                baseSha: "base-sha",
                commitSha: "base-sha",
                treeSha: "base-tree",
              },
              evidence: {
                first: "Repository state already provides this behavior.",
              },
            },
          });
          return;
        }
        if (effect.kind === "run_review") {
          launches.push(
            `review:${
              effect.workstream.kind === "source"
                ? effect.workstream.id
                : effect.workstream.repairId
            }`,
          );
          reviewStarted.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    });

    await actor.start();
    await reviewStarted.promise;

    expect(launches).toEqual([
      "implementation:first-stream",
      "review:first-stream",
    ]);
    expect(run.read().workstreams.source["second-stream"]?.phase).toBe(
      "queued",
    );

    await actor.stop("test complete");
  });

  it("terminally fails a malformed recovery packet before it starts a worker", async () => {
    let state = (await store(2, true)).read();
    state.workstreams.source["second-stream"]!.dependsOn = [];
    state.workstreams.source["first-stream"]!.phase = "recovering";
    state.workstreams.source["first-stream"]!.candidateId = "candidate-1";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
    };
    state.findings["source-first-stream-r1"] = {
      id: "source-first-stream-r1",
      candidateId: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      summary: "missing behavior",
      evidence: "missing",
      requiredChange: "fix it",
      acceptanceCriteria: ["works"],
      origin: "initial",
      introducedRound: 0,
      status: "open",
    };
    state.gates.push({
      id: "review:source:first-stream:candidate-1:1",
      kind: "review",
      workstream: { kind: "source", id: "first-stream" },
      candidateId: "candidate-1",
      attempt: 1,
      outcome: "failed",
      evidence: "review artifact",
      outstandingFindingIds: ["source-first-stream-r1"],
    });
    state.recoveryEpisodes["recovery:review"] = {
      id: "recovery:review",
      gateId: "review:source:first-stream:candidate-1:1",
      gateAttempts: ["review:source:first-stream:candidate-1:1"],
      workstream: { kind: "source", id: "first-stream" },
      candidateId: "candidate-1",
      workspace: {
        id: "source:first-stream",
        checkpoint: "commit",
        changedPaths: [],
        stateEvidence: "review workspace",
      },
      outstandingFindingIds: ["source-first-stream-r1"],
      status: "open",
      cycle: {
        signature: "initial",
        identicalNoActionCycles: 0,
        independentlyEscalated: false,
      },
      executionFailures: 0,
      actions: [],
    };
    const action = {
      kind: "no_safe_action" as const,
      outcome: "no_safe_action" as const,
      summary: "Recovery packet could not satisfy the durable worker boundary.",
      evidence: "The same candidate and failure remain.",
      at: "now",
    };

    const fakeStore = {
      read: () => structuredClone(state),
      update: async (
        expectedRevision: number,
        update: (current: RunState) => RunState,
      ) => {
        expect(expectedRevision).toBe(state.revision);
        state = {
          ...update(structuredClone(state)),
          revision: state.revision + 1,
        };
        return structuredClone(state);
      },
    } as RunStore;
    const implementationStarted = deferred();
    const actor = new SchedulerActor({
      store: fakeStore,
      targetHead: async () => "base-sha",
      now: () => "now",
      executeEffect: async ({ effect, signal, dispatch }) => {
        if (effect.kind === "run_implementation") {
          implementationStarted.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (effect.workstream.kind !== "source") {
            throw new Error("Expected a source implementation.");
          }
          await dispatch({
            kind: "implementation_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            outcome: {
              kind: "candidate_ready",
              candidate: {
                id: "candidate:second-stream:checkpoint-2",
                workstream: effect.workstream,
                baseSha: "base-sha",
                commitSha: "checkpoint-2",
                treeSha: "tree-2",
              },
              checkpoints: { second: "checkpoint-2" },
              satisfied: {},
            },
          });
          return;
        }
        if (effect.kind === "run_recovery") {
          await implementationStarted.promise;
          throw new WorkerPacketError(action.evidence);
        }
      },
    });

    await actor.start();
    await actor.settle();

    expect(state).toMatchObject({
      phase: "failed",
      processLeases: {},
      workstreams: {
        source: {
          "first-stream": { candidateId: "candidate-1" },
          "second-stream": {
            phase: "candidate_ready",
            candidateId: "candidate:second-stream:checkpoint-2",
          },
        },
      },
      recoveryEpisodes: {
        "recovery:review": {
          status: "open",
          executionFailures: 0,
          actions: [
            {
              kind: "retry",
              outcome: "interrupted",
            },
          ],
        },
      },
    });
    await actor.stop("test complete");
  });
});
