import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import {
  publicationPreparationId,
  stagingIdentity,
} from "./candidate-replay.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import {
  checkoutPaths,
  createPlanningRun,
  sourceIdentityForExecutionPlan,
  type CheckoutLeaseCapability,
  type RunState,
  type RunStore,
} from "./store.js";
import {
  reduceRunEvent,
  selectReadyWorkstreams,
  SchedulerActor,
} from "./scheduler.js";
import { buildRecoveryPacket } from "./recovery-packet.js";
import { WorkerPacketError } from "./worker-invocation.js";
import { buildReviewPacket } from "./review.js";
import {
  TargetPreconditionError,
  WorkstreamCandidateLifecycleError,
} from "./workstream-candidate.js";
import { within } from "./test-boundary.js";

const temporaryDirectories = new Set<string>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function plannerTask(
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
    provenance: [{ path, quote: title }],
    compiledContract: {
      objective: `Implement ${title}.`,
      inScope: ["Required behavior"],
      acceptanceCriteria: ["Observable behavior works"],
      outOfScope: ["Unrelated changes"],
    },
  };
}

function planFor(
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
      plannerReason: "The tasks are ordered.",
      plannerConfidence: "high",
      tasks: [
        plannerTask("first", 1, "First task", planPath),
        plannerTask(
          "second",
          2,
          "Second task",
          planPath,
          independent ? [] : ["first"],
        ),
      ],
      workstreams: [
        {
          id: "first-stream",
          taskIds: ["first"],
          dependsOn: [],
          rationale: "First change establishes the required base.",
          risk: "normal",
        },
        {
          id: "second-stream",
          taskIds: ["second"],
          dependsOn: independent ? [] : ["first-stream"],
          rationale: "Second change depends on the first change.",
          risk: "normal",
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
  return result.value;
}

function deferred<T = void>(): {
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

async function store(concurrency = 1, independent = false): Promise<RunStore> {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-implement-scheduler-"));
  temporaryDirectories.add(directory);
  const plan = planFor(directory, concurrency, independent);
  const lease = fakeLease(directory);
  const run = createPlanningRun({
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
    workerConcurrency: concurrency,
  });
  await run.bindExecutionPlan(plan);
  return run;
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe(" scheduler reducer", () => {
  it("assigns a landed dependency base when a dependent becomes eligible", async () => {
    const run = await store(1);
    const initial = run.read();

    expect(selectReadyWorkstreams(initial)).toEqual(["first-stream"]);
    const selected = reduceRunEvent(initial, {
      kind: "workstreams_selected",
      now: "now",
      baseShas: { "first-stream": "base-sha" },
    });

    expect(selected.accepted).toBe(true);
    expect(selected.effects).toEqual([
      {
        kind: "run_implementation",
        workstream: { kind: "source", id: "first-stream" },
        leaseId: "implementation:run-1:2:0",
      },
    ]);
    expect(selectReadyWorkstreams(selected.state)).toEqual([]);

    selected.state.processLeases = {};
    selected.state.workstreams.source["first-stream"]!.phase = "completed";
    selected.state.workstreams.source["first-stream"]!.candidateId =
      "candidate:first";
    selected.state.candidates["candidate:first"] = {
      id: "candidate:first",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base-sha",
      commitSha: "commit:first",
      treeSha: "tree:first",
    };
    selected.state.publication.receipts["intent:first"] = {
      intentId: "intent:first",
      candidateId: "candidate:first",
      targetBaseSha: "base-sha",
      publishedCommitSha: "commit:first",
      publishedTreeSha: "tree:first",
      targetRef: "refs/heads/main",
      protectedArtifactHashes: {},
      publishedAt: "now",
    };
    expect(selectReadyWorkstreams(selected.state)).toEqual(["second-stream"]);

    const dependent = reduceRunEvent(selected.state, {
      kind: "workstreams_selected",
      now: "later",
      baseShas: { "second-stream": "landed-dependency-sha" },
    });
    expect(dependent.accepted).toBe(true);
    expect(dependent.state.workstreams.source["second-stream"]?.baseSha).toBe(
      "landed-dependency-sha",
    );
  });

  it("builds an initial cumulative packet with contracts and repository-state evidence", async () => {
    const run = await store();
    const state = run.read();
    const candidate = {
      id: "satisfied:first-stream:base-sha",
      workstream: { kind: "source" as const, id: "first-stream" },
      baseSha: "base-sha",
      commitSha: "base-sha",
      treeSha: "base-tree",
      implementationEvidence: {
        summary: "The behavior already exists.",
        verification: [
          {
            command: "npm test",
            result: "passed",
            rationale: "Checks behavior.",
          },
        ],
      },
    };
    state.candidates[candidate.id] = candidate;
    state.workstreams.source["first-stream"]!.candidateId = candidate.id;
    state.tasks.first = {
      workstreamId: "first-stream",
      phase: "satisfaction_claimed",
      evidence: "Existing endpoint satisfies the contract.",
    };

    const packet = buildReviewPacket({
      state,
      plan: planFor(state.run.checkout.root),
      workstream: { kind: "source", id: "first-stream" },
      baseToTipDiff: "",
    });

    expect(packet.contracts.map((task) => task.id)).toEqual(["first"]);
    expect(packet.satisfiedEvidence).toEqual({
      first: "Existing endpoint satisfies the contract.",
    });
    expect(packet.sourceMaterial[0]).toMatchObject({
      path: expect.any(String),
    });
    expect(packet.verificationEvidence?.verification).toHaveLength(1);
  });

  it("rejects overlapping checkpoint and satisfied mappings", async () => {
    const initial = (await store()).read();
    const selected = reduceRunEvent(initial, {
      kind: "workstreams_selected",
      now: "now",
      baseShas: { "first-stream": "base" },
    });
    const effect = selected.effects.find(
      (effect) => effect.kind === "run_implementation",
    );
    if (!effect || effect.kind !== "run_implementation") {
      throw new Error("Expected implementation effect.");
    }

    const result = reduceRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: effect.workstream,
      leaseId: effect.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate: {
          id: "candidate-1",
          workstream: effect.workstream,
          baseSha: "base",
          commitSha: "commit",
          treeSha: "tree",
        },
        checkpoints: { first: "commit" },
        satisfied: { first: "already present" },
      },
    });

    expect(result.accepted).toBe(false);
  });

  it("rejects a stale process result without changing canonical state", async () => {
    const initial = (await store()).read();
    const result = reduceRunEvent(initial, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "missing",
      outcome: {
        kind: "initial",
        candidateId: "candidate-1",
        completion: { verdict: "approved" },
        evidence: "review artifact",
      },
    });

    expect(result).toMatchObject({ accepted: false, state: initial });
  });

  it("persists direct findings and converges every anchored obligation on a new candidate", async () => {
    const initial = (await store()).read();
    const selected = reduceRunEvent(initial, {
      kind: "workstreams_selected",
      now: "now",
      baseShas: { "first-stream": "base" },
    });
    const implementation = selected.effects[0]!;
    if (implementation.kind !== "run_implementation") {
      throw new Error("Expected implementation effect.");
    }
    const candidate = {
      id: "candidate-1",
      workstream: implementation.workstream,
      baseSha: "base",
      commitSha: "commit-1",
      treeSha: "tree-1",
    };
    const ready = reduceRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: implementation.workstream,
      leaseId: implementation.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate,
        checkpoints: { first: "commit-1" },
        satisfied: {},
      },
    });
    const review = reduceRunEvent(ready.state, {
      kind: "review_requested",
      workstream: implementation.workstream,
      now: "now",
    });
    const reviewEffect = review.effects[0]!;
    if (reviewEffect.kind !== "run_review") {
      throw new Error("Expected review effect.");
    }
    const findings = reduceRunEvent(review.state, {
      kind: "review_completed",
      workstream: implementation.workstream,
      leaseId: reviewEffect.leaseId,
      outcome: {
        kind: "initial",
        candidateId: "candidate-1",
        evidence: "initial review artifact",
        completion: {
          verdict: "changes_requested",
          findings: [
            {
              summary: "Missing observable behavior",
              evidence: "The endpoint is absent.",
              requiredChange: "Add the endpoint.",
              acceptanceCriteria: ["The endpoint responds."],
            },
          ],
        },
      },
    });
    expect(findings.state.workstreams.source["first-stream"]?.phase).toBe(
      "recovering",
    );
    expect(
      findings.state.reviews["source:first-stream"]?.outstandingIds,
    ).toEqual(["source-first-stream-r1"]);
    expect(findings.state.gates).toMatchObject([
      {
        kind: "review",
        outcome: "failed",
        candidateId: "candidate-1",
        outstandingFindingIds: ["source-first-stream-r1"],
      },
    ]);
    expect(Object.values(findings.state.recoveryEpisodes)).toMatchObject([
      {
        status: "open",
        candidateId: "candidate-1",
        workspace: {
          id: "source:first-stream",
          checkpoint: "commit-1",
          changedPaths: [],
          stateEvidence: "Workspace state was retained by the failed gate.",
        },
      },
    ]);

    const recovery = reduceRunEvent(findings.state, {
      kind: "recovery_requested",
      workstream: implementation.workstream,
      now: "later",
    });
    const recoveryEffect = recovery.effects[0]!;
    if (recoveryEffect.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    const corrected = reduceRunEvent(recovery.state, {
      kind: "recovery_completed",
      workstream: implementation.workstream,
      leaseId: recoveryEffect.leaseId,
      action: {
        kind: "rework_candidate",
        outcome: "completed",
        summary: "Implemented the required endpoint.",
        evidence: "checkpoint commit-2",
        at: "later",
      },
      candidate: {
        ...candidate,
        id: "candidate-2",
        commitSha: "commit-2",
        treeSha: "tree-2",
      },
      correction: {
        fromCandidateId: "candidate-1",
        changedPaths: ["src/endpoint.ts"],
        evidence: "Implementer checkpoint commit-2",
      },
    });
    expect(Object.values(corrected.state.recoveryEpisodes)).toMatchObject([
      {
        status: "completed",
        actions: [{ kind: "rework_candidate", outcome: "completed" }],
      },
    ]);

    const anchored = reduceRunEvent(corrected.state, {
      kind: "review_requested",
      workstream: implementation.workstream,
      now: "later",
    });
    const anchoredEffect = anchored.effects[0]!;
    if (anchoredEffect.kind !== "run_review") {
      throw new Error("Expected anchored review effect.");
    }
    const approved = reduceRunEvent(anchored.state, {
      kind: "review_completed",
      workstream: implementation.workstream,
      leaseId: anchoredEffect.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "candidate-2",
        evidence: "anchored review artifact",
        completion: {
          assessments: [
            {
              id: "source-first-stream-r1",
              status: "resolved",
              evidence: "The endpoint now responds.",
            },
          ],
          regressions: [
            {
              summary: "caused regression",
              evidence: "New endpoint breaks another route.",
              requiredChange: "Repair the route.",
              acceptanceCriteria: ["Both routes work."],
              changedPaths: ["src/other.ts"],
              causalEvidence: "The route was not changed by this correction.",
            },
          ],
        },
      },
    });
    expect(approved.state.workstreams.source["first-stream"]?.phase).toBe(
      "approved",
    );
    expect(approved.state.findings["source-first-stream-r1"]?.status).toBe(
      "resolved",
    );
    expect(approved.state.reviews["source:first-stream"]?.observations).toEqual(
      [
        {
          summary: "caused regression",
          evidence: "New endpoint breaks another route.",
        },
      ],
    );
  });

  it("settles concurrent work and pauses after the first no-safe-action result", async () => {
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
      providerFailures: 0,
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
    const paused = deferred();
    const actor = new SchedulerActor({
      store: fakeStore,
      targetHead: async () => "base-sha",
      now: () => "now",
      onTransition: (_state, event) => {
        if (event.kind === "run_paused") {
          paused.resolve();
        }
      },
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
    await within("no-safe-action pause", paused.promise, {
      timeoutMs: 2_000,
      diagnostics: () => JSON.stringify(state),
    });

    expect(state).toMatchObject({
      phase: "paused",
      pause: {
        resumePhase: "running",
        reason: action.evidence,
      },
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
          status: "paused",
          providerFailures: 0,
          actions: [action],
        },
      },
    });
    await actor.stop("test complete");
  });

  it("advances an active recovery episode to the narrowed anchored review gate", async () => {
    const run = await store();
    let state = run.read();
    const workstream = { kind: "source" as const, id: "first-stream" };
    state.workstreams.source[workstream.id]!.phase = "recovering";
    state.workstreams.source[workstream.id]!.baseSha = "base-sha";
    state.workstreams.source[workstream.id]!.candidateId = "candidate-2";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream,
      baseSha: "base-sha",
      commitSha: "commit-1",
      treeSha: "tree-1",
    };
    state.candidates["candidate-2"] = {
      ...state.candidates["candidate-1"],
      id: "candidate-2",
      commitSha: "commit-2",
      treeSha: "tree-2",
    };
    for (const id of ["finding-1", "finding-2"]) {
      state.findings[id] = {
        id,
        candidateId: "candidate-1",
        workstream,
        summary: `${id} remains`,
        evidence: `${id} evidence`,
        requiredChange: `Fix ${id}`,
        acceptanceCriteria: [`${id} passes`],
        origin: "initial",
        introducedRound: 0,
        status: "open",
      };
    }
    state.reviews["source:first-stream"] = {
      candidateId: "candidate-2",
      previousCandidateId: "candidate-1",
      round: 1,
      outstandingIds: ["finding-1", "finding-2"],
      latestCorrection: {
        fromCandidateId: "candidate-1",
        changedPaths: ["src/fix.ts"],
        evidence: "Corrected both findings.",
      },
      evidence: ["first review"],
      observations: [],
    };
    state.gates.push({
      id: "review:source:first-stream:candidate-2:1",
      kind: "review",
      workstream,
      candidateId: "candidate-2",
      attempt: 1,
      outcome: "failed",
      evidence: "Both findings remain open.",
      outstandingFindingIds: ["finding-1", "finding-2"],
    });
    state.recoveryEpisodes.episode = {
      id: "episode",
      gateId: "review:source:first-stream:candidate-2:1",
      gateAttempts: ["review:source:first-stream:candidate-2:1"],
      workstream,
      candidateId: "candidate-2",
      workspace: {
        id: "source:first-stream",
        checkpoint: "commit-2",
        changedPaths: [],
        stateEvidence: "The first review failed.",
      },
      outstandingFindingIds: ["finding-1", "finding-2"],
      status: "open",
      cycle: {
        signature: "first",
        identicalNoActionCycles: 0,
        independentlyEscalated: false,
      },
      providerFailures: 0,
      actions: [],
    };

    await run.update(state.revision, () => state);
    state = run.read();

    const requested = reduceRunEvent(state, {
      kind: "recovery_requested",
      workstream,
      now: "now",
    });
    const recovery = requested.effects[0]!;
    if (recovery.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    await run.update(state.revision, () => requested.state);
    state = run.read();
    const retried = reduceRunEvent(state, {
      kind: "recovery_completed",
      workstream,
      leaseId: recovery.leaseId,
      action: {
        kind: "retry",
        outcome: "completed",
        summary: "The existing candidate can be reviewed again.",
        evidence: "No further changes are needed before review.",
        at: "later",
      },
    });
    await run.update(state.revision, () => retried.state);
    state = run.read();
    const reviewed = reduceRunEvent(state, {
      kind: "review_requested",
      workstream,
      now: "later",
    });
    const review = reviewed.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("Expected review effect.");
    }
    await run.update(state.revision, () => reviewed.state);
    state = run.read();
    const narrowed = reduceRunEvent(state, {
      kind: "review_completed",
      workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "candidate-2",
        evidence: "The first finding is resolved; the second remains.",
        completion: {
          assessments: [
            {
              id: "finding-1",
              status: "resolved",
              evidence: "The first behavior now works.",
            },
            {
              id: "finding-2",
              status: "unresolved",
              evidence: "The second behavior still fails.",
            },
          ],
          regressions: [],
        },
      },
    });

    expect(narrowed.accepted).toBe(true);
    await run.update(state.revision, () => narrowed.state);
    const persisted = run.read();
    expect(persisted.recoveryEpisodes.episode).toMatchObject({
      gateId: "review:source:first-stream:candidate-2:3",
      gateAttempts: [
        "review:source:first-stream:candidate-2:1",
        "review:source:first-stream:candidate-2:3",
      ],
      outstandingFindingIds: ["finding-2"],
      status: "open",
    });
    expect(persisted.findings["finding-1"]?.status).toBe("resolved");
    expect(
      buildRecoveryPacket({
        state: persisted,
        effect: {
          kind: "run_recovery",
          workstream,
          leaseId: "next-lease",
          episodeId: "episode",
          independentlyEscalated: false,
        },
      }).outstandingFindings.map((finding) => finding.id),
    ).toEqual(["finding-2"]);
  });

  it("keeps a same-candidate environment repair open for a retried gate", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.candidateId = "candidate-1";
    state.workstreams.source["first-stream"]!.phase = "candidate_ready";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
    };
    const failed = reduceRunEvent(state, {
      kind: "gate_recorded",
      workstream: { kind: "source", id: "first-stream" },
      result: {
        id: "environment:first-stream:1",
        kind: "environment",
        owner: "source:first-stream",
        candidateId: "candidate-1",
        attempt: 1,
        outcome: "failed",
        evidence: "node_modules is missing",
        outstandingFindingIds: [],
      },
      workspace: {
        id: "source:first-stream",
        checkpoint: "commit",
        changedPaths: [],
        stateEvidence: "Dependencies are absent from the owned workspace.",
      },
    });
    const requested = reduceRunEvent(failed.state, {
      kind: "recovery_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "now",
    });
    const effect = requested.effects[0]!;
    if (effect.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    const repaired = reduceRunEvent(requested.state, {
      kind: "recovery_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: effect.leaseId,
      action: {
        kind: "repair_environment",
        outcome: "completed",
        summary: "Installed the missing dependencies.",
        evidence: "npm install completed in the owned worktree.",
        at: "later",
      },
    });

    expect(repaired.accepted).toBe(true);
    expect(repaired.state.workstreams.source["first-stream"]?.phase).toBe(
      "queued",
    );
    expect(Object.values(repaired.state.recoveryEpisodes)).toMatchObject([
      { status: "open", actions: [{ kind: "repair_environment" }] },
    ]);
  });

  it("retains a hook gate with command evidence and retries reconciliation", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.candidateId = "candidate-1";
    state.workstreams.source["first-stream"]!.phase = "candidate_ready";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
    };
    const failed = reduceRunEvent(state, {
      kind: "gate_recorded",
      workstream: { kind: "source", id: "first-stream" },
      result: {
        id: "hook:first-stream:1",
        kind: "hook",
        owner: "source:first-stream",
        candidateId: "candidate-1",
        attempt: 1,
        outcome: "failed",
        evidence: "pre-commit rejected the staged replay",
        command: {
          command: "git commit -m chore",
          cwd: "/tmp/staging",
          exitCode: 1,
          timedOut: false,
          output: "rejected",
        },
        outstandingFindingIds: [],
      },
      workspace: {
        id: "staging:candidate-1",
        checkpoint: "commit",
        changedPaths: ["candidate.txt"],
        stateEvidence: "Hook rejected the disposable staging commit.",
      },
    });
    const requested = reduceRunEvent(failed.state, {
      kind: "recovery_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "now",
    });
    const effect = requested.effects[0]!;
    if (effect.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    const retried = reduceRunEvent(requested.state, {
      kind: "recovery_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: effect.leaseId,
      action: {
        kind: "repair_environment",
        outcome: "completed",
        summary: "Repaired the hook runtime.",
        evidence: "Dependency restored in staging.",
        at: "later",
      },
    });

    expect(retried.state.workstreams.source["first-stream"]?.phase).toBe(
      "approved",
    );
    expect(retried.state.gates[0]).toMatchObject({
      kind: "hook",
      command: { output: "rejected" },
    });
  });

  it("rejects incomplete anchored coverage and stale candidate review results", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.phase = "reviewing";
    state.workstreams.source["first-stream"]!.candidateId = "candidate-2";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "one",
      treeSha: "one",
    };
    state.candidates["candidate-2"] = {
      ...state.candidates["candidate-1"]!,
      id: "candidate-2",
      commitSha: "two",
      treeSha: "two",
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
    state.reviews["source:first-stream"] = {
      candidateId: "candidate-2",
      previousCandidateId: "candidate-1",
      round: 0,
      outstandingIds: ["source-first-stream-r1"],
      latestCorrection: {
        fromCandidateId: "candidate-1",
        changedPaths: ["src/fix.ts"],
        evidence: "checkpoint",
      },
      evidence: ["initial"],
      observations: [],
    };
    state.processLeases.review = {
      id: "review",
      kind: "review",
      workstream: { kind: "source", id: "first-stream" },
      candidateId: "candidate-2",
      attempt: 1,
      acquiredAt: "now",
    };
    const incomplete = reduceRunEvent(state, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "review",
      outcome: {
        kind: "anchored",
        candidateId: "candidate-2",
        evidence: "artifact",
        completion: { assessments: [], regressions: [] },
      },
    });
    expect(incomplete.accepted).toBe(false);
    const stale = reduceRunEvent(state, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "review",
      outcome: {
        kind: "anchored",
        candidateId: "candidate-1",
        evidence: "artifact",
        completion: { assessments: [], regressions: [] },
      },
    });
    expect(stale.accepted).toBe(false);
  });

  it("records an approved repository-state satisfaction receipt without publishing", async () => {
    const state = (await store()).read();
    const candidateId = "satisfied:first-stream:base";
    const assessmentId = `assessment:${candidateId}:current-target`;
    state.workstreams.source["first-stream"] = {
      ...state.workstreams.source["first-stream"]!,
      baseSha: "base",
      candidateId,
      phase: "reviewing",
    };
    state.candidates[candidateId] = {
      id: candidateId,
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "base",
      treeSha: "base-tree",
    };
    state.reviews["source:first-stream"] = {
      candidateId,
      round: 0,
      outstandingIds: [],
      evidence: ["initial approval"],
      observations: [],
    };
    state.satisfaction.assessments[assessmentId] = {
      id: assessmentId,
      candidateId,
      workstream: { kind: "source", id: "first-stream" },
      historicalBaseSha: "base",
      targetSha: "current-target",
      interveningDiff: "diff --git a/x b/x",
      evidence: "Target advanced after the original review.",
      status: "pending",
    };
    state.processLeases.review = {
      id: "review",
      kind: "review",
      workstream: { kind: "source", id: "first-stream" },
      candidateId,
      attempt: 1,
      acquiredAt: "now",
    };

    const completed = reduceRunEvent(state, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "review",
      outcome: {
        kind: "repository_state",
        candidateId,
        assessedTargetSha: "current-target",
        completion: { verdict: "approved" },
        evidence:
          "Repository state satisfies the original workstream contract.",
      },
    });

    expect(completed.accepted).toBe(true);
    expect(completed.state.workstreams.source["first-stream"]?.phase).toBe(
      "completed",
    );
    expect(completed.state.satisfaction.receipts).toMatchObject({
      [`satisfaction:${candidateId}:current-target`]: {
        assessedTargetSha: "current-target",
      },
    });
    expect(completed.state.publication.receipts).toEqual({});

    const rejected = reduceRunEvent(structuredClone(state), {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "review",
      outcome: {
        kind: "repository_state",
        candidateId,
        assessedTargetSha: "current-target",
        completion: {
          verdict: "changes_requested",
          findings: [
            {
              summary: "Target change invalidates the claimed behavior.",
              evidence: "The intervening target diff removes the behavior.",
              requiredChange: "Restore the behavior on the current target.",
              acceptanceCriteria: ["The behavior works on the current target."],
            },
          ],
        },
        evidence: "Repository-state review rejected the stale claim.",
      },
    });
    expect(rejected.state.workstreams.source["first-stream"]?.phase).toBe(
      "recovering",
    );
    expect(
      rejected.state.reviews["source:first-stream"]?.outstandingIds,
    ).toEqual(["source-first-stream-repository-1-1"]);
  });

  it("routes replay preparation and reconciliation failures through owned lifecycle gates", async () => {
    const run = await store();
    const state = run.read();
    state.workstreams.source["first-stream"]!.phase = "approved";
    state.workstreams.source["first-stream"]!.baseSha = "base";
    state.workstreams.source["first-stream"]!.candidateId = "candidate-1";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
    };
    const requested = reduceRunEvent(state, {
      kind: "reconciliation_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "now",
    });
    await run.update(state.revision, () => requested.state);
    const effect = requested.effects[0]!;
    if (effect.kind !== "run_reconciliation") {
      throw new Error("Expected reconciliation effect.");
    }
    const failed = reduceRunEvent(requested.state, {
      kind: "reconciliation_completed",
      workstream: effect.workstream,
      leaseId: effect.leaseId,
      outcome: {
        kind: "reconciliation_required",
        evidence: "The replay conflicted with the target.",
        workspace: {
          id: "staging:first-stream",
          checkpoint: "commit",
          changedPaths: ["src/conflict.ts"],
          stateEvidence: "Conflict markers remain in owned staging.",
        },
      },
    });

    expect(failed.state.workstreams.source["first-stream"]?.phase).toBe(
      "recovering",
    );
    expect(failed.state.gates.at(-1)).toMatchObject({
      kind: "reconciliation",
      outcome: "failed",
    });
  });

  it("routes a failed whole-plan assessment through the recovery role before retrying", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.phase = "completed";
    state.workstreams.source["second-stream"]!.phase = "completed";
    state.phase = "whole_plan_review";
    state.wholePlanReview = { status: "reviewing" };

    const failed = reduceRunEvent(state, {
      kind: "whole_plan_review_failed",
      evidence: "Reviewer provider disconnected.",
    });
    const requested = reduceRunEvent(failed.state, {
      kind: "whole_plan_recovery_requested",
    });
    const interrupted = reduceRunEvent(requested.state, {
      kind: "whole_plan_recovery_abandoned",
    });
    const resumed = reduceRunEvent(interrupted.state, {
      kind: "whole_plan_recovery_requested",
    });
    const completed = reduceRunEvent(resumed.state, {
      kind: "whole_plan_recovery_completed",
      action: {
        kind: "retry",
        outcome: "completed",
        summary: "The next reviewer invocation can safely retry.",
        evidence: "The target and corpus identities remain unchanged.",
        at: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(requested.effects).toEqual([{ kind: "run_whole_plan_recovery" }]);
    expect(resumed.effects).toEqual([{ kind: "run_whole_plan_recovery" }]);
    expect(completed.state.wholePlanReview).toMatchObject({
      status: "pending",
      recovery: {
        status: "completed",
        evidence: ["Reviewer provider disconnected."],
        actions: [
          {
            kind: "retry",
            evidence: "The target and corpus identities remain unchanged.",
          },
        ],
      },
    });
    expect(completed.state.phase).toBe("whole_plan_review");
  });

  it("records whole-plan findings as a runtime repair without changing immutable source coverage", async () => {
    const initial = (await store()).read();
    initial.workstreams.source["first-stream"]!.phase = "completed";
    initial.workstreams.source["second-stream"]!.phase = "completed";
    const reviewing = reduceRunEvent(initial, {
      kind: "whole_plan_review_requested",
    });
    const completed = reduceRunEvent(reviewing.state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "changes_requested",
        repairId: "overall-repair-1",
        candidate: {
          id: "overall-baseline",
          workstream: { kind: "overall", repairId: "overall-repair-1" },
          baseSha: "target",
          commitSha: "target",
          treeSha: "tree",
        },
        findings: [
          {
            summary: "The combined changes miss an integration boundary.",
            evidence: "The run diff demonstrates the missing handoff.",
            requiredChange: "Preserve the handoff across both workstreams.",
            acceptanceCriteria: ["The complete behavior crosses the boundary."],
          },
        ],
        evidence: "whole-plan-review.json",
        reviewedTargetSha: "target",
        reviewedTargetTreeSha: "tree",
      },
    });

    expect(completed.accepted).toBe(true);
    expect(completed.state.wholePlanReview).toMatchObject({
      status: "repairing",
      epoch: {
        originalFindingIds: ["overall-overall-repair-1-r1"],
        outstandingFindingIds: ["overall-overall-repair-1-r1"],
      },
    });
    expect(
      completed.state.workstreams.overall["overall-repair-1"],
    ).toMatchObject({
      phase: "queued",
      candidateId: "overall-baseline",
    });
    expect(
      completed.state.reviews["overall:overall-repair-1"]?.outstandingIds,
    ).toEqual(["overall-overall-repair-1-r1"]);
    expect(completed.state.workstreams.source["first-stream"]?.taskIds).toEqual(
      ["first"],
    );
  });

  it("queues a new canonical repair after an anchored post-publication assessment", async () => {
    const initial = (await store()).read();
    initial.workstreams.source["first-stream"]!.phase = "completed";
    initial.workstreams.source["second-stream"]!.phase = "completed";
    const reviewing = reduceRunEvent(initial, {
      kind: "whole_plan_review_requested",
    });
    const repair = reduceRunEvent(reviewing.state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "changes_requested",
        repairId: "overall-repair-1",
        candidate: {
          id: "overall-baseline",
          workstream: { kind: "overall", repairId: "overall-repair-1" },
          baseSha: "target",
          commitSha: "target",
          treeSha: "tree",
        },
        findings: [
          {
            summary: "The combined changes miss an integration boundary.",
            evidence: "The run diff demonstrates the missing handoff.",
            requiredChange: "Preserve the handoff across both workstreams.",
            acceptanceCriteria: ["The complete behavior crosses the boundary."],
          },
        ],
        evidence: "whole-plan-review.json",
        reviewedTargetSha: "target",
        reviewedTargetTreeSha: "tree",
      },
    });
    const state = repair.state;
    state.workstreams.overall["overall-repair-1"]!.phase = "completed";
    state.wholePlanReview = {
      status: "pending",
      epoch: {
        ...state.wholePlanReview.epoch!,
        latestRepair: {
          candidateId: "overall-baseline",
          targetBaseSha: "target",
          publishedCommitSha: "published",
          publishedTreeSha: "published-tree",
          changedPaths: ["src/integration.ts"],
        },
      },
    };
    const requested = reduceRunEvent(state, {
      kind: "whole_plan_review_requested",
    });

    const reassessed = reduceRunEvent(requested.state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "anchored",
        completion: {
          assessments: [
            {
              id: "overall-overall-repair-1-r1",
              status: "unresolved",
              evidence: "The published repair still misses the handoff.",
            },
          ],
          regressions: [],
        },
        evidence: "anchored-whole-plan-review.json",
        reviewedTargetSha: "published",
        reviewedTargetTreeSha: "published-tree",
      },
    });

    expect(requested.state.wholePlanReview.epoch).toEqual(
      state.wholePlanReview.epoch,
    );
    expect(reassessed.accepted).toBe(true);
    expect(
      reassessed.state.workstreams.overall["overall-repair-2"],
    ).toMatchObject({
      phase: "queued",
      candidateId: "overall-baseline:run-1:overall-repair-2:published",
    });
    expect(reassessed.state.wholePlanReview).toMatchObject({
      status: "repairing",
      epoch: {
        originalFindingIds: ["overall-overall-repair-1-r1"],
        outstandingFindingIds: ["overall-overall-repair-1-r1"],
      },
    });
  });

  it("closes an anchored whole-plan epoch only at its published target", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.phase = "completed";
    state.workstreams.source["second-stream"]!.phase = "completed";
    state.phase = "whole_plan_review";
    state.workstreams.overall["overall-repair-1"] = {
      kind: "overall",
      repairId: "overall-repair-1",
      phase: "completed",
      candidateId: "overall-baseline",
    };
    state.candidates["overall-baseline"] = {
      id: "overall-baseline",
      workstream: { kind: "overall", repairId: "overall-repair-1" },
      baseSha: "target",
      commitSha: "target",
      treeSha: "tree",
    };
    state.wholePlanReview = {
      status: "reviewing",
      epoch: {
        initialTargetSha: "target",
        initialTargetTreeSha: "tree",
        originalFindingIds: ["whole-plan-finding-1"],
        outstandingFindingIds: ["whole-plan-finding-1"],
        findings: [
          {
            id: "whole-plan-finding-1",
            summary: "Missing handoff",
            evidence: "The initial audit found it.",
            requiredChange: "Restore the handoff.",
            acceptanceCriteria: ["The handoff is present."],
          },
        ],
        latestRepair: {
          candidateId: "overall-baseline",
          targetBaseSha: "target",
          publishedCommitSha: "published",
          publishedTreeSha: "published-tree",
          changedPaths: ["src/integration.ts"],
        },
      },
    };

    const approved = reduceRunEvent(state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "anchored",
        completion: {
          assessments: [
            {
              id: "whole-plan-finding-1",
              status: "resolved",
              evidence: "The published repair restores the handoff.",
            },
          ],
          regressions: [],
        },
        evidence: "anchored-whole-plan-review.json",
        reviewedTargetSha: "published",
        reviewedTargetTreeSha: "published-tree",
      },
    });

    expect(approved.state.wholePlanReview).toMatchObject({
      status: "approved",
      reviewedTargetSha: "published",
      reviewedTargetTreeSha: "published-tree",
    });
  });

  it("rejects an overall repair that lacks the whole-plan review baseline and findings", async () => {
    const initial = (await store()).read();
    initial.workstreams.source["first-stream"]!.phase = "completed";
    initial.workstreams.source["second-stream"]!.phase = "completed";
    const review = reduceRunEvent(initial, {
      kind: "whole_plan_review_requested",
    });
    const repair = reduceRunEvent(review.state, {
      kind: "overall_repair_queued",
      repairId: "overall-repair-1",
    });

    expect(repair.accepted).toBe(false);
    expect(repair.state.workstreams.overall).toEqual({});
  });
});

