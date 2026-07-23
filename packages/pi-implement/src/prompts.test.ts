import { describe, expect, it } from "vitest";
import {
  buildReviewResponsibilityContext,
  type ExecutionManifest,
} from "./execution-plan.js";
import {
  buildImplementerPrompt,
  buildIntegrationReviewerPrompt,
  buildIntegrationSelfHealPrompt,
  buildOverallReworkPrompt,
  buildInitialTaskReviewPrompt,
  buildAnchoredTaskReviewPrompt,
  buildInitialOverallReviewPrompt,
  buildAnchoredOverallReviewPrompt,
  buildOverallReviewerPrompt,
  buildSchedulerSelfHealPrompt,
  buildTaskFindingAdmissionPrompt,
  FINDING_ADMISSION_SYSTEM_PROMPT,
  PAPERCUT_GUIDANCE,
} from "./prompts.js";

const WORKTREE_PATH = "/repo/.pi/implement/worktrees/r1/t001-my-task";

const RESPONSIBILITY_CONTEXT = buildReviewResponsibilityContext({
  version: 1,
  tasks: [
    {
      id: "T004",
      planIndex: 1,
      title: "Selected task",
      taskHash: "selected",
      status: "todo",
      dependsOn: ["T003"],
      affectedAreas: [],
      conflictHints: [],
      sourceReferences: [],
      compiledContract: {
        objective: "Do the thing.",
        inScope: ["Implement selected behavior."],
        acceptanceCriteria: ["Criterion 1"],
        outOfScope: ["Sibling task"],
      },
    },
    {
      id: "T003",
      planIndex: 2,
      title: "Dependency task",
      taskHash: "dependency",
      status: "todo",
      dependsOn: [],
      affectedAreas: [],
      conflictHints: [],
      sourceReferences: [],
      compiledContract: {
        objective: "Prepare dependency.",
        inScope: ["Own the shared interface."],
        acceptanceCriteria: ["Dependency is ready"],
        outOfScope: ["Selected task"],
      },
    },
  ],
});

const COMPILED_CONTRACT = `# Task Contract

## Objective

Do the thing.

## In-Scope Items

- Item 1

## Acceptance Criteria

- Criterion 1

## Out-of-Scope Items

- Sibling item
`;

describe("papercut prompt guidance", () => {
  it("is included for every eligible role and omitted from planner/material selection prompts", () => {
    expect(
      buildImplementerPrompt({
        compiledContract: COMPILED_CONTRACT,
        worktreePath: WORKTREE_PATH,
      }),
    ).toContain(PAPERCUT_GUIDANCE);
    expect(
      buildIntegrationReviewerPrompt({
        diff: "diff --git a/file.ts b/file.ts",
        planArtifacts: ["plan.md"],
      }),
    ).toContain(PAPERCUT_GUIDANCE);
    expect(
      buildIntegrationSelfHealPrompt({
        taskId: "task-1",
        title: "Task",
        planIndex: 0,
        taskCommitSha: "abc",
        preIntegrationHead: "def",
        mainCheckoutPath: "/repo",
      }),
    ).toContain(PAPERCUT_GUIDANCE);
    expect(
      buildSchedulerSelfHealPrompt({
        runId: "run-1",
        baseSha: "abc",
        currentHead: "def",
        planPath: "/repo/plan.md",
        graphSummary: "graph",
        eventsTail: "",
        gitStatus: "",
        matchingBranches: [],
        worktrees: [],
      }),
    ).toContain(PAPERCUT_GUIDANCE);
    expect(
      buildOverallReviewerPrompt({
        planContent: "# Plan",
        planPath: "/repo/plan.md",
        baseSha: "abc",
        headSha: "def",
        diff: "diff",
      }),
    ).toContain(PAPERCUT_GUIDANCE);
    expect(
      buildOverallReworkPrompt({
        planContent: "# Plan",
        planPath: "/repo/plan.md",
        baseSha: "abc",
        headSha: "def",
        diff: "diff",
        findings: [],
      }),
    ).toContain(PAPERCUT_GUIDANCE);
    expect(PAPERCUT_GUIDANCE).toContain(
      "expected intermediate, transient, ordinary self-corrected, and correctly guided failures",
    );
    expect(PAPERCUT_GUIDANCE).toContain("`suggestedDestination`");
    expect(PAPERCUT_GUIDANCE).toContain("`proposedResolution`");
    expect(PAPERCUT_GUIDANCE).toContain(
      "Malformed candidates are discarded without failing your result",
    );
  });
});

