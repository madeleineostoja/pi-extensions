import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  mutableWorkerExcludedTools,
  readOnlyWorkerTools,
  type ImplementRoles,
} from "./subagents.js";
import {
  completionContracts,
  REPOSITORY_PRESERVING_ROLE_CONTRACT,
  spawnValidatedWorker,
} from "./worker-invocation.js";
import { MANAGED_COMPLETION_FINAL_ACTION } from "#subagents/completion";
import { buildStrictExecutionPlannerPrompt } from "./execution-plan.js";
import {
  buildAnchoredOverallReviewPrompt,
  buildAnchoredWorkstreamReviewPrompt,
  buildInitialOverallReviewPrompt,
  buildInitialWorkstreamReviewPrompt,
  buildOverallReworkPrompt,
  buildReconciliationPrompt,
  buildRevisionPrompt,
  buildWorkstreamImplementerPrompt,
} from "./prompts.js";

describe("managed Pipkin Implement worker tools", () => {
  it("excludes orchestration inspection and public agent controls from mutable workers", () => {
    expect(mutableWorkerExcludedTools()).toEqual([
      "inspect_implement_run",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
    ]);
  });

  it("keeps managed runtime ownership in the Implement adapter", () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const owners = readdirSync(directory, {
      recursive: true,
      encoding: "utf8",
    })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => {
        const source = readFileSync(join(directory, name), "utf-8");
        return (
          source.includes("runManagedAgent") ||
          source.includes("#subagents/runtime")
        );
      });

    expect(owners).toEqual(["subagents.ts"]);
  });

  it("keeps Bash verification while excluding public agent controls", () => {
    const selection = readOnlyWorkerTools([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "bash_outcome",
      "context_recall",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "record_papercut",
      "edit",
    ]);

    expect(selection.tools).toEqual([
      "read",
      "bash",
      "start_process",
      "get_process_result",
      "stop_process",
      "bash_outcome",
      "context_recall",
      "record_papercut",
    ]);
    expect(selection.excludeTools).toEqual(
      expect.arrayContaining([
        "Agent",
        "get_subagent_result",
        "steer_subagent",
        "edit",
        "write",
      ]),
    );
  });

  it("maps every completion owner to the established read-only or mutable admission", async () => {
    const spawn = vi.fn(async () => "worker");
    const roles: ImplementRoles = {
      planner: {
        type: "pipkin:implement:planner",
        model: "test/planner",
        thinking: "high",
      },
      reviewer: {
        type: "pipkin:implement:reviewer",
        model: "test/reviewer",
        thinking: "high",
      },
      implementer: {
        type: "pipkin:implement:implementer",
        model: "test/implementer",
        thinking: "medium",
      },
    };
    const completionKinds = Object.entries(completionContracts) as Array<
      [
        keyof typeof completionContracts,
        (typeof completionContracts)[keyof typeof completionContracts],
      ]
    >;

    for (const [completionKind, completion] of completionKinds) {
      const { role, readOnly } = completion;
      await spawnValidatedWorker({
        packet: {
          completionKind,
          identity: completionKind,
          workspace: { path: "/worktree" },
        },
        subagents: { spawn } as never,
        roles,
        taskId: "task",
        description: completionKind,
        render: () => "Complete the assignment.",
      });
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: `pipkin:implement:${role}`,
          role,
          ...(readOnly ? { readOnly: true } : {}),
          completion: {
            description: completion.description,
            schema: completion.schema,
          },
          prompt: expect.stringContaining(MANAGED_COMPLETION_FINAL_ACTION),
        }),
      );
    }
    expect(spawn).toHaveBeenCalledTimes(completionKinds.length);
    for (const [index, call] of (
      spawn.mock.calls as unknown as Array<[{ prompt: string }]>
    ).entries()) {
      const [{ prompt }] = call;
      expect(
        prompt.match(/pi_managed_complete exactly once as your final action/g),
      ).toHaveLength(1);
      expect(prompt).toContain(
        "required structured result for this completion kind",
      );
      expect(prompt).toContain("sole allowed personal-metadata write");
      if (completionKinds[index]?.[1].readOnly) {
        expect(prompt).toContain(REPOSITORY_PRESERVING_ROLE_CONTRACT);
      } else {
        expect(prompt).not.toContain(REPOSITORY_PRESERVING_ROLE_CONTRACT);
      }
    }
  });

  it("assembles production role prompts with one shared completion protocol", async () => {
    const spawn = vi.fn(async () => "worker");
    const roles: ImplementRoles = {
      planner: {
        type: "pipkin:implement:planner",
        model: "test/planner",
        thinking: "high",
      },
      reviewer: {
        type: "pipkin:implement:reviewer",
        model: "test/reviewer",
        thinking: "high",
      },
      implementer: {
        type: "pipkin:implement:implementer",
        model: "test/implementer",
        thinking: "medium",
      },
    };
    const workspace = { path: "/worktree", mutationBoundary: "boundary" };
    const candidate = {
      id: "candidate",
      workstream: { kind: "source", id: "work" },
      baseSha: "base",
      commitSha: "head",
      treeSha: "tree",
    };
    const cases = [
      {
        kind: "planner",
        packet: {
          role: "planner",
          completionKind: "planner",
          identity: "planner",
          workspace,
        },
        render: () =>
          buildStrictExecutionPlannerPrompt({
            workspace,
            planContent: "plan",
            unchecked: [],
            corpus: [],
            baseSha: "base",
            workerConcurrency: 1,
          } as never),
        sentinel: "Create exactly one task contract",
      },
      {
        kind: "implementer",
        packet: {
          role: "implementer",
          completionKind: "implementer",
          identity: "implementer",
          workspace,
        },
        render: () =>
          buildWorkstreamImplementerPrompt({
            workspace,
            tasks: [],
            sourceMaterial: [],
            priorCheckpoints: {},
            baseSha: "base",
          } as never),
        sentinel: "Implement every ordered task contract",
      },
      {
        kind: "initial-review",
        packet: {
          role: "reviewer",
          completionKind: "initial-review",
          identity: "initial-review",
          workspace,
        },
        render: () =>
          buildInitialWorkstreamReviewPrompt({
            workspace,
            candidate,
            contracts: [],
            sourceMaterial: [],
            corpus: [],
            schedule: { tasks: [], workstreams: [] },
            checkpoints: {},
            satisfiedEvidence: {},
            outstandingFindings: [],
            completionKind: "initial-review",
          } as never),
        sentinel: "Review in two passes",
      },
      {
        kind: "initial-anchored-review",
        packet: {
          role: "reviewer",
          completionKind: "initial-anchored-review",
          identity: "initial-anchored-review",
          workspace,
        },
        render: () =>
          buildAnchoredWorkstreamReviewPrompt({
            workspace,
            candidate,
            previousCandidate: candidate,
            comparisonBase: "base",
            latestCorrection: {
              rangeBaseSha: "base",
              rangeHeadSha: "head",
              changedPaths: [],
              evidence: "evidence",
              mode: "changed",
            },
            contracts: [],
            sourceMaterial: [],
            corpus: [],
            schedule: { tasks: [], workstreams: [] },
            checkpoints: {},
            satisfiedEvidence: {},
            outstandingFindings: [],
          } as never),
        sentinel: "Assess every outstanding ID exactly once",
      },
      {
        kind: "anchored-review",
        packet: {
          role: "reviewer",
          completionKind: "anchored-review",
          identity: "anchored-review",
          workspace,
        },
        render: () =>
          buildAnchoredWorkstreamReviewPrompt({
            workspace,
            candidate,
            previousCandidate: candidate,
            comparisonBase: "base",
            latestCorrection: {
              rangeBaseSha: "base",
              rangeHeadSha: "head",
              changedPaths: [],
              evidence: "evidence",
              mode: "changed",
            },
            contracts: [],
            sourceMaterial: [],
            corpus: [],
            schedule: { tasks: [], workstreams: [] },
            checkpoints: {},
            satisfiedEvidence: {},
            outstandingFindings: [],
          } as never),
        sentinel: "Assess every outstanding ID exactly once",
      },
      {
        kind: "initial-overall-review",
        packet: {
          role: "reviewer",
          completionKind: "initial-overall-review",
          identity: "initial-overall-review",
          workspace,
        },
        render: (packet: { workspace: { path: string } }) =>
          buildInitialOverallReviewPrompt({
            planContext: "plan",
            candidateContext: "candidate",
            baseSha: "base",
            currentSha: "head",
            worktreePath: packet.workspace.path,
          }),
        sentinel: "Finalize the complete findings array",
      },
      {
        kind: "initial-anchored-overall-review",
        packet: {
          role: "reviewer",
          completionKind: "initial-anchored-overall-review",
          identity: "initial-anchored-overall-review",
          workspace,
        },
        render: (packet: { workspace: { path: string } }) =>
          buildAnchoredOverallReviewPrompt({
            planContext: "plan",
            candidateContext: "candidate",
            baseSha: "base",
            outstandingFindings: [],
            previousCandidate: "previous",
            currentCandidate: "head",
            latestHandoffDraft: "handoff",
            worktreePath: packet.workspace.path,
          }),
        sentinel: "Preserve unaffected facts",
      },
      {
        kind: "anchored-overall-review",
        packet: {
          role: "reviewer",
          completionKind: "anchored-overall-review",
          identity: "anchored-overall-review",
          workspace,
        },
        render: (packet: { workspace: { path: string } }) =>
          buildAnchoredOverallReviewPrompt({
            planContext: "plan",
            candidateContext: "candidate",
            baseSha: "base",
            outstandingFindings: [],
            previousCandidate: "previous",
            currentCandidate: "head",
            latestHandoffDraft: "handoff",
            worktreePath: packet.workspace.path,
          }),
        sentinel: "Preserve unaffected facts",
      },
      {
        kind: "overall-rework",
        packet: {
          role: "implementer",
          completionKind: "overall-rework",
          identity: "overall-rework",
          workspace,
        },
        render: () =>
          buildOverallReworkPrompt({
            workspace,
            runId: "run",
            runBaseSha: "base",
            baseline: candidate,
            requirements: {
              contracts: [],
              corpus: [],
              schedule: { tasks: [], workstreams: [] },
            },
            findings: [],
          } as never),
        sentinel: "Address only the supplied whole-plan review findings",
      },
      {
        kind: "reconciliation",
        packet: {
          role: "implementer",
          completionKind: "reconciliation",
          identity: "reconciliation",
          workspace,
        },
        render: () =>
          buildReconciliationPrompt({
            workspace,
            candidate,
            failedTarget: { commitSha: "target", treeSha: "tree" },
            priorIntegrationBase: "base",
            replay: {
              disposition: "overlap",
              candidatePaths: [],
              targetPaths: [],
              relevantPaths: [],
              evidence: "evidence",
            },
            priorEvidence: [],
            semanticAttempt: "initial",
          } as never),
        sentinel: "semantic reconciliation worker",
      },
      {
        kind: "revision",
        packet: {
          role: "implementer",
          completionKind: "revision",
          identity: "revision",
          workspace,
        },
        render: () =>
          buildRevisionPrompt({
            workspace,
            candidate,
            comparisonBase: "base",
            findingEpoch: 1,
            pendingCorrectionIds: [],
            authority: { kind: "review_findings" },
            findings: [],
            evidence: [],
            requirements: {
              contracts: [],
              corpus: [],
              schedule: { tasks: [], workstreams: [] },
            },
          } as never),
        sentinel: "revision worker",
      },
    ] as const;

    for (const testCase of cases) {
      await spawnValidatedWorker({
        packet: testCase.packet as never,
        subagents: { spawn } as never,
        roles,
        taskId: testCase.kind,
        description: testCase.kind,
        render: testCase.render as never,
      });
      const [{ prompt, completion, readOnly }] = (
        spawn.mock.calls as unknown as Array<
          [
            {
              prompt: string;
              completion: unknown;
              readOnly?: boolean;
            },
          ]
        >
      ).at(-1)!;
      expect(prompt).toContain(testCase.sentinel);
      expect(
        prompt.match(new RegExp(MANAGED_COMPLETION_FINAL_ACTION, "g")),
      ).toHaveLength(1);
      expect(completion).toEqual({
        description: completionContracts[testCase.kind].description,
        schema: completionContracts[testCase.kind].schema,
      });
      expect(Boolean(readOnly)).toBe(
        completionContracts[testCase.kind].readOnly,
      );
      expect(prompt.includes(REPOSITORY_PRESERVING_ROLE_CONTRACT)).toBe(
        completionContracts[testCase.kind].readOnly,
      );
    }
  });

  it("does not retain Context Bash companions after active-tool filtering", () => {
    expect(
      readOnlyWorkerTools(["read", "bash_outcome", "context_recall"]).tools,
    ).toEqual(["read"]);
    expect(readOnlyWorkerTools(["read", "bash", "bash_outcome"]).tools).toEqual(
      ["read", "bash"],
    );
    expect(
      readOnlyWorkerTools(["read", "get_process_result", "stop_process"]).tools,
    ).toEqual(["read", "get_process_result", "stop_process"]);
    expect(
      readOnlyWorkerTools(["read", "bash", "start_process", "context_recall"])
        .tools,
    ).toEqual(["read", "bash", "start_process", "context_recall"]);
    expect(
      readOnlyWorkerTools(["read", "bash", "context_recall"]).tools,
    ).toEqual(["read", "bash", "context_recall"]);
  });
});
