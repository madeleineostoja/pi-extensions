import { describe, expect, it, vi } from "vitest";
import type { SchedulerEffect, SchedulerEvent } from "./scheduler/scheduler.js";
import { runPublication } from "./publication.js";
import type { RunState } from "./store.js";
import type { PublicationOutcome } from "./write-ahead-publication.js";

const workstream = { kind: "source", id: "first-stream" } as const;
const effect = {
  kind: "run_publication",
  workstream,
  leaseId: "publication:1",
  candidateId: "candidate:1",
  intentId: "intent:1",
} satisfies Extract<SchedulerEffect, { kind: "run_publication" }>;

function state(): RunState {
  return {
    publication: {
      intents: {
        "intent:1": {
          id: "intent:1",
          operationId: "reconciliation:1",
          workstream,
          candidateId: "candidate:1",
          preparationId: "preparation:1",
          targetBaseSha: "base-sha",
          preparedCommitSha: "prepared-sha",
          preparedTreeSha: "prepared-tree",
          targetRef: "refs/heads/main",
          protectedArtifactSnapshots: {},
          protectedArtifactHashes: {},
        },
      },
      preparations: {
        "preparation:1": {
          id: "preparation:1",
          operationId: "reconciliation:1",
          candidateId: "candidate:1",
          candidateCommitSha: "candidate-sha",
          candidateTreeSha: "candidate-tree",
          disposition: "same_base",
          targetBaseSha: "base-sha",
          preparedCommitSha: "prepared-sha",
          preparedTreeSha: "prepared-tree",
          targetRef: "refs/heads/main",
          stagingBranch: "staging",
          stagingWorktree: "/tmp/staging",
          changedPaths: ["src/example.ts"],
          hookEvidence: "hooks passed",
          hookCommand: {
            command: "git commit",
            exitCode: 0,
            output: "committed",
          },
        },
      },
      receipts: {},
      supersessions: {},
      abandonments: {},
    },
  } as unknown as RunState;
}

describe("publication recovery", () => {
  it("classifies a thrown publication attempt with exact no-write recovery", async () => {
    const recover = vi
      .fn<() => Promise<PublicationOutcome>>()
      .mockResolvedValue({ kind: "retry_from_base" });

    await expect(
      runPublication({
        state: state(),
        effect,
        publisher: {
          publish: vi.fn().mockRejectedValue(new Error("update failed")),
          recover,
        },
        dispatch: vi.fn(),
      }),
    ).rejects.toMatchObject({
      outcome: { kind: "retry_from_base" },
    });
    expect(recover).toHaveBeenCalledOnce();
  });

  it("receipts a publication found at its prepared target after an exception", async () => {
    const dispatch = vi.fn<(event: SchedulerEvent) => Promise<void>>();
    const publishedAt = "2026-01-01T00:00:00.000Z";

    await runPublication({
      state: state(),
      effect,
      publisher: {
        publish: vi.fn().mockRejectedValue(new Error("post-write crash")),
        recover: vi.fn().mockResolvedValue({
          kind: "published",
          receipt: {
            intentId: "intent:1",
            candidateId: "candidate:1",
            targetBaseSha: "base-sha",
            publishedCommitSha: "prepared-sha",
            publishedTreeSha: "prepared-tree",
            targetRef: "refs/heads/main",
            protectedArtifactHashes: {},
            publishedAt,
          },
        }),
      },
      dispatch,
    });

    expect(dispatch.mock.calls.map(([event]) => event.kind)).toEqual([
      "publication_receipt_recorded",
      "publication_completed",
    ]);
  });
});