describe("buildImplementerPrompt", () => {
  it("carries the compiled contract and assigned worktree contract", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(COMPILED_CONTRACT.trim());
    expect(prompt).toContain(WORKTREE_PATH);
    expect(prompt).toContain(
      "Read and write only inside the assigned worktree",
    );
    expect(prompt).toContain(
      "Do not edit source plan files or checklist state",
    );
  });

  it("states the required implementation scope is controlled by the compiled contract", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(
      "Only the items listed in the compiled task contract",
    );
    expect(prompt).toContain(
      "Do not implement sibling tasks or unrelated cleanup, even when broader context mentions them",
    );
  });

  it("describes the complete task packet as contract plus referenced material", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).not.toContain(
      'read the full plan file at the "Source Plan" path yourself',
    );
    expect(prompt).not.toContain("read the full plan file");
    expect(prompt).toContain(
      "The compiled task contract plus referenced source material below is the complete task packet for this task",
    );
    expect(prompt).toContain(
      "Referenced source material supplies exact details, constraints, examples, schemas, prompts, fixtures, or design context",
    );
  });

  it("does not suggest reading the source plan file for background context", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).not.toContain("you may read the source plan file");
    expect(prompt).not.toContain("source plan file is not an extension of it");
  });

  it("tells the implementer to stop and narrow when implementing an unselected sibling task", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(
      "If you notice you are implementing an unselected sibling task, stop and narrow the change",
    );
    expect(prompt).toContain("do only the minimal prerequisite");
    expect(prompt).toContain(
      "Do not complete the sibling task's own deliverable",
    );
  });

  it("renders a referenced source material section without plan-material wording", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
      sourceMaterial: "### auth.md\n\nRaw auth requirement.",
    });

    expect(prompt).toContain("## Referenced Source Material");
    expect(prompt).toContain("### auth.md");
    expect(prompt).toContain("Raw auth requirement.");
    expect(prompt).not.toContain("## Referenced Plan Material");
    expect(prompt).not.toContain("## Out-of-Scope Sibling Tasks");
    expect(prompt).not.toContain("Sibling task A");
  });

  it("directs the implementer to submit a typed completion", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(
      "Submit the result through the injected completion tool as your final action.",
    );
    expect(prompt).not.toContain("<pi-implement-result>");
  });

  it("reserves finding completions for supplied rework findings", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain(
      "Return findingCompletions only when this prompt supplies a Rework Completion Protocol",
    );
    expect(prompt).toContain(
      "Task acceptance-criteria IDs are not review finding IDs",
    );
    expect(prompt).not.toContain("## Rework Completion Protocol");
  });

  it("includes selected task source material without dropping the compiled contract", () => {
    const sourceMaterial = `### Selected Task Source Anchor

Source: /tmp/plan.md (lines 5-7; origin: task-anchor)
Reason: Selected task checkbox line and task block.

~~~text
- [ ] Selected task
  Keep this detail verbatim.
  - Keep this nested item.
~~~
`;

    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
      sourceMaterial,
    });

    expect(prompt).toContain(sourceMaterial.trim());
    expect(prompt).toContain("- [ ] Selected task");
    expect(prompt).toContain("  Keep this detail verbatim.");
    expect(prompt).toContain(COMPILED_CONTRACT.trim());
  });

  it("renders stable requirements and compact sibling responsibility context", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
      responsibilityContext: RESPONSIBILITY_CONTEXT,
      selectedTaskId: "T004",
    });

    expect(prompt).toContain("T004-AC01 (acceptance): Criterion 1");
    expect(prompt).toContain("T004-S01 (scope): Implement selected behavior.");
    expect(prompt).toContain("T003: Dependency task");
    expect(prompt).toContain("Acceptance IDs: T003-AC01");
    expect(prompt).not.toContain("Dependency is ready");
    expect(prompt).toContain(
      "not permission to implement sibling deliverables",
    );
  });

  it("labels fallback-generated requirements in overall responsibility context", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan",
      planPath: "/repo/plan.md",
      baseSha: "abc",
      headSha: "def",
      diff: "diff",
      executionManifest: {
        version: 1,
        fallbackGenerated: true,
        tasks: [
          {
            id: "T001",
            planIndex: 1,
            title: "Fallback task",
            taskHash: "task",
            status: "todo",
            dependsOn: [],
            affectedAreas: [],
            conflictHints: [],
            sourceReferences: [],
            compiledContract: {
              objective: "Fallback objective",
              inScope: ["Fallback scope"],
              acceptanceCriteria: ["Task is complete and verified"],
              outOfScope: ["Other tasks"],
            },
          },
        ],
      },
    });

    expect(prompt).toContain(
      "T001-AC01 (acceptance): Task is complete and verified (fallback-generated)",
    );
  });

  it("includes retry context when reviewer feedback is supplied", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
      feedback: "fix the bug",
      priorSummary: "tried but failed",
    });

    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("tried but failed");
  });

  it("instructs the implementer to use injected explore without expanding scope", () => {
    const prompt = buildImplementerPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
    });

    expect(prompt).toContain("injected `explore` tool");
    expect(prompt).toContain("broad map-building or targeted context checks");
    expect(prompt).toContain(
      "do not expand scope based on exploration results",
    );
    expect(prompt).not.toContain("## Scout Context");
  });
});

