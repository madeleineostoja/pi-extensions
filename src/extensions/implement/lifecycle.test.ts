import { describe, expect, it } from "vitest";
import { RecoverySafetyError } from "./recovery-service.js";
import { SchedulerActor, SchedulerActorError } from "./scheduler-actor.js";
import { reduceRunEvent } from "./scheduler.js";
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

  it("safety-pauses a local actor invariant without opening recovery", async () => {
    const fixture = await createLifecycleFixture();
    try {
      let paused!: () => void;
      const pausedTransition = new Promise<void>((resolve) => {
        paused = resolve;
      });
      const actor = new SchedulerActor({
        store: fixture.store,
        onTransition: (_state, event) => {
          if (event.kind === "safety_paused") {
            paused();
          }
        },
        executeEffect: async () => {
          throw new SchedulerActorError("local scheduler invariant failed");
        },
      });

      await actor.start();
      await pausedTransition;
      await actor.settle();

      expect(actor.snapshot()).toMatchObject({ phase: "paused" });
      expect(actor.snapshot().recoveryEpisodes).toEqual({});
    } finally {
      fixture.dispose();
    }
  });

  it("abandons persisted work then safety-pauses an unsafe recovery", async () => {
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
      const effects: string[] = [];
      const actor = new SchedulerActor({
        store: await fixture.reopen(),
        executeEffect: async ({ effect }) => {
          effects.push(effect.kind);
          if (effect.kind === "run_implementation") {
            throw new Error("provider interrupted");
          }
          if (effect.kind === "run_recovery") {
            throw new RecoverySafetyError("no safe correction");
          }
        },
      });

      await actor.start();
      await actor.settle();

      expect(effects).toEqual(["run_implementation", "run_recovery"]);
      expect(actor.snapshot()).toMatchObject({ phase: "paused" });
      expect(actor.snapshot().processLeases).toEqual({});
      expect(Object.values(actor.snapshot().recoveryEpisodes)).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });
});
