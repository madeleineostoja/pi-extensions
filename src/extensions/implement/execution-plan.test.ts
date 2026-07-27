import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildPlannerPacket,
  compileExecutionPlan,
  parsePlannerExecutionPlan,
  planExecution,
  readExecutionPlan,
  writeExecutionPlan,
  type ExecutionPlanCompilerInput,
} from "./execution-plan.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";

const planPath = "/repo/plan.md";

function input(content = planContent): ExecutionPlanCompilerInput {
  const plan = parsePlan(planPath, content);
  return {
    plan,
    planHash: "plan-hash",
    materialStore: buildMaterialStore({ plan, planPath, repoRoot: "/repo" }),
    checkoutId: "checkout-id",
    baseSha: "base-sha",
    workerConcurrency: 2,
  };
}

const planContent = `# Plan

## Tasks

- [x] Completed context
- [ ] First branch
- [ ] Second branch
- [ ] Join branches
`;

function plannerPlan() {
  return {
    version: 1,
    plannerReason:
      "The first two tasks are independent and the third joins them.",
    plannerConfidence: "high",
    tasks: [
      task("first", 1, []),
      task("second", 2, []),
      task("join", 3, ["first", "second"]),
    ],
    workstreams: [
      {
        id: "first-work",
        taskIds: ["first"],
        dependsOn: [],
        rationale: "Independent branch.",
        risk: "normal",
      },
      {
        id: "second-work",
        taskIds: ["second"],
        dependsOn: [],
        rationale: "Independent branch.",
        risk: "normal",
      },
      {
        id: "join-work",
        taskIds: ["join"],
        dependsOn: ["first-work", "second-work"],
        rationale: "Requires both branches.",
        risk: "normal",
      },
    ],
  };
}

function task(id: string, planIndex: number, dependsOn: string[]) {
  return {
    id,
    planIndex,
    title: id,
    dependsOn,
    provenance: [
      {
        path: planPath,
        quote:
          id === "first"
            ? "First branch"
            : id === "second"
              ? "Second branch"
              : "Join branches",
      },
    ],
    compiledContract: {
      objective: `Implement ${id}.`,
      inScope: [`${id} behavior`],
      acceptanceCriteria: [`${id} works`],
      outOfScope: ["Sibling work"],
    },
  };
}

