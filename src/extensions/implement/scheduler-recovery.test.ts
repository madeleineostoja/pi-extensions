import { afterEach, describe, expect, it } from "vitest";
import { buildRecoveryPacket } from "./recovery-packet.js";
import { reduceRunEvent, SchedulerActor } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
  deferred,
} from "./scheduler-test-support.js";
import type { RunState, RunStore } from "./store.js";
import { within } from "./test-boundary.js";
import { WorkerPacketError } from "./worker-invocation.js";

afterEach(cleanupSchedulerStores);

describe("scheduler recovery lifecycle", () => {
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
});
