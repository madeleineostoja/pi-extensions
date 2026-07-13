import { describe, expect, it, vi } from "vitest";
import { persistPapercutCandidates, type PapercutStore } from "./papercuts.js";

const proposal = {
  key: "missing-check",
  title: "Missing check",
  trigger: "Runs fail",
  impact: "Future runs fail",
  currentGap: "No guard",
  proposedResolution: "Add a guard",
  suggestedDestination: "test",
};

function store(
  outcomes: Array<"created" | "merged" | "rejected">,
): PapercutStore {
  return {
    propose: vi.fn(async () => ({ kind: outcomes.shift() ?? "created" })),
  };
}

describe("persistPapercutCandidates", () => {
  it("does nothing when a typed result has no papercuts", async () => {
    const createStore = vi.fn();
    await expect(
      persistPapercutCandidates(
        { verdict: "approved" },
        "/main",
        { kind: "pi-implement", runId: "run-1", role: "reviewer" },
        createStore,
      ),
    ).resolves.toBeUndefined();
    expect(createStore).not.toHaveBeenCalled();
  });

  it("drops a full-shaped malformed candidate after the core result is accepted", async () => {
    const papercutStore = store(["rejected"]);
    const result = await persistPapercutCandidates(
      { verdict: "approved", papercuts: [{ ...proposal, impact: 7 }] },
      "/main",
      { kind: "pi-implement", runId: "run-1", role: "reviewer" },
      async () => papercutStore,
    );
    expect(result).toMatchObject({
      rejected: 1,
      warning: expect.stringContaining("malformed"),
    });
    expect(papercutStore.propose).toHaveBeenCalledWith(
      expect.objectContaining({ impact: 7 }),
      expect.objectContaining({ role: "reviewer" }),
    );
  });

  it("routes retries and roles through one main-root store with distinct attribution", async () => {
    const papercutStore = store(["created", "merged", "merged"]);
    const createStore = vi.fn(async () => papercutStore);
    for (const role of ["implementer", "implementer", "reviewer"]) {
      await persistPapercutCandidates(
        { papercuts: [proposal] },
        "/main-checkout",
        { kind: "pi-implement", runId: "run-1", taskId: "task-1", role },
        createStore,
      );
    }
    expect(createStore).toHaveBeenCalledWith("/main-checkout");
    expect(papercutStore.propose).toHaveBeenNthCalledWith(1, proposal, {
      kind: "pi-implement",
      runId: "run-1",
      taskId: "task-1",
      role: "implementer",
    });
    expect(papercutStore.propose).toHaveBeenLastCalledWith(proposal, {
      kind: "pi-implement",
      runId: "run-1",
      taskId: "task-1",
      role: "reviewer",
    });
  });

  it("turns store failures into advisory warnings", async () => {
    await expect(
      persistPapercutCandidates(
        { papercuts: [proposal] },
        "/main",
        { kind: "pi-implement", runId: "run-1", role: "implementer" },
        async () => {
          throw new Error("registry locked");
        },
      ),
    ).resolves.toMatchObject({
      warning: "Papercut persistence failed: registry locked",
    });
  });
});
