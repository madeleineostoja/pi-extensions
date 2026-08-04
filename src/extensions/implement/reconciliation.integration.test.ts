import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskWorkspaceManager } from "./candidate-worker.js";
import { ScriptedSubagentClient } from "./e2e-test-support.js";
import { compileExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import { ExecGitClient } from "./git.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import { runReconciliation } from "./reconciliation.js";
import { writeSourceCorpus } from "./requirements-context.js";
import { retargetAnchoredReview, runWorkstreamReview } from "./review.js";
import { sha256 } from "./source-integrity.js";
import type { SchedulerEffect } from "./scheduler/scheduler.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import type { RunState } from "./store.js";

const directories = new Set<string>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-implement-reconciliation-"));
  directories.add(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "shared.txt"), "first=base\nsecond=base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: init");
  return root;
}

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.clear();
});

describe("semantic reconciliation admission", () => {
  it("admits a clean same-file semantic overlap with both inputs as ancestors", async () => {
    const fixture = await reconciliationFixture(
      "first=candidate\nsecond=base\n",
      "first=base\nsecond=target\n",
    );
    const outcome = await runReconciliation({
      state: fixture.state,
      effect: fixture.effect,
      git: fixture.git,
      subagents: mergingWorker("first=candidate\nsecond=target\n"),
      artifactsPath: join(fixture.root, "artifacts"),
      roles,
    });

    expect(
      await fixture.workspaceGit.isAncestor(
        fixture.candidate.commitSha,
        outcome.candidate.commitSha,
      ),
    ).toBe(true);
    expect(
      await fixture.workspaceGit.isAncestor(
        fixture.targetSha,
        outcome.candidate.commitSha,
      ),
    ).toBe(true);
    expect(outcome.candidate).toMatchObject({
      integrationBaseSha: fixture.targetSha,
      evidenceStatus: "reported",
      changedPaths: ["shared.txt"],
    });
    expect(outcome.candidate.treeSha).not.toBe(fixture.candidate.treeSha);
    expect(await fixture.workspaceGit.isClean()).toBe(true);
    expect(await fixture.git.head()).toBe(fixture.targetSha);
    expect(git(fixture.root, "show", "HEAD:shared.txt")).toBe(
      "first=base\nsecond=target\n",
    );
  });

  it("reviews a reconciled candidate against the target-relative Git range", async () => {
    const fixture = await reconciliationFixture(
      "first=candidate\nsecond=base\n",
      "first=base\nsecond=target\n",
      { distinctRangePaths: true },
    );
    const reconciliation = await runReconciliation({
      state: fixture.state,
      effect: fixture.effect,
      git: fixture.git,
      subagents: mergingWorker("first=candidate\nsecond=target\n"),
      artifactsPath: join(fixture.root, "artifacts"),
      roles,
    });
    const plan = reviewPlan(fixture.root, fixture.candidate.baseSha);
    const review = retargetAnchoredReview({
      state: {
        candidateId: fixture.candidate.id,
        candidateCommitSha: fixture.candidate.commitSha,
        candidateTreeSha: fixture.candidate.treeSha,
        comparisonBase: fixture.candidate.baseSha,
        round: 0,
        pendingCorrectionIds: [],
        correctionConsumed: false,
        evidence: ["initial review"],
        observations: [],
        publicationCommitSubject: "feat: publish candidate",
      },
      candidate: reconciliation.candidate,
      comparisonBase: fixture.targetSha,
      correctionRange: {
        baseSha: fixture.targetSha,
        headSha: reconciliation.candidate.commitSha,
      },
      correction: reconciliation.correction,
    });
    const state = {
      ...fixture.state,
      executionPlan: {
        path: join(
          fixture.root,
          ".pi",
          "pipkin",
          "implement",
          "runs",
          "run-1",
          "execution-plan.json",
        ),
        hash: plan.executionPlanHash,
      },
      workstreams: {
        source: {
          "first-stream": {
            ...fixture.state.workstreams.source["first-stream"],
            phase: "candidate_ready",
            taskIds: ["preserve-behavior"],
            candidateId: reconciliation.candidate.id,
          },
        },
        overall: {},
      },
      tasks: {},
      candidates: {
        [fixture.candidate.id]: fixture.candidate,
        [reconciliation.candidate.id]: reconciliation.candidate,
      },
      findings: {},
      reviews: { "source:first-stream": review },
      satisfaction: { assessments: {}, receipts: {} },
    } as unknown as RunState;
    const reviewer = new ScriptedSubagentClient(
      [
        {
          status: "completed",
          result: { assessments: [], regressions: [] },
        },
      ],
      [fixture.root],
    );

    const outcome = await runWorkstreamReview({
      state,
      plan,
      workstream: fixture.candidate.workstream,
      git: fixture.git,
      subagents: reviewer,
      artifactsPath: join(fixture.root, "artifacts"),
      roles,
    });

    expect(outcome).toMatchObject({
      kind: "anchored",
      correctionRangeBaseSha: fixture.targetSha,
      correctionRangeHeadSha: reconciliation.candidate.commitSha,
      changedPaths: ["candidate-only.txt", "shared.txt"],
    });
    expect(reviewer.invocations).toHaveLength(1);
    expect(reviewer.invocations[0]?.prompt).toContain(
      `git diff --stat ${fixture.targetSha}..${reconciliation.candidate.commitSha}`,
    );
    expect(reviewer.invocations[0]?.prompt).not.toContain(
      `git diff --stat ${fixture.candidate.commitSha}..${reconciliation.candidate.commitSha}`,
    );
  });

  it("keeps an observed textual-conflict merge when semantic completion is unavailable", async () => {
    const fixture = await reconciliationFixture(
      "first=candidate\nsecond=base\n",
      "first=target\nsecond=base\n",
    );
    const outcome = await runReconciliation({
      state: fixture.state,
      effect: fixture.effect,
      git: fixture.git,
      subagents: mergingWorker(
        "first=target+candidate\nsecond=base\n",
        "failed",
      ),
      artifactsPath: join(fixture.root, "artifacts"),
      roles,
    });

    expect(
      await fixture.workspaceGit.isAncestor(
        fixture.candidate.commitSha,
        outcome.candidate.commitSha,
      ),
    ).toBe(true);
    expect(
      await fixture.workspaceGit.isAncestor(
        fixture.targetSha,
        outcome.candidate.commitSha,
      ),
    ).toBe(true);
    expect(outcome.candidate).toMatchObject({
      integrationBaseSha: fixture.targetSha,
      evidenceStatus: "unavailable",
    });
    expect(outcome.candidate.implementationEvidence).toBeUndefined();
    expect(await fixture.git.head()).toBe(fixture.targetSha);
  });
});