describe("typed review protocol prompts", () => {
  it("grounds task proposals and isolates no-tools admission", () => {
    const review = buildInitialTaskReviewPrompt({
      compiledContract: "contract",
      worktreePath: WORKTREE_PATH,
      candidateContext: "candidate",
      responsibilityContext: RESPONSIBILITY_CONTEXT,
      selectedTaskId: "T004",
    });
    const admission = buildTaskFindingAdmissionPrompt({
      compiledContract: "contract",
      responsibilityContext: RESPONSIBILITY_CONTEXT,
      selectedTaskId: "T004",
      candidateIdentity: "candidate",
      latestDeltaPaths: ["src/file.ts"],
      proposalBatchId: "batch",
      proposals: [
        {
          proposalId: "P1",
          summary: "summary",
          evidence: "evidence",
          requiredChange: "change",
          acceptanceCriteria: ["criterion"],
          basis: { kind: "requirement", requirementIds: ["T004-AC01"] },
        },
      ],
    });
    expect(review).toContain("candidate_regression");
    expect(admission).toContain("proposalBatchId: batch");
    expect(FINDING_ADMISSION_SYSTEM_PROMPT).toContain(
      "Do not inspect the repository",
    );
  });
  const outstandingFinding = {
    id: "R1",
    summary: "Missing validation",
    evidence: "src/api.ts accepts invalid input",
    requiredChange: "Validate the input",
    acceptanceCriteria: ["Invalid input is rejected"],
    introducedRound: 0,
    origin: "initial" as const,
  };

  it("builds a complete initial task prompt without a finding cap", () => {
    const prompt = buildInitialTaskReviewPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
      candidateContext: "diff --git a/src/api.ts",
    });
    expect(prompt).toContain("full known blocking set");
    expect(prompt).toContain("not a general audit");
    expect(prompt).toContain("specific unresolved cross-file question");
    expect(prompt).toContain("minimum observable correction");
    expect(prompt).toContain("acceptanceCriteria");
    expect(prompt).toContain("Omit optional or non-blocking concerns");
    expect(prompt).not.toContain("observations");
    expect(prompt).not.toContain("at most five");
  });

  it("builds an anchored task prompt with IDs and regression-only additions", () => {
    const prompt = buildAnchoredTaskReviewPrompt({
      compiledContract: COMPILED_CONTRACT,
      worktreePath: WORKTREE_PATH,
      candidateContext: "candidate details",
      outstandingFindings: [outstandingFinding],
      previousCandidate: "abc",
      currentCandidate: "def",
      latestDelta: "src/api.ts",
    });
    expect(prompt).toContain("R1: Missing validation");
    expect(prompt).toContain("exactly once");
    expect(prompt).toContain(
      "regressions only when the latest delta caused them",
    );
    expect(prompt).toContain("observations never block");
    expect(prompt).toContain("Do not re-review the complete candidate");
    expect(prompt).toContain("current-candidate evidence");
    expect(prompt).toContain("equivalent correct implementation resolves");
  });

  it("keeps typed overall rework findings and the isolated candidate worktree in the prompt", () => {
    const prompt = buildOverallReworkPrompt({
      planContent: "# Plan",
      planPath: "/repo/plan.md",
      baseSha: "base",
      headSha: "candidate",
      diff: "diff --git a/a b/a",
      worktreePath: "/repo/.pi/implement/worktrees/r1/overall-review",
      findings: [
        {
          id: "O1",
          summary: "Missing coverage",
          evidence: "No integration test exists.",
          requiredChange: "Add coverage.",
          acceptanceCriteria: ["Coverage exists."],
          introducedRound: 0,
          origin: "initial",
        },
      ],
    });
    expect(prompt).toContain("O1: Missing coverage");
    expect(prompt).toContain("/repo/.pi/implement/worktrees/r1/overall-review");
    expect(prompt).not.toContain("the main checkout");
  });

  it("builds separately testable initial and anchored overall prompts", () => {
    expect(
      buildInitialOverallReviewPrompt({
        planContext: "# Plan",
        candidateContext: "combined diff",
      }),
    ).toContain("advisory recommendationMarkdown");
    expect(
      buildInitialOverallReviewPrompt({
        planContext: "# Plan",
        candidateContext: "combined diff",
        deferredConcerns: [
          {
            id: "D-P1",
            summary: "Cross-task concern",
            evidence: "task evidence",
            basis: { kind: "correctness_invariant", invariant: "safe" },
            sourceScope: "task",
            sourceCandidate: "candidate-a",
            rationale: "Needs full feature context",
          },
        ],
      }),
    ).toContain("Assess every supplied ID exactly once");
    expect(
      buildAnchoredOverallReviewPrompt({
        planContext: "# Plan",
        candidateContext: "combined diff",
        outstandingFindings: [outstandingFinding],
        previousCandidate: "abc",
        currentCandidate: "def",
        latestDelta: "src/api.ts",
      }),
    ).toContain("A resolved ID cannot be reopened");
  });
});

