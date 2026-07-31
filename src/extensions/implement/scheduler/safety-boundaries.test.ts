import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TargetBoundaryError,
  WorkstreamCandidateLifecycleError,
} from "../workstream-candidate.js";
import { SchedulerActor } from "./scheduler-actor.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
} from "./scheduler-test-support.js";

afterEach(() => cleanupSchedulerStores());

describe("global safety boundaries", () => {
  it("aborts independent workers when target authority cannot be proven", async () => {
    const store = await createSchedulerStore(2, true);
    let independentSignal: AbortSignal | undefined;
    const actor = new SchedulerActor({
      store,
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        if (effect.workstream.kind !== "source") {
          throw new Error("expected source implementation");
        }
        if (effect.workstream.id === "first-stream") {
          throw new TargetBoundaryError("target checkout changed");
        }
        independentSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });

    await actor.start();
    await vi.waitFor(() => expect(independentSignal?.aborted).toBe(true));
    await actor.settle();

    expect(store.read()).toMatchObject({
      phase: "failed",
      failure: { category: "workspace_unsafe" },
    });
  });

  it("aborts independent workers when owned candidate identity is invalid", async () => {
    const store = await createSchedulerStore(2, true);
    let independentSignal: AbortSignal | undefined;
    const actor = new SchedulerActor({
      store,
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        if (effect.workstream.kind !== "source") {
          throw new Error("expected source implementation");
        }
        if (effect.workstream.id === "first-stream") {
          throw new WorkstreamCandidateLifecycleError(
            "owned branch changed",
            "workspace_unsafe",
            undefined,
            {
              branch: "unexpected-branch",
              head: "base-sha",
              tree: "base-tree",
              clean: false,
              status: [{ status: " M", path: "src/endpoint.ts" }],
            },
          );
        }
        independentSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });

    await actor.start();
    await vi.waitFor(() => expect(independentSignal?.aborted).toBe(true));
    await actor.settle();

    expect(store.read().phase).toBe("failed");
  });
});
