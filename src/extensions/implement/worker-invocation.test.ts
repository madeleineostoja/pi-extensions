import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initialWorkstreamReviewSchema,
  recoveryCompletionSchema,
} from "./result-schemas.js";
import { buildRecoveryPacket } from "./recovery-packet.js";
import type { ImplementRoles } from "./subagents.js";
import { RunStateSchema, type RunState } from "./store.js";
import {
  MAX_WORKER_PROMPT_BYTES,
  spawnValidatedWorker,
  WorkerPacketError,
} from "./worker-invocation.js";

const roles: ImplementRoles = {
  implementer: {
    type: "pipkin:implement:implementer",
    model: "test/medium",
    thinking: "medium",
  },
  reviewer: {
    type: "pipkin:implement:reviewer",
    model: "test/high",
    thinking: "high",
  },
  planner: {
    type: "pipkin:implement:planner",
    model: "test/high",
    thinking: "high",
  },
  recovery: {
    type: "pipkin:implement:recovery",
    model: "test/medium",
    thinking: "medium",
  },
};

describe("worker invocation", () => {
  it("rejects an oversized rendered packet before spawning", async () => {
    let spawned = false;

    await expect(
      spawnValidatedWorker({
        packet: {
          role: "recovery" as const,
          completionKind: "recovery" as const,
          identity: "episode/gate",
          workspace: { path: "/owned/worktree" },
        },
        subagents: {
          stop: async () => undefined,
          spawn: async () => {
            spawned = true;
            return "worker" as never;
          },
          waitFor: async () => ({ status: "failed" as const, error: "unused" }),
        },
        roles,
        readOnly: false,
        completionKind: "recovery",
        taskId: "work",
        description: "Recover work",
        completion: {
          description: "Return one bounded recovery action.",
          schema: recoveryCompletionSchema,
        },
        render: () => "x".repeat(MAX_WORKER_PROMPT_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(WorkerPacketError);
    expect(spawned).toBe(false);
  });

  it("pairs fixed roles, read-only tools, and completion contracts", async () => {
    let spawned: Record<string, unknown> | undefined;
    await spawnValidatedWorker({
      packet: {
        role: "reviewer" as const,
        completionKind: "initial-review" as const,
        identity: "run-1/work/candidate",
        workspace: { path: "/owned/worktree" },
      },
      subagents: {
        stop: async () => undefined,
        spawn: async (args) => {
          spawned = args as unknown as Record<string, unknown>;
          return "worker" as never;
        },
        waitFor: async () => ({ status: "failed" as const, error: "unused" }),
      },
      roles,
      taskId: "work",
      description: "Review work",
      readOnly: true,
      completionKind: "initial-review",
      completion: {
        description: "Approve or return direct blocking findings.",
        schema: initialWorkstreamReviewSchema,
      },
      render: () => "review assignment",
    });

    expect(spawned).toMatchObject({
      type: "pipkin:implement:reviewer",
      model: "test/high",
      thinking: "high",
      role: "reviewer",
      cwd: "/owned/worktree",
      readOnly: true,
      prompt: "review assignment",
    });
  });

  it("materializes a current schema-v1 snapshot without rewriting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipkin-implement-v1-"));
    try {
      const statePath = join(
        directory,
        ".pi",
        "pipkin",
        "implement",
        "runs",
        "run-1",
        "run-state.json",
      );
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(recoveryState()));
      const before = readFileSync(statePath, "utf-8");
      const packet = buildRecoveryPacket({
        state: RunStateSchema.parse(JSON.parse(before)),
        effect: {
          kind: "run_recovery",
          workstream: { kind: "source", id: "work" },
          leaseId: "lease",
          episodeId: "episode",
          independentlyEscalated: false,
        },
      });

      expect(packet.outstandingFindings).toHaveLength(2);
      expect(readFileSync(statePath, "utf-8")).toBe(before);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("materializes retained findings in current order and rejects stale references", () => {
    const effect = {
      kind: "run_recovery" as const,
      workstream: { kind: "source" as const, id: "work" },
      leaseId: "lease",
      episodeId: "episode",
      independentlyEscalated: false,
    };
    const state = recoveryState();

    expect(
      buildRecoveryPacket({ state, effect }).outstandingFindings.map(
        (finding) => finding.id,
      ),
    ).toEqual(["finding-second", "finding-first"]);

    for (const mutate of [
      (value: RunState) => {
        value.recoveryEpisodes.episode!.outstandingFindingIds = [
          "finding-first",
          "finding-first",
        ];
        value.gates[0]!.outstandingFindingIds = [
          "finding-first",
          "finding-first",
        ];
      },
      (value: RunState) => {
        value.findings["finding-first"]!.status = "resolved";
      },
      (value: RunState) => {
        delete value.findings["finding-first"];
      },
      (value: RunState) => {
        value.recoveryEpisodes.episode!.gateId = "missing-gate";
      },
      (value: RunState) => {
        value.candidates["candidate:stale"] = {
          ...value.candidates["candidate:work:tip"]!,
          id: "candidate:stale",
          commitSha: "stale-tip",
          treeSha: "stale-tree",
        };
        value.recoveryEpisodes.episode!.candidateId = "candidate:stale";
        value.recoveryEpisodes.episode!.outstandingFindingIds = [];
        value.gates[0]!.candidateId = "candidate:stale";
        value.gates[0]!.outstandingFindingIds = [];
        value.findings = {};
        value.reviews = {};
      },
    ]) {
      const invalid = recoveryState();
      mutate(invalid);
      expect(() => buildRecoveryPacket({ state: invalid, effect })).toThrow(
        WorkerPacketError,
      );
    }
  });
});

function recoveryState(): RunState {
  const candidateId = "candidate:work:tip";
  return {
    run: {
      id: "run-1",
      checkout: {
        root: "/checkout",
        gitDir: "/checkout/.git",
        commonGitDir: "/checkout/.git",
        branchRef: "refs/heads/main",
        startHead: "base-sha",
      },
      source: {
        entry: { path: "/checkout/plan.md", normalizedHash: "a".repeat(64) },
        corpus: [{ path: "/checkout/plan.md", hash: "a".repeat(64) }],
        protectedArtifactHashes: {},
      },
      workerConcurrency: 1,
    },
    version: 1,
    revision: 1,
    phase: "running",
    executionPlan: {
      path: "/checkout/.pi/pipkin/implement/runs/run-1/execution-plan.json",
      hash: "a".repeat(64),
    },
    workstreams: {
      source: {
        work: {
          kind: "source",
          id: "work",
          taskIds: ["task"],
          dependsOn: [],
          phase: "recovering",
          baseSha: "base-sha",
          candidateId,
        },
      },
      overall: {},
    },
    tasks: {
      task: { workstreamId: "work", phase: "checkpointed", checkpoint: "tip" },
    },
    processLeases: {},
    candidates: {
      [candidateId]: {
        id: candidateId,
        workstream: { kind: "source", id: "work" },
        baseSha: "base-sha",
        commitSha: "tip",
        treeSha: "tree",
      },
    },
    findings: Object.fromEntries(
      ["finding-first", "finding-second"].map((id) => [
        id,
        {
          id,
          candidateId,
          workstream: { kind: "source" as const, id: "work" },
          summary: `${id} summary`,
          evidence: `${id} evidence`,
          requiredChange: `${id} change`,
          acceptanceCriteria: [`${id} acceptance`],
          origin: "initial" as const,
          introducedRound: 0,
          status: "open" as const,
        },
      ]),
    ),
    reviews: {
      "source:work": {
        candidateId,
        round: 1,
        outstandingIds: ["finding-second", "finding-first"],
        evidence: ["/orchestrator/review.json"],
        observations: [],
      },
    },
    gates: [
      {
        id: "review:work:1",
        kind: "review",
        workstream: { kind: "source", id: "work" },
        candidateId,
        attempt: 1,
        outcome: "failed",
        evidence: "/orchestrator/review.json",
        outstandingFindingIds: ["finding-second", "finding-first"],
      },
    ],
    recoveryEpisodes: {
      episode: {
        id: "episode",
        gateId: "review:work:1",
        gateAttempts: ["review:work:1"],
        workstream: { kind: "source", id: "work" },
        candidateId,
        workspace: {
          id: "source:work",
          checkpoint: "tip",
          changedPaths: [],
          stateEvidence: "Review requested a correction.",
        },
        outstandingFindingIds: ["finding-second", "finding-first"],
        status: "open",
        cycle: {
          signature: "initial",
          identicalNoActionCycles: 0,
          independentlyEscalated: false,
        },
        providerFailures: 0,
        actions: [],
      },
    },
    satisfaction: { receipts: {}, assessments: {} },
    publication: { preparations: {}, intents: {}, receipts: {} },
    protectedArtifactHashes: {},
    projectionDebt: [],
    wholePlanReview: { status: "pending" },
    createdAt: "now",
    updatedAt: "now",
  };
}