describe("buildOverallReviewerPrompt", () => {
  it("includes plan, diff, base/head SHAs, run ID, and landed tasks", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n\n- [ ] Task 1\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      runId: "r20240115-120000",
      landedTasks: [{ id: "t001-task", title: "Task 1", commitSha: "aaa1111" }],
    });

    expect(prompt).toContain("# Plan\n\n- [ ] Task 1");
    expect(prompt).toContain("/repo/plans/feature.md");
    expect(prompt).toContain("abc1234");
    expect(prompt).toContain("def5678");
    expect(prompt).toContain("r20240115-120000");
    expect(prompt).toContain("t001-task");
    expect(prompt).toContain("aaa1111");
    expect(prompt).toContain("diff --git a/file.ts b/file.ts");
    expect(prompt).toContain(
      "Submit the overall review verdict through the injected completion tool",
    );
    expect(prompt).toContain(
      "Per-task reviewers may have approved simple tasks after bounded triage; this overall pass remains responsible for whole-feature integration and missed original-plan requirements.",
    );
    expect(prompt).toContain("Approve if the feature is complete");
    expect(prompt).toContain("Request changes if there are material gaps");
  });

  it("omits run ID and landed tasks when not provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
    });

    expect(prompt).not.toContain("Run ID:");
    expect(prompt).not.toContain("Landed Tasks");
  });

  it("does not include a bundle material section when not provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
    });

    expect(prompt).not.toContain("## Referenced Plan Material");
  });

  it("includes bundle material when provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      bundleMaterial: "### auth.md\n\n# Auth\n",
    });

    expect(prompt).toContain("## Referenced Plan Material");
    expect(prompt).toContain("### auth.md");
    expect(prompt).toContain("# Auth");
  });

  it("does not include a corpus section when not provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
    });

    expect(prompt).not.toContain("## Plan Corpus");
  });

  it("includes corpus material when provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      corpusMaterial: "### requirements.md\n\n# Corpus-only requirement\n",
    });

    expect(prompt).toContain("## Plan Corpus");
    expect(prompt).toContain("### requirements.md");
    expect(prompt).toContain("# Corpus-only requirement");
  });

  it("includes corpus-only requirements for planner/compiler omission checks", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan\n",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      corpusMaterial:
        "### tasks.md\n\nThis file contains a requirement that must be verified in the final review even though it was not part of any compiled task contract.",
    });

    expect(prompt).toContain(
      "This file contains a requirement that must be verified in the final review even though it was not part of any compiled task contract.",
    );
  });
});