describe("strict execution-plan compiler", () => {
  it("materializes configured worker capacity in the planner packet", () => {
    const result = buildPlannerPacket({
      ...input(),
      workspacePath: "/repo",
      checkoutRoot: "/repo",
      runId: "run-1",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        role: "planner",
        completionKind: "planner",
        identity: "run-1/planner",
        workspace: { path: "/repo" },
        workerConcurrency: 2,
      },
    });
  });

  it("deduplicates recursive corpus cycles before invoking the planner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipkin-implement-plan-"));
    const sourcePath = join(directory, "plan.md");
    try {
      writeFileSync(
        sourcePath,
        "# Plan\n\n## Tasks\n\n- [ ] Task\n\n[a](a.md)\n",
      );
      writeFileSync(join(directory, "a.md"), "[b](b.md)\n");
      writeFileSync(join(directory, "b.md"), "[plan](plan.md)\n");
      const plan = parsePlan(sourcePath, readFileSync(sourcePath, "utf-8"));
      const materialStore = buildMaterialStore({
        plan,
        planPath: sourcePath,
        repoRoot: directory,
      });
      let calls = 0;
      const result = await planExecution({
        plan,
        planHash: "plan-hash",
        materialStore,
        checkoutId: "checkout-id",
        baseSha: "base-sha",
        workerConcurrency: 1,
        runDir: join(directory, "run"),
        workspacePath: directory,
        checkoutRoot: directory,
        runId: "run-1",
        requestPlanner: async () => {
          calls++;
          return {
            version: 1,
            plannerReason: "One task is sufficient for this cycle fixture.",
            plannerConfidence: "high",
            tasks: [
              {
                id: "task",
                planIndex: 1,
                title: "Task",
                dependsOn: [],
                provenance: [{ path: sourcePath, quote: "Task" }],
                compiledContract: {
                  objective: "Implement the task.",
                  inScope: ["Task behavior"],
                  acceptanceCriteria: ["Task works"],
                  outOfScope: ["Unrelated changes"],
                },
              },
            ],
            workstreams: [
              {
                id: "task-work",
                taskIds: ["task"],
                dependsOn: [],
                rationale: "Only one task exists.",
                risk: "normal",
              },
            ],
          };
        },
      });

      expect(result.ok).toBe(true);
      expect(calls).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not invoke a planner for an all-checked plan", async () => {
    let calls = 0;
    const result = await planExecution({
      ...input(planContent.replace(/\[ \]/g, "[x]")),
      runDir: "/unused",
      workspacePath: "/unused",
      checkoutRoot: "/unused",
      runId: "run-1",
      requestPlanner: async () => {
        calls++;
        return plannerPlan();
      },
    });

    expect(result).toEqual({ ok: true, value: { kind: "no-op" } });
    expect(calls).toBe(0);
  });

  it("compiles the parser-selected headingless checkbox section", () => {
    const headingless = `Plan introduction.\n\n- [ ] First branch\n- [ ] Second branch\n- [ ] Join branches\n`;

    expect(compileExecutionPlan(plannerPlan(), input(headingless)).ok).toBe(
      true,
    );
  });

  it("compiles a parser-selected checkbox section with an arbitrary heading", () => {
    const arbitraryHeading = `# Plan\n\n## Delivery work\n\n- [ ] First branch\n- [ ] Second branch\n- [ ] Join branches\n`;

    expect(
      compileExecutionPlan(plannerPlan(), input(arbitraryHeading)).ok,
    ).toBe(true);
  });

  it("compiles consistently indented source tasks", () => {
    const indented = `# Plan\n\n  - [ ] First branch\n  - [ ] Second branch\n  - [ ] Join branches\n`;

    const result = compileExecutionPlan(plannerPlan(), input(indented));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.value.tasks.map((task) => task.sourceAnchor)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineNumber: 3,
          lineText: "  - [ ] First branch",
        }),
      ]),
    );
  });

  it("binds sequential unchecked indexes and host-owned source identity", () => {
    const result = compileExecutionPlan(plannerPlan(), input());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.tasks.map((task) => task.planIndex)).toEqual([1, 2, 3]);
    expect(result.value.tasks[0]?.sourceAnchor.lineNumber).toBe(6);
    expect(result.value.source).toMatchObject({
      planPath,
      planHash: "plan-hash",
      corpusHash: result.value.source.corpusHash,
      checkoutId: "checkout-id",
      baseSha: "base-sha",
    });
    expect(result.value.source.corpusFiles).toEqual([
      { path: planPath, hash: result.value.source.corpusFiles[0]?.hash },
    ]);
    expect(result.value.executionPlanHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    [
      "unsafe task id",
      (plan: ReturnType<typeof plannerPlan>) => {
        plan.tasks[0]!.id = "unsafe_id";
      },
    ],
    [
      "missing task coverage",
      (plan: ReturnType<typeof plannerPlan>) => {
        plan.tasks.pop();
        plan.workstreams.pop();
      },
    ],
    [
      "checked task index",
      (plan: ReturnType<typeof plannerPlan>) => {
        plan.tasks[0]!.planIndex = 4;
      },
    ],
    [
      "unknown planner field",
      (plan: ReturnType<typeof plannerPlan>) => {
        Object.assign(plan, { fallbackGenerated: true });
      },
    ],
    [
      "ungrounded provenance",
      (plan: ReturnType<typeof plannerPlan>) => {
        plan.tasks[0]!.provenance[0]!.quote = "not in corpus";
      },
    ],
  ])("blocks %s before a workstream can be created", (_name, mutate) => {
    const plan = plannerPlan();
    mutate(plan);

    expect(compileExecutionPlan(plan, input()).ok).toBe(false);
  });

  it("persists an immutable, schema-validated execution plan", () => {
    const result = compileExecutionPlan(plannerPlan(), input());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const directory = mkdtempSync(
      join(tmpdir(), "pipkin-implement-execution-"),
    );
    try {
      writeExecutionPlan(directory, result.value);
      expect(readExecutionPlan(directory)).toEqual(result.value);
      expect(() => writeExecutionPlan(directory, result.value)).toThrow(
        "Execution plan already exists",
      );
      const path = join(directory, "execution-plan.json");
      const tampered = JSON.parse(readFileSync(path, "utf-8"));
      tampered.fallbackGenerated = true;
      writeFileSync(path, JSON.stringify(tampered));
      expect(readExecutionPlan(directory)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires workstream dependencies induced by task dependencies", () => {
    const plan = plannerPlan();
    plan.workstreams[2]!.dependsOn = ["first-work"];

    expect(compileExecutionPlan(plan, input()).ok).toBe(false);
  });

  it("accepts a high-risk task as an isolated workstream", () => {
    const plan = plannerPlan();
    plan.workstreams = [
      {
        id: "batched",
        taskIds: ["first", "second"],
        dependsOn: [],
        rationale: "Shared evolving abstraction.",
        risk: "normal",
      },
      {
        id: "isolated-join",
        taskIds: ["join"],
        dependsOn: ["batched"],
        rationale: "Protocol migration needs isolated review.",
        risk: "isolated",
      },
    ];

    expect(compileExecutionPlan(plan, input()).ok).toBe(true);
  });

  it("rejects unknown nested fields instead of silently accepting incompatible output", () => {
    const plan = plannerPlan();
    Object.assign(plan.tasks[0]!.compiledContract, { generatedId: "no" });

    const parsed = parsePlannerExecutionPlan(plan);
    expect(parsed.ok).toBe(false);
  });
});
