import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerActor } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
  deferred,
} from "./scheduler-test-support.js";
import type { RunState, RunStore } from "./store.js";
import { within } from "./test-boundary.js";
import { TargetPreconditionError } from "./workstream-candidate.js";

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
});
