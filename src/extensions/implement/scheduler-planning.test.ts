import { afterEach, describe, expect, it } from "vitest";
import { buildReviewPacket } from "./review.js";
import { reduceRunEvent, selectReadyWorkstreams } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
  planFor,
} from "./scheduler-test-support.js";

afterEach(cleanupSchedulerStores);

describe("scheduler planning and candidate selection", () => {
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
});