const SAMPLE_MANIFEST: ExecutionManifest = {
  version: 1,
  sourcePlanPath: "/repo/plans/feature.md",
  sourcePlanHash: "abc1234",
  plannerReason: "Independent tasks",
  plannerConfidence: "high",
  tasks: [
    {
      id: "t1",
      planIndex: 1,
      title: "Task 1",
      taskHash: "h1",
      status: "todo",
      dependsOn: [],
      affectedAreas: [],
      conflictHints: [],
      sourceReferences: [],
      compiledContract: {
        objective: "Implement feature A",
        inScope: ["Add A"],
        acceptanceCriteria: ["A works"],
        outOfScope: ["B"],
      },
    },
    {
      id: "t2",
      planIndex: 2,
      title: "Task 2",
      taskHash: "h2",
      status: "todo",
      dependsOn: ["t1"],
      affectedAreas: [],
      conflictHints: [],
      sourceReferences: [],
      compiledContract: {
        objective: "Implement feature B",
        inScope: ["Add B"],
        acceptanceCriteria: ["B works"],
        outOfScope: ["A"],
      },
    },
  ],
};

describe("buildOverallReviewerPrompt with executionManifest", () => {
  it("includes execution manifest summary and planner/compiler omission guidance", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      executionManifest: SAMPLE_MANIFEST,
    });

    expect(prompt).toContain("## Execution Manifest");
    expect(prompt).toContain("Source plan: /repo/plans/feature.md");
    expect(prompt).toContain("Source plan hash: abc1234");
    expect(prompt).toContain("Planner reason: Independent tasks");
    expect(prompt).toContain("Planner confidence: high");
    expect(prompt).toContain("### Responsibility Map");
    expect(prompt).toContain("#### t1: Task 1");
    expect(prompt).toContain("Objective: Implement feature A");
    expect(prompt).toContain("In scope: Add A");
    expect(prompt).toContain("Acceptance criteria: A works");
    expect(prompt).toContain("Out of scope: B");
    expect(prompt).toContain("#### t2: Task 2");
    expect(prompt).toContain("Objective: Implement feature B");
    expect(prompt).toContain("### Review Focus");
    expect(prompt).toContain("planner/compiler omissions");
    expect(prompt).toContain("full original human plan intent");
  });

  it("omits manifest section when no executionManifest is provided", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
    });

    expect(prompt).not.toContain("## Execution Manifest");
  });

  it("still includes omission guidance in review rules even without manifest", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
    });

    expect(prompt).toContain("planner/compiler omissions");
  });

  it("includes corpus material alongside execution manifest for full-plan audit", () => {
    const prompt = buildOverallReviewerPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      executionManifest: SAMPLE_MANIFEST,
      corpusMaterial:
        "### background.md\n\nAll features must support dark mode.",
    });

    expect(prompt).toContain("## Execution Manifest");
    expect(prompt).toContain("## Plan Corpus");
    expect(prompt).toContain("All features must support dark mode.");
    const corpusIndex = prompt.indexOf("## Plan Corpus");
    const manifestIndex = prompt.indexOf("## Execution Manifest");
    expect(corpusIndex).toBeGreaterThan(0);
    expect(manifestIndex).toBeGreaterThan(0);
  });
});

