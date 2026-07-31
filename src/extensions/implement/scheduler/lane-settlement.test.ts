import { afterEach, describe, expect, it } from "vitest";
import { SchedulerActor } from "./scheduler-actor.js";
import { reduceRunEvent, selectReadyWorkstreams } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
} from "./scheduler-test-support.js";

afterEach(() => cleanupSchedulerStores());

describe("lane-local settlement", () => {
  it("fails an exhausted lane, skips its queued dependent, and settles incomplete", async () => {
    const store = await createSchedulerStore();
    let state = store.read();

    expect(reduceRunEvent(state, { kind: "run_incomplete" })).toMatchObject({
      accepted: false,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const selected = reduceRunEvent(state, {
        kind: "workstreams_selected",
        now: `2026-01-01T00:0${attempt}:00.000Z`,
        baseShas: { "first-stream": "base-sha" },
      });
      const implementation = selected.effects[0];
      if (implementation?.kind !== "run_implementation") {
        throw new Error("expected first-stream implementation");
      }
      state = reduceRunEvent(selected.state, {
        kind: "implementation_failed",
        workstream: implementation.workstream,
        leaseId: implementation.leaseId,
        category: "provider_failure",
        evidence: `provider unavailable ${attempt}`,
      }).state;
    }

    expect(state.phase).toBe("running");
    expect(state.workstreams.source).toMatchObject({
      "first-stream": { phase: "failed" },
      "second-stream": { phase: "dependency_skipped" },
    });
    expect(selectReadyWorkstreams(state)).toEqual([]);
    expect(Object.values(state.failures)).toContainEqual(
      expect.objectContaining({
        category: "dependency_skipped",
        assignment: "dependency_skip",
        workstream: { kind: "source", id: "second-stream" },
        evidence: "Unavailable direct dependencies: first-stream (failed).",
      }),
    );

    const incomplete = reduceRunEvent(state, { kind: "run_incomplete" });
    expect(incomplete).toMatchObject({ accepted: true });
    expect(incomplete.state.phase).toBe("incomplete");
    await store.update(store.read().revision, () => incomplete.state);
    expect(store.read().phase).toBe("incomplete");
  });

  it("settles a transient operational retry when its lane later succeeds", async () => {
    const store = await createSchedulerStore();
    let state = store.read();
    const selected = reduceRunEvent(state, {
      kind: "workstreams_selected",
      now: "2026-01-01T00:01:00.000Z",
      baseShas: { "first-stream": "base-sha" },
    });
    const firstAttempt = selected.effects[0];
    if (firstAttempt?.kind !== "run_implementation") {
      throw new Error("expected first-stream implementation");
    }
    state = reduceRunEvent(selected.state, {
      kind: "implementation_failed",
      workstream: firstAttempt.workstream,
      leaseId: firstAttempt.leaseId,
      category: "provider_failure",
      evidence: "transient provider failure",
    }).state;

    const retried = reduceRunEvent(state, {
      kind: "workstreams_selected",
      now: "2026-01-01T00:02:00.000Z",
      baseShas: { "first-stream": "base-sha" },
    });
    const secondAttempt = retried.effects[0];
    if (secondAttempt?.kind !== "run_implementation") {
      throw new Error("expected retried first-stream implementation");
    }
    const completed = reduceRunEvent(retried.state, {
      kind: "implementation_completed",
      workstream: secondAttempt.workstream,
      leaseId: secondAttempt.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate: {
          id: "candidate:first-stream",
          workstream: secondAttempt.workstream,
          baseSha: "base-sha",
          commitSha: "candidate-sha",
          treeSha: "candidate-tree",
        },
        checkpoints: { first: "candidate-sha" },
        satisfied: {},
      },
    });

    expect(completed.accepted).toBe(true);
    expect(Object.values(completed.state.operationalRetries)).toContainEqual(
      expect.objectContaining({
        lane: "implementation",
        workstream: { kind: "source", id: "first-stream" },
        status: "completed",
      }),
    );
    await store.update(store.read().revision, () => completed.state);
    expect(store.read().workstreams.source["first-stream"]?.phase).toBe(
      "candidate_ready",
    );
  });

  it("propagates queued dependency skips transitively with direct evidence", async () => {
    const store = await createSchedulerStore();
    let state = store.read();
    state.workstreams.source["third-stream"] = {
      kind: "source",
      id: "third-stream",
      taskIds: ["third"],
      dependsOn: ["second-stream"],
      phase: "queued",
    };
    state.tasks.third = { workstreamId: "third-stream", phase: "pending" };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const selected = reduceRunEvent(state, {
        kind: "workstreams_selected",
        now: `2026-01-01T00:1${attempt}:00.000Z`,
        baseShas: { "first-stream": "base-sha" },
      });
      const implementation = selected.effects[0];
      if (implementation?.kind !== "run_implementation") {
        throw new Error("expected first-stream implementation");
      }
      state = reduceRunEvent(selected.state, {
        kind: "implementation_failed",
        workstream: implementation.workstream,
        leaseId: implementation.leaseId,
        category: "provider_failure",
        evidence: "provider unavailable",
      }).state;
    }

    expect(state.workstreams.source["third-stream"]?.phase).toBe(
      "dependency_skipped",
    );
    expect(Object.values(state.failures)).toContainEqual(
      expect.objectContaining({
        workstream: { kind: "source", id: "third-stream" },
        evidence:
          "Unavailable direct dependencies: second-stream (dependency_skipped).",
      }),
    );
  });

  it("drives a quiescent partial run to incomplete without global shutdown", async () => {
    const store = await createSchedulerStore();
    const actor = new SchedulerActor({
      store,
      executeEffect: async ({ effect, dispatch }) => {
        if (effect.kind !== "run_implementation") {
          throw new Error(`unexpected effect ${effect.kind}`);
        }
        await dispatch({
          kind: "implementation_failed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          category: "provider_failure",
          evidence: "provider unavailable",
        });
      },
    });

    await actor.start();
    await actor.settle();

    expect(store.read()).toMatchObject({
      phase: "incomplete",
      workstreams: {
        source: {
          "first-stream": { phase: "failed" },
          "second-stream": { phase: "dependency_skipped" },
        },
      },
    });
  });
});