async function reconciliationFixture(
  candidateContent: string,
  targetContent: string,
  options: { distinctRangePaths?: boolean } = {},
) {
  const root = repository();
  const gitClient = new ExecGitClient(root);
  const baseSha = await gitClient.head();
  const workspace = {
    taskId: "first-stream",
    branchName: "pipkin/implement/run-1/first-stream",
    worktreePath: join(
      root,
      ".pi",
      "pipkin",
      "implement",
      "worktrees",
      "run-1",
      "first-stream",
    ),
    baseSha,
  };
  const manager = new TaskWorkspaceManager(
    gitClient,
    join(root, ".pi", "pipkin", "implement", "worktrees", "run-1"),
  );
  await manager.ensure(workspace);
  const workspaceGit = gitClient.forWorktree(workspace.worktreePath);
  writeFileSync(join(workspace.worktreePath, "shared.txt"), candidateContent);
  git(workspace.worktreePath, "add", "shared.txt");
  if (options.distinctRangePaths) {
    writeFileSync(
      join(workspace.worktreePath, "candidate-only.txt"),
      "candidate\n",
    );
    git(workspace.worktreePath, "add", "candidate-only.txt");
  }
  git(workspace.worktreePath, "commit", "-m", "feat: candidate");
  const candidate = {
    id: "candidate:first",
    workstream: { kind: "source" as const, id: "first-stream" },
    baseSha,
    commitSha: await workspaceGit.head(),
    treeSha: await workspaceGit.tree(),
    changedPaths: options.distinctRangePaths
      ? ["candidate-only.txt", "shared.txt"]
      : ["shared.txt"],
    implementationEvidence: {
      summary: "candidate",
      verification: ["candidate checked"],
    },
  };
  writeFileSync(join(root, "shared.txt"), targetContent);
  git(root, "add", "shared.txt");
  if (options.distinctRangePaths) {
    writeFileSync(join(root, "target-only.txt"), "target\n");
    git(root, "add", "target-only.txt");
  }
  git(root, "commit", "-m", "feat: target");
  const targetSha = await gitClient.head();
  const targetTreeSha = await gitClient.tree();
  const branch = await gitClient.currentBranch();
  const state = {
    run: {
      id: "run-1",
      checkout: { root, branchRef: `refs/heads/${branch}` },
    },
    protectedArtifactHashes: {},
    workstreams: {
      source: {
        "first-stream": {
          kind: "source",
          id: "first-stream",
          baseSha,
          candidateId: candidate.id,
          phase: "reconciling",
        },
      },
      overall: {},
    },
    candidates: { [candidate.id]: candidate },
    processLeases: {
      "reconciliation:run-1:1": {
        id: "reconciliation:run-1:1",
        workstream: candidate.workstream,
        kind: "reconciliation",
        candidateId: candidate.id,
        reconciliationAssignmentId: "reconcile:first",
        attempt: 1,
        acquiredAt: "2026-01-01T00:00:00.000Z",
      },
    },
    reviews: {
      "source:first-stream": {
        candidateId: candidate.id,
        comparisonBase: baseSha,
        round: 0,
        pendingCorrectionIds: [],
        evidence: ["initial review"],
        observations: [],
        publicationCommitSubject: "feat: publish candidate",
      },
    },
    reconciliationAssignments: {
      "reconcile:first": {
        id: "reconcile:first",
        workstream: candidate.workstream,
        candidateId: candidate.id,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        targetSha,
        targetTreeSha,
        disposition: "overlap",
        paths: {
          candidate: options.distinctRangePaths
            ? ["candidate-only.txt", "shared.txt"]
            : ["shared.txt"],
          target: options.distinctRangePaths
            ? ["shared.txt", "target-only.txt"]
            : ["shared.txt"],
          replay: ["shared.txt"],
        },
        operationId: "reconciliation:run-1:1",
        staging: {
          id: "staging-failed",
          operationId: "reconciliation:run-1:1",
          branchName: "pipkin/implement/run-1/staging-failed",
          targetRef: `refs/heads/${branch}`,
        },
        evidence: "same-file overlap",
        status: "pending",
        executionFailures: 0,
      },
    },
  } as unknown as RunState;
  const effect = {
    kind: "run_reconciliation_worker",
    workstream: candidate.workstream,
    leaseId: "reconciliation:run-1:1",
    candidateId: candidate.id,
    assignmentId: "reconcile:first",
  } satisfies Extract<SchedulerEffect, { kind: "run_reconciliation_worker" }>;
  return {
    root,
    git: gitClient,
    workspaceGit,
    candidate,
    targetSha,
    state,
    effect,
  };
}

