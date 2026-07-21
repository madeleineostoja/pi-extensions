import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type CanonicalRunState, RunStore } from "./canonical-state.js";
import { SchedulerActor } from "./scheduler-actor.js";

function state(): CanonicalRunState {
  return {
    schemaVersion: 3,
    revision: 0,
    run: {
      id: "run-1",
      target: {
        checkoutRoot: "/repo",
        gitDir: "/repo/.git",
        commonGitDir: "/repo/.git",
        branchRef: "refs/heads/main",
        startHead: "base",
      },
      plan: {
        path: "/repo/plan.md",
        hash: "plan",
        indexConvention: "zero-based",
      },
      configuredWorkerConcurrency: 2,
      effectiveWorkerConcurrency: 2,
    },
    graph: {
      tasks: [
        {
          id: "a",
          planIndex: 0,
          title: "A",
          taskHash: "a",
          dependsOn: [],
        },
        {
          id: "b",
          planIndex: 1,
          title: "B",
          taskHash: "b",
          dependsOn: [],
        },
      ],
    },
    runtime: {
      phase: "preflight",
      tasks: { a: { phase: "queued" }, b: { phase: "queued" } },
    },
    candidates: {},
    reviewConvergence: {},
    workerLeases: [],
    integrationAttempts: [],
    landingReceipts: [],
    projectionDebt: [],
    cleanupDebt: [],
    createdAt: "now",
    updatedAt: "now",
  };
}

function store(): RunStore {
  const directory = mkdtempSync(join(tmpdir(), "pi-implement-actor-"));
  return RunStore.create(join(directory, "run.json"), state());
}

describe("SchedulerActor", () => {
  it("persists every worker lease before dispatching its worker", async () => {
    const runStore = store();
    const seenLeases: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: async () => {
        seenLeases.push(runStore.read().workerLeases.map((lease) => lease.id));
        await gate;
        return { kind: "satisfied" };
      },
    });

    await actor.start();
    expect(seenLeases).toEqual([
      ["worker:run-1:2:0", "worker:run-1:2:1"],
      ["worker:run-1:2:0", "worker:run-1:2:1"],
    ]);

    release();
    await actor.settle();
    expect(runStore.read().runtime.tasks).toEqual({
      a: { phase: "completed", result: "satisfied" },
      b: { phase: "completed", result: "satisfied" },
    });
    expect(runStore.read().workerLeases).toEqual([]);
  });

  it("reconciles retained leases instead of assuming an in-memory worker survived", async () => {
    const runStore = store();
    const current = runStore.read();
    await runStore.update(current.revision, (state) => ({
      ...state,
      runtime: {
        ...state.runtime,
        phase: "running",
        tasks: {
          ...state.runtime.tasks,
          a: { phase: "executing", workerLeaseId: "retained" },
        },
      },
      workerLeases: [
        { id: "retained", taskId: "a", attempt: 1, acquiredAt: "earlier" },
      ],
    }));
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: async () => ({ kind: "satisfied" }),
    });

    await actor.start();
    await actor.settle();

    expect(runStore.read().runtime.tasks.a).toEqual({
      phase: "completed",
      result: "satisfied",
    });
    expect(runStore.read().workerLeases).toEqual([]);
  });

  it("persists stopping and settles aborted workers before returning", async () => {
    const runStore = store();
    let settled = false;
    const actor = new SchedulerActor({
      store: runStore,
      executeWorker: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              settled = true;
              resolve({ kind: "cancelled" });
            },
            { once: true },
          );
        }),
    });

    await actor.start();
    await actor.stop();

    expect(settled).toBe(true);
    expect(runStore.read().runtime.phase).toBe("stopping");
    expect(runStore.read().workerLeases).toEqual([]);
    expect(runStore.read().runtime.tasks).toEqual({
      a: { phase: "queued" },
      b: { phase: "queued" },
    });
  });
});
