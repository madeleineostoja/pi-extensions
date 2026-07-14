import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPapercutStore } from "pi-papercuts";
import { describe, expect, it, vi } from "vitest";
import { persistPapercutCandidates } from "./papercuts.js";

const proposal = {
  key: "missing-check",
  title: "Missing check",
  trigger: "Runs fail",
  impact: "Future runs fail",
  currentGap: "No guard",
  proposedResolution: "Add a guard",
  suggestedDestination: "test",
};

describe("persistPapercutCandidates", () => {
  it("loads pi-papercuts through its public package entry point", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-implement-papercuts-"));
    execFileSync("git", ["init", "-q"], { cwd: root });

    await expect(
      persistPapercutCandidates({ papercuts: [proposal] }, root, {
        kind: "pi-implement",
        runId: "run-1",
        role: "implementer",
      }),
    ).resolves.toMatchObject({ created: 1 });
  });

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

  it("drops a full-shaped malformed candidate without losing a valid neighbor", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-implement-papercuts-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const result = await persistPapercutCandidates(
      {
        verdict: "approved",
        papercuts: [{ ...proposal, key: 7 }, proposal],
      },
      root,
      { kind: "pi-implement", runId: "run-1", role: "reviewer" },
      async (storeRoot) => createPapercutStore(storeRoot),
    );

    expect(result).toMatchObject({
      created: 1,
      rejected: 1,
      warning: expect.stringContaining("malformed"),
    });
    await expect(createPapercutStore(root).load()).resolves.toMatchObject({
      records: [{ key: proposal.key, occurrences: 1 }],
    });
  });

  it("deduplicates retries and roles while preserving source attribution", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-implement-papercuts-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const createStore = vi.fn(async (storeRoot: string) =>
      createPapercutStore(storeRoot),
    );
    for (const role of ["implementer", "implementer", "reviewer"]) {
      await persistPapercutCandidates(
        { papercuts: [proposal] },
        root,
        { kind: "pi-implement", runId: "run-1", taskId: "task-1", role },
        createStore,
      );
    }

    expect(createStore).toHaveBeenCalledTimes(3);
    expect(createStore).toHaveBeenNthCalledWith(1, root);
    const file = await createPapercutStore(root).load();
    expect(file.records).toHaveLength(1);
    expect(file.records[0]).toMatchObject({
      key: proposal.key,
      occurrences: 3,
      sources: [
        {
          kind: "pi-implement",
          runId: "run-1",
          taskId: "task-1",
          role: "implementer",
        },
        {
          kind: "pi-implement",
          runId: "run-1",
          taskId: "task-1",
          role: "reviewer",
        },
      ],
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
