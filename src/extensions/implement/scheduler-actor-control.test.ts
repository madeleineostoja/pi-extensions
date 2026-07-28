import { afterEach, describe, expect, it } from "vitest";
import { reduceRunEvent, SchedulerActor } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
  createUnboundSchedulerRun,
} from "./scheduler-test-support.js";
import { WorkstreamCandidateLifecycleError } from "./workstream-candidate.js";

afterEach(cleanupSchedulerStores);

describe("scheduler actor stop and reload lifecycle", () => {
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
    const { run, plan } = createUnboundSchedulerRun();
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
