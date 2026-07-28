import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publicationPreparationId,
  stagingIdentity,
} from "./candidate-replay.js";
import { SchedulerActor } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
  deferred,
} from "./scheduler-test-support.js";

afterEach(cleanupSchedulerStores);

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

  it("finalizes a receipted publication after its abandoned lease is reconciled", async () => {
    const run = await store();
    const initial = run.read();
    const candidateId = "candidate:first";
    const intentId = "intent:first";
    const preparationId = publicationPreparationId({
      runId: "run-1",
      candidateId,
      candidateCommitSha: "commit-1",
      targetBaseSha: "base-sha",
    });
    const staging = stagingIdentity({
      runId: "run-1",
      candidateId,
      candidateCommitSha: "commit-1",
      targetBaseSha: "base-sha",
    });
    const leaseId = "publication:run-1:2:0";
    await run.update(initial.revision, (state) => ({
      ...state,
      tasks: {
        ...state.tasks,
        first: {
          workstreamId: "first-stream",
          phase: "checkpointed",
          checkpoint: "checkpoint-1",
        },
      },
      workstreams: {
        ...state.workstreams,
        source: {
          ...state.workstreams.source,
          "first-stream": {
            ...state.workstreams.source["first-stream"]!,
            phase: "publishing",
            baseSha: "base-sha",
            candidateId,
          },
        },
      },
      processLeases: {
        [leaseId]: {
          id: leaseId,
          kind: "publication",
          workstream: { kind: "source", id: "first-stream" },
          candidateId,
          publicationIntentId: intentId,
          attempt: 1,
          acquiredAt: "2026-01-01T00:00:00.000Z",
        },
      },
      candidates: {
        [candidateId]: {
          id: candidateId,
          workstream: { kind: "source", id: "first-stream" },
          baseSha: "base-sha",
          commitSha: "commit-1",
          treeSha: "tree-1",
        },
      },
      reviews: {
        "source:first-stream": {
          candidateId,
          round: 0,
          outstandingIds: [],
          evidence: ["approved"],
          observations: [],
        },
      },
      publication: {
        preparations: {
          [preparationId]: {
            id: preparationId,
            candidateId,
            candidateCommitSha: "commit-1",
            targetBaseSha: "base-sha",
            targetRef: "refs/heads/main",
            preparedCommitSha: "commit-1",
            preparedTreeSha: "tree-1",
            stagingWorktree: join(
              initial.run.checkout.root,
              ".pi",
              "pipkin",
              "implement",
              "worktrees",
              "run-1",
              staging.id,
            ),
            stagingBranch: staging.branchName,
            replayPatchHash: "a".repeat(64),
            changedPaths: ["first.txt"],
            disposition: "same_base",
            hookEvidence: "git commit completed with retained command evidence",
            hookCommand: {
              command: "git commit",
              cwd: initial.run.checkout.root,
              timedOut: false,
              output: "",
              exitCode: 0,
            },
          },
        },
        intents: {
          [intentId]: {
            id: intentId,
            workstream: { kind: "source", id: "first-stream" },
            candidateId,
            preparationId,
            targetBaseSha: "base-sha",
            preparedCommitSha: "commit-1",
            preparedTreeSha: "tree-1",
            targetRef: "refs/heads/main",
            protectedArtifactSnapshots: {},
            protectedArtifactHashes: {},
          },
        },
        receipts: {
          [intentId]: {
            intentId,
            candidateId,
            targetBaseSha: "base-sha",
            publishedCommitSha: "commit-1",
            publishedTreeSha: "tree-1",
            targetRef: "refs/heads/main",
            protectedArtifactHashes: {},
            publishedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    }));
    const finalized = deferred();
    const actor = new SchedulerActor({
      store: run,
      onTransition: (_state, event) => {
        if (event.kind === "publication_completed") {
          finalized.resolve();
        }
      },
      executeEffect: async ({ effect, signal, dispatch }) => {
        if (effect.kind === "run_publication") {
          await dispatch({
            kind: "publication_completed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            intentId,
          });
          return;
        }
        if (effect.kind === "run_implementation") {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    });

    await actor.start();
    await finalized.promise;

    expect(run.read().workstreams.source["first-stream"]?.phase).toBe(
      "completed",
    );
    expect(run.read().publication.receipts[intentId]).toBeDefined();

    await actor.stop("test complete");
  });
});
