import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileExecutionPlan } from "./execution-plan.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import { writeSourceCorpus } from "./requirements-context.js";
import { sha256 } from "./source-integrity.js";
import { ExecGitClient } from "./git.js";
import { runOverallRepair } from "./overall-repair.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import type { RunState } from "./store.js";
import { WorkstreamCandidateLifecycleError } from "./workstream-candidate.js";

const directories = new Set<string>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-overall-repair-"));
  directories.add(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "app.txt"), "base\n");
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

describe("overall repair candidate admission", () => {
  it("admits a committed repair when semantic completion fails", async () => {
    const fixture = await overallFixture();
    const outcome = await runOverallRepair({
      ...fixture.args,
      subagents: repairWorker("committed"),
    });

    expect(outcome.candidate).toMatchObject({
      evidenceStatus: "unavailable",
      changedPaths: ["app.txt"],
    });
    expect(outcome.candidate.implementationEvidence).toBeUndefined();
    expect(await fixture.git.head()).toBe(fixture.baseSha);
  });

  it("retains dirty repair state as workspace-unsafe observation", async () => {
    const fixture = await overallFixture();
    let failure: unknown;
    try {
      await runOverallRepair({
        ...fixture.args,
        subagents: repairWorker("dirty"),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorkstreamCandidateLifecycleError);
    expect(failure).toMatchObject({
      category: "workspace_unsafe",
      observation: { clean: false },
    });
    expect(await fixture.git.head()).toBe(fixture.baseSha);
  });
});

async function overallFixture() {
  const root = repository();
  const gitClient = new ExecGitClient(root);
  const baseSha = await gitClient.head();
  const treeSha = await gitClient.tree();
  const repairId = "overall-repair-1";
  const baseline = {
    id: `overall-baseline:${baseSha}`,
    workstream: { kind: "overall" as const, repairId },
    baseSha,
    commitSha: baseSha,
    treeSha,
  };
  const planPath = join(root, "plan.md");
  const planContent = "# Plan\n\n- [ ] Repair app behavior\n";
  writeFileSync(planPath, planContent);
  const parsed = parsePlan(planPath, planContent);
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
          id: "repair-app",
          planIndex: 1,
          title: "Repair app behavior",
          dependsOn: [],
          supportingDocuments: [],
          compiledContract: {
            objective: "Repair app behavior.",
            inScope: ["app.txt"],
            acceptanceCriteria: ["app.txt is repaired"],
            outOfScope: ["Unrelated work"],
          },
        },
      ],
      workstreams: [{ id: "repair-app", taskIds: ["repair-app"] }],
    },
    {
      plan: parsed,
      planHash: sha256(planContent),
      materialStore,
      checkoutId: join(root, ".git"),
      baseSha,
      workerConcurrency: 1,
    },
  );
  if (!compiled.ok) {
    throw new Error(compiled.reason);
  }
  const runDir = join(root, ".pi", "pipkin", "implement", "runs", "run-1");
  writeSourceCorpus(runDir, materialStore, compiled.value);
  const state = {
    executionPlan: {
      path: join(runDir, "execution-plan.json"),
      hash: compiled.value.executionPlanHash,
    },
    run: {
      id: "run-1",
      checkout: { root, startHead: baseSha },
    },
    protectedArtifactHashes: {},
    workstreams: {
      source: {},
      overall: {
        [repairId]: {
          kind: "overall",
          repairId,
          phase: "implementing",
          candidateId: baseline.id,
        },
      },
    },
    candidates: { [baseline.id]: baseline },
    findings: {
      "overall-finding-1": {
        id: "overall-finding-1",
        candidateId: baseline.id,
        workstream: baseline.workstream,
        scope: {
          kind: "whole_plan",
          initialTargetSha: baseSha,
          initialTargetTreeSha: treeSha,
        },
        origin: "initial",
        introducedRound: 0,
        status: "open",
        summary: "Repair app behavior",
        evidence: "app.txt still contains the baseline behavior",
        requiredChange: "Update app.txt",
        acceptanceCriteria: ["app.txt contains the repaired behavior"],
      },
    },
    reviews: {
      [`overall:${repairId}`]: {
        candidateId: baseline.id,
        comparisonBase: baseSha,
        round: 0,
        pendingCorrectionIds: ["overall-finding-1"],
        evidence: ["whole-plan review"],
        observations: [],
      },
    },
  } as unknown as RunState;
  return {
    git: gitClient,
    baseSha,
    args: {
      state,
      plan: compiled.value,
      repairId,
      git: gitClient,
      artifactsPath: join(root, "artifacts"),
      operationId: "implementation:run-1:1:0",
      roles,
    },
  };
}

function repairWorker(mode: "committed" | "dirty"): SubagentClient {
  let cwd = "";
  return {
    async spawn(args) {
      cwd = args.cwd!;
      return "worker" as never;
    },
    async stop() {},
    async waitFor() {
      writeFileSync(join(cwd, "app.txt"), "repaired\n");
      if (mode === "committed") {
        git(cwd, "add", "app.txt");
        git(cwd, "commit", "-m", "fix: repair app");
      }
      return { status: "failed" as const, error: "completion unavailable" };
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