describe(" scheduler actor", () => {
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

  it("pauses before managed work on target dirt and resumes after cleanup", async () => {
    const run = await store();
    const paused = deferred();
    const started = deferred();
    let dirty = true;
    let attempts = 0;
    const actor = new SchedulerActor({
      store: run,
      targetHead: async () => "base-sha",
      captureTargetBoundary: async () => {
        if (dirty) {
          throw new TargetPreconditionError(
            "Unsanctioned target changes: M package-lock.json",
          );
        }
        return JSON.stringify({ head: "base-sha" });
      },
      onTransition: (_state, event) => {
        if (event.kind === "safety_paused") {
          paused.resolve();
        }
      },
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        attempts += 1;
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    await actor.start();
    await within("target-boundary safety pause", paused.promise, {
      timeoutMs: 2_000,
      diagnostics: () => JSON.stringify(run.read()),
    });

    expect(run.read()).toMatchObject({
      phase: "paused",
      pause: {
        resumePhase: "running",
        reason: "Unsanctioned target changes: M package-lock.json",
      },
      processLeases: {},
    });
    expect(attempts).toBe(0);
    await expect(actor.resume()).rejects.toThrow("package-lock.json");
    expect(run.read().phase).toBe("paused");
    expect(attempts).toBe(0);

    dirty = false;
    await actor.resume();
    await within("resumed implementation", started.promise, {
      timeoutMs: 2_000,
      diagnostics: () => JSON.stringify(run.read()),
    });

    expect(run.read()).toMatchObject({
      phase: "running",
      workstreams: { source: { "first-stream": { phase: "implementing" } } },
    });
    expect(attempts).toBe(1);
    await actor.stop("test complete");
  });

  it("pauses a failed projection instead of relaunching it", async () => {
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
    const paused = deferred();
    let attempts = 0;
    const actor = new SchedulerActor({
      store: run,
      onTransition: (_state, event) => {
        if (event.kind === "safety_paused") {
          paused.resolve();
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
    await paused.promise;

    expect(run.read()).toMatchObject({
      phase: "paused",
      pause: {
        resumePhase: "running",
        reason: "projection store write failed",
      },
      projectionDebt: [{ id: "projection:run-1:first" }],
    });
    expect(attempts).toBe(1);
    await actor.stop("test complete");
  });

  it("pauses a failed whole-plan closure instead of relaunching it", async () => {
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
    const paused = deferred();
    let attempts = 0;
    const actor = new SchedulerActor({
      store: fakeStore,
      onTransition: (_state, event) => {
        if (event.kind === "safety_paused") {
          paused.resolve();
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
    await paused.promise;

    expect(state).toMatchObject({
      phase: "paused",
      pause: {
        resumePhase: "whole_plan_review",
        reason: "reviewed target moved before closure",
      },
    });
    expect(attempts).toBe(1);
    await actor.stop("test complete");
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
        episode.providerFailures += 1;
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
      providerFailures: 0,
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
              kind: "repair_environment",
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

  it("aborts, settles, and pauses with retained workstreams requeued", async () => {
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
      phase: "paused",
      workstreams: { source: { "first-stream": { phase: "queued" } } },
      processLeases: {},
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

    expect(run.read().phase).toBe("paused");
    expect(Object.values(run.read().recoveryEpisodes)).toContainEqual(
      expect.objectContaining({
        workspace: expect.objectContaining({
          checkpoint: "checkpoint-on-stop",
        }),
      }),
    );
  });

  it("settles a planner before pausing an unbound planning run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipkin-implement-planner-"));
    temporaryDirectories.add(directory);
    const plan = planFor(directory);
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
      workerConcurrency: 1,
    });
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
      phase: "paused",
      pause: { resumePhase: "planning", reason: "operator stopped planning" },
    });
    expect(run.read().executionPlan).toBeUndefined();
  });

  it("reconciles abandoned review leases without discarding their candidate", async () => {
    const run = await store();
    const selected = reduceRunEvent(run.read(), {
      kind: "workstreams_selected",
      now: "now",
      baseShas: { "first-stream": "base-sha" },
    });
    const effect = selected.effects.find(
      (effect) => effect.kind === "run_implementation",
    );
    if (!effect) {
      throw new Error("Expected implementation effect.");
    }
    const leaseId = effect.leaseId;
    const candidate = {
      id: "candidate-1",
      workstream: { kind: "source" as const, id: "first-stream" },
      baseSha: "base-sha",
      commitSha: "commit",
      treeSha: "tree",
    };
    const completed = reduceRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate,
        checkpoints: { first: "commit" },
        satisfied: {},
      },
    });
    const reviewing = reduceRunEvent(completed.state, {
      kind: "review_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "now",
    });
    const revision = run.read().revision;
    await run.update(revision, () => reviewing.state);

    const actor = new SchedulerActor({ store: run });
    await actor.start();

    expect(run.read()).toMatchObject({
      candidates: { "candidate-1": candidate },
      workstreams: { source: { "first-stream": { phase: "candidate_ready" } } },
      processLeases: {},
    });
  });
});
