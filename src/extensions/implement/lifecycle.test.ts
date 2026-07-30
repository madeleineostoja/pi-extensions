import { describe, expect, it } from "vitest";
import {
  SchedulerActor,
  SchedulerActorError,
} from "./scheduler/scheduler-actor.js";
import { reduceRunEvent } from "./scheduler/scheduler.js";
import { RunStateSchema } from "./store.js";
import { createLifecycleFixture } from "./lifecycle-test-support.js";
import {
  buildWorkstreamPacket,
  workstreamWorkspace,
} from "./workstream-candidate.js";

describe("durable lifecycle", () => {
  it("persists selection and rejects a stale completion after reload", async () => {
    const fixture = await createLifecycleFixture();
    try {
      const selected = reduceRunEvent(fixture.store.read(), {
        kind: "workstreams_selected",
        now: "2026-01-01T00:00:00.000Z",
        baseShas: { "first-stream": "base-sha" },
      });
      expect(selected.accepted).toBe(true);
      await fixture.store.update(
        fixture.store.read().revision,
        () => selected.state,
      );
      const state = (await fixture.reopen()).read();
      const effect = selected.effects[0];
      if (
        !effect ||
        effect.kind !== "run_implementation" ||
        effect.workstream.kind !== "source"
      ) {
        throw new Error("Expected a source implementation effect.");
      }
      const workstream = effect.workstream;
      expect(() =>
        buildWorkstreamPacket({
          state,
          plan: fixture.plan,
          workstreamId: workstream.id,
          workspace: workstreamWorkspace(state, workstream.id),
        }),
      ).not.toThrow();

      const stale = reduceRunEvent(state, {
        kind: "implementation_completed",
        workstream,
        leaseId: "stale-lease",
        outcome: {
          kind: "candidate_ready",
          candidate: {
            id: "stale-candidate",
            workstream: effect.workstream,
            baseSha: "base-sha",
            commitSha: "stale-commit",
            treeSha: "stale-tree",
          },
          checkpoints: { first: "stale-commit" },
          satisfied: {},
        },
      });
      expect(stale).toMatchObject({ accepted: false });
      expect(RunStateSchema.safeParse(state).success).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("terminally fails a local actor invariant without opening recovery", async () => {
    const fixture = await createLifecycleFixture();
    try {
      let failed!: () => void;
      const failedTransition = new Promise<void>((resolve) => {
        failed = resolve;
      });
      const actor = new SchedulerActor({
        store: fixture.store,
        onTransition: (_state, event) => {
          if (event.kind === "failure_requested") {
            failed();
          }
        },
        executeEffect: async () => {
          throw new SchedulerActorError("local scheduler invariant failed");
        },
      });

      await actor.start();
      await failedTransition;
      await actor.settle();

      expect(actor.snapshot()).toMatchObject({ phase: "failed" });
      expect(actor.snapshot().recoveryEpisodes).toEqual({});
    } finally {
      fixture.dispose();
    }
  });
});