function reviewPlan(root: string, baseSha: string): ExecutionPlan {
  const planPath = join(root, "review-plan.md");
  const content = "# Plan\n\n- [ ] Preserve behavior\n";
  writeFileSync(planPath, content);
  const parsed = parsePlan(planPath, content);
  const materialStore = buildMaterialStore({
    plan: parsed,
    planPath,
    repoRoot: root,
  });
  const compiled = compileExecutionPlan(
    {
      version: 1,
      tasks: [
        {
          id: "preserve-behavior",
          planIndex: 1,
          title: "Preserve behavior",
          dependsOn: [],
          supportingDocuments: [],
          compiledContract: {
            objective: "Preserve candidate and integrated target behavior.",
            inScope: ["Reconciled contribution"],
            acceptanceCriteria: ["Both behaviors remain present."],
            outOfScope: ["Unrelated changes"],
          },
        },
      ],
      workstreams: [
        {
          id: "first-stream",
          taskIds: ["preserve-behavior"],
        },
      ],
    },
    {
      plan: parsed,
      planHash: sha256(content),
      materialStore,
      checkoutId: join(root, ".git"),
      baseSha,
      workerConcurrency: 1,
    },
  );
  if (!compiled.ok) {
    throw new Error(compiled.reason);
  }
  writeSourceCorpus(
    join(root, ".pi", "pipkin", "implement", "runs", "run-1"),
    materialStore,
    compiled.value,
  );
  return compiled.value;
}

function mergingWorker(
  content: string,
  status: "completed" | "failed" = "completed",
): SubagentClient {
  let cwd = "";
  return {
    async spawn(args) {
      cwd = args.cwd!;
      const target = /Failed replay target: ([a-f0-9]+)/.exec(args.prompt)?.[1];
      if (!target) {
        throw new Error("reconciliation prompt has no retained target");
      }
      try {
        execFileSync("git", ["merge", "--no-ff", "--no-edit", target], {
          cwd,
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch {
        // The conflict remains active for the worker's explicit resolution below.
      }
      writeFileSync(join(cwd, "shared.txt"), content);
      git(cwd, "add", "shared.txt");
      if (git(cwd, "status", "--porcelain").trim()) {
        git(cwd, "commit", "-m", "feat: reconcile");
      }
      return "worker" as never;
    },
    async stop() {},
    async waitFor() {
      return status === "completed"
        ? {
            status: "completed" as const,
            result: {
              summary: "merged target behavior",
              verification: ["checked shared behavior"],
            },
          }
        : {
            status: "failed" as const,
            error: `completion ${status} in ${cwd}`,
          };
    },
  } as SubagentClient;
}

const roles: ImplementRoles = {
  implementer: {
    type: "pipkin:implement:implementer",
    model: "test",
    thinking: "medium",
  },
  reviewer: {
    type: "pipkin:implement:reviewer",
    model: "test",
    thinking: "high",
  },
  planner: {
    type: "pipkin:implement:planner",
    model: "test",
    thinking: "high",
  },
};