describe("buildOverallReworkPrompt", () => {
  it("includes execution manifest when provided", () => {
    const prompt = buildOverallReworkPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      findings: [],
      executionManifest: SAMPLE_MANIFEST,
    });

    expect(prompt).toContain("## Execution Manifest");
    expect(prompt).toContain("Source plan: /repo/plans/feature.md");
    expect(prompt).toContain("t1: Task 1");
    expect(prompt).toContain("t2: Task 2");
    expect(prompt).toContain("full original human plan intent");
  });

  it("omits manifest section when no executionManifest is provided", () => {
    const prompt = buildOverallReworkPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      findings: [],
    });

    expect(prompt).not.toContain("## Execution Manifest");
  });

  it("includes required changes and recommendation", () => {
    const prompt = buildOverallReworkPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      findings: [
        {
          id: "O-1",
          summary: "Fix integration",
          evidence: "evidence",
          requiredChange: "Fix integration",
          acceptanceCriteria: ["passes"],
          introducedRound: 1,
          origin: "initial",
        },
        {
          id: "O-2",
          summary: "Add tests",
          evidence: "evidence",
          requiredChange: "Add tests",
          acceptanceCriteria: ["passes"],
          introducedRound: 1,
          origin: "initial",
        },
      ],
      recommendationMarkdown: "## Suggested Fix\n\nRefactor...",
      priorAttemptFailures: ["Attempt 1: tests failed"],
    });

    expect(prompt).toContain("Required change: Fix integration");
    expect(prompt).toContain("Required change: Add tests");
    expect(prompt).toContain("## Suggested Fix");
    expect(prompt).toContain("## Prior Rework Attempt Failures");
    expect(prompt).toContain("Attempt 1: tests failed");
  });

  it("does not include a corpus section when not provided", () => {
    const prompt = buildOverallReworkPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      findings: [],
    });

    expect(prompt).not.toContain("## Plan Corpus");
  });

  it("includes corpus material when provided", () => {
    const prompt = buildOverallReworkPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      findings: [],
      corpusMaterial: "### requirements.md\n\n# Corpus-only requirement\n",
    });

    expect(prompt).toContain("## Plan Corpus");
    expect(prompt).toContain("### requirements.md");
    expect(prompt).toContain("# Corpus-only requirement");
  });

  it("includes corpus-only requirements for planner/compiler omission checks", () => {
    const prompt = buildOverallReworkPrompt({
      planContent: "# Plan",
      planPath: "/repo/plans/feature.md",
      baseSha: "abc1234",
      headSha: "def5678",
      diff: "diff --git a/file.ts b/file.ts\n",
      findings: [],
      corpusMaterial:
        "### tasks.md\n\nThis file contains a requirement that must be verified in the final rework even though it was not part of any compiled task contract.",
    });

    expect(prompt).toContain(
      "This file contains a requirement that must be verified in the final rework even though it was not part of any compiled task contract.",
    );
  });
});
