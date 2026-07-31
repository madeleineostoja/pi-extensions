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
