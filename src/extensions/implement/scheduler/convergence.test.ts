import { afterEach, describe, expect, it } from "vitest";
import { SchedulerActor } from "./scheduler-actor.js";
import { reduceRunEvent } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
  deferred,
} from "./scheduler-test-support.js";
import type { RunState } from "../store.js";

afterEach(() => cleanupSchedulerStores());

describe("concurrent integration scheduling", () => {
  it("keeps independent default-capacity implementations live concurrently", async () => {
    const store = await createSchedulerStore(3, true);
    const entered = deferred();
    const active = new Set<string>();
    const actor = new SchedulerActor({
      store,
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        if (effect.workstream.kind !== "source") {
          throw new Error("expected source implementation");
        }
        active.add(effect.workstream.id);
        if (active.size === 2) {
          entered.resolve();
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });

    await actor.start();
    await entered.promise;

    expect(active).toEqual(new Set(["first-stream", "second-stream"]));
    expect(Object.keys(store.read().processLeases)).toHaveLength(2);
    await actor.stop();
  });

  it("integrates an approved quiescent candidate before assigning another ready batch", async () => {
    const store = await createSchedulerStore(1, true);
    const selected = reduceRunEvent(store.read(), {
      kind: "workstreams_selected",
      now: "2026-01-01T00:00:00.000Z",
      baseShas: { "first-stream": "base-sha" },
    });
    const implementation = selected.effects[0]!;
    if (implementation.kind !== "run_implementation") {
      throw new Error("expected implementation");
    }
    const admitted = reduceRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: implementation.workstream,
      leaseId: implementation.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate: candidate(),
        checkpoints: { first: "candidate-sha" },
        satisfied: {},
      },
    });
    const reviewRequested = reduceRunEvent(admitted.state, {
      kind: "review_requested",
      workstream: implementation.workstream,
      now: "2026-01-01T00:01:00.000Z",
    });
    const review = reviewRequested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected review");
    }
    const approved = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "initial",
        candidateId: "candidate:first",
        evidence: "review artifact",
        completion: {
          verdict: "approved",
          publicationCommitSubject: "feat: publish candidate",
        },
      },
    });

    expect(
      reduceRunEvent(approved.state, {
        kind: "workstreams_selected",
        now: "2026-01-01T00:02:00.000Z",
        baseShas: { "second-stream": "base-sha" },
      }),
    ).toMatchObject({
      accepted: false,
      error: expect.stringContaining("integrate before another"),
    });
    expect(
      reduceRunEvent(approved.state, {
        kind: "reconciliation_requested",
        workstream: implementation.workstream,
        now: "2026-01-01T00:02:00.000Z",
      }).effects,
    ).toMatchObject([{ kind: "run_reconciliation" }]);
  });
});

function candidate(): RunState["candidates"][string] {
  return {
    id: "candidate:first",
    workstream: { kind: "source", id: "first-stream" },
    baseSha: "base-sha",
    commitSha: "candidate-sha",
    treeSha: "candidate-tree",
    changedPaths: ["src/endpoint.ts"],
    implementationEvidence: {
      summary: "implemented",
      verification: ["tests pass"],
    },
  };
}
