import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDeterministicSourceMaterialRefs,
  buildTaskAnchorSourceMaterialRef,
  generateMinimalExecutionManifest,
  parseExecutionPlan,
  validateExecutionManifest,
  renderCompiledContract,
  readExecutionManifest,
  writeExecutionManifest,
  type CompiledContract,
  type ExecutionManifest,
  type ExecutionTask,
  type SourceMaterialRef,
} from "./execution-plan.js";
import { buildPlanBundleManifest } from "./manifest.js";
import { parsePlanFile } from "./plan.js";

function makeContract(
  overrides: Partial<CompiledContract> = {},
): CompiledContract {
  return {
    objective: "Do the thing",
    inScope: ["Item one"],
    acceptanceCriteria: ["Criterion one"],
    outOfScope: ["Nothing else"],
    ...overrides,
  };
}

let nextPlanIndex = 1;

function makeTask(
  overrides: Partial<ExecutionTask> & { id: string },
): ExecutionTask {
  const task: ExecutionTask = {
    planIndex: nextPlanIndex++,
    title: "Task title",
    taskHash: "abc12345",
    status: "todo",
    dependsOn: [],
    review: { mode: "require" },
    affectedAreas: [],
    conflictHints: [],
    sourceReferences: [],
    compiledContract: makeContract(),
    ...overrides,
  };
  return task;
}

function makeManifest(
  tasks: ExecutionTask[],
  meta: Partial<ExecutionManifest> = {},
): ExecutionManifest {
  return {
    version: 1,
    tasks,
    ...meta,
  };
}

describe("buildTaskAnchorSourceMaterialRef", () => {
  it("covers the selected checkbox line and task block only", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-task-anchor-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      [
        "# Plan",
        "",
        "## Tasks",
        "",
        "- [ ] First task",
        "  Details for first task.",
        "  - nested first task item",
        "- [ ] Second task",
        "  Details for second task.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const ref = buildTaskAnchorSourceMaterialRef(plan.tasks[0]!, planPath);

    expect(ref).toEqual({
      origin: "task-anchor",
      path: planPath,
      mode: { kind: "line-range", startLine: 5, endLine: 7 },
      reason: "Selected task checkbox line and task block.",
    });
    expect(readFileSync(planPath, "utf-8").split(/\r?\n/).slice(4, 7)).toEqual([
      "- [ ] First task",
      "  Details for first task.",
      "  - nested first task item",
    ]);
  });
});

describe("buildDeterministicSourceMaterialRefs", () => {
  it("adds explicit task-block markdown links as full-file task-link refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-task-link-"));
    const planPath = join(dir, "plan.md");
    const taskPath = join(dir, "task.md");
    const subplanPath = join(dir, "subplan.md");
    writeFileSync(
      planPath,
      [
        "# Plan",
        "",
        "## Tasks",
        "",
        "- [ ] First task",
        "  - Plan: `subplan.md`",
        "  Use [task material](task.md#details).",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(taskPath, "# Task Material\n", "utf-8");
    writeFileSync(subplanPath, "# Subplan\n", "utf-8");

    const plan = parsePlanFile(planPath);
    const bundle = buildPlanBundleManifest(planPath, plan);

    expect(
      buildDeterministicSourceMaterialRefs(plan.tasks[0]!, planPath, bundle),
    ).toEqual([
      {
        origin: "task-anchor",
        path: planPath,
        mode: { kind: "line-range", startLine: 5, endLine: 8 },
        reason: "Selected task checkbox line and task block.",
      },
      {
        origin: "task-link",
        path: subplanPath,
        mode: { kind: "full-file" },
        reason:
          "Explicit local Markdown material linked from the selected task block.",
      },
      {
        origin: "task-link",
        path: taskPath,
        mode: { kind: "full-file" },
        reason:
          "Explicit local Markdown material linked from the selected task block.",
      },
    ]);
  });
});

describe("generateMinimalExecutionManifest", () => {
  it("adds task-anchor source material refs to fallback manifest tasks", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-minimal-anchor-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] First task\n  Details for first task.\n- [ ] Second task\n",
      "utf-8",
    );
    const plan = parsePlanFile(planPath);

    const manifest = generateMinimalExecutionManifest(plan.tasks, planPath);

    expect(manifest.tasks[0]?.sourceMaterialRefs).toEqual([
      {
        origin: "task-anchor",
        path: planPath,
        mode: { kind: "line-range", startLine: 5, endLine: 6 },
        reason: "Selected task checkbox line and task block.",
      },
    ]);
  });
});

describe("parseExecutionPlan", () => {
  it("parses a valid minimal plan (one task, no deps)", () => {
    const manifest = makeManifest([makeTask({ id: "t1" })]);
    const result = parseExecutionPlan(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks).toHaveLength(1);
      expect(result.value.tasks[0].id).toBe("t1");
    }
  });

  it("parses a valid multi-task plan with dependencies", () => {
    const manifest = makeManifest([
      makeTask({ id: "t1" }),
      makeTask({ id: "t2", dependsOn: ["t1"] }),
    ]);
    const result = parseExecutionPlan(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks).toHaveLength(2);
      expect(result.value.tasks[1].dependsOn).toEqual(["t1"]);
    }
  });

  it("parses embedded JSON in prose", () => {
    const manifest = makeManifest([makeTask({ id: "t1" })]);
    const text = `Here is the plan.\n\n${JSON.stringify(manifest)}\n\nDone.`;
    const result = parseExecutionPlan(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].id).toBe("t1");
    }
  });

  it("parses embedded JSON in a markdown fence", () => {
    const manifest = makeManifest([makeTask({ id: "t1" })]);
    const text = `\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\``;
    const result = parseExecutionPlan(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].id).toBe("t1");
    }
  });

  it("rejects invalid JSON", () => {
    const result = parseExecutionPlan("{ invalid json }");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("valid JSON");
    }
  });

  it("rejects missing version", () => {
    const result = parseExecutionPlan(
      JSON.stringify({ tasks: [makeTask({ id: "t1" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("version");
    }
  });

  it("rejects missing tasks", () => {
    const result = parseExecutionPlan(JSON.stringify({ version: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tasks");
    }
  });

  it("rejects unknown version", () => {
    const result = parseExecutionPlan(
      JSON.stringify({ version: 2, tasks: [makeTask({ id: "t1" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("version");
    }
  });

  it("rejects tasks not an array", () => {
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: "oops" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tasks array");
    }
  });

  it("rejects task missing id", () => {
    const task = { ...makeTask({ id: "t1" }), id: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("id");
    }
  });

  it("rejects task with empty id", () => {
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [makeTask({ id: "   " })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("id");
    }
  });

  it("rejects task missing title", () => {
    const task = { ...makeTask({ id: "t1" }), title: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("title");
    }
  });

  it("rejects task with empty title", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), title: "   " }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("title");
    }
  });

  it("rejects task missing status", () => {
    const task = { ...makeTask({ id: "t1" }), status: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("status");
    }
  });

  it("rejects task with invalid status", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), status: "in_progress" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("status");
    }
  });

  it("accepts status 'done'", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), status: "done" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].status).toBe("done");
    }
  });

  it("rejects task missing dependsOn", () => {
    const task = { ...makeTask({ id: "t1" }), dependsOn: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("dependsOn");
    }
  });

  it("rejects task with non-array dependsOn", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), dependsOn: "t0" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("dependsOn");
    }
  });

  it("rejects task missing review", () => {
    const task = { ...makeTask({ id: "t1" }), review: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("review");
    }
  });

  it("rejects task with invalid review mode", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), review: { mode: "maybe" } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("review mode");
    }
  });

  it("rejects task with non-object review", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), review: "skip" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("review must be an object");
    }
  });

  it("rejects task missing affectedAreas", () => {
    const task = { ...makeTask({ id: "t1" }), affectedAreas: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("affectedAreas");
    }
  });

  it("rejects task with non-array affectedAreas", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), affectedAreas: "src" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("affectedAreas");
    }
  });

  it("rejects task missing conflictHints", () => {
    const task = { ...makeTask({ id: "t1" }), conflictHints: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("conflictHints");
    }
  });

  it("rejects task with non-array conflictHints", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), conflictHints: "none" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("conflictHints");
    }
  });

  it("accepts task missing legacy sourceReferences", () => {
    const task = { ...makeTask({ id: "t1" }), sourceReferences: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceReferences).toEqual([]);
    }
  });

  it("rejects task with non-array sourceReferences", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), sourceReferences: "docs" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("sourceReferences");
    }
  });

  it("parses valid full-file sourceMaterialRefs without changing sourceRefs", () => {
    const sourceRefs = [{ path: "plan.md", quote: "Do the thing" }];
    const sourceMaterialRefs = [
      {
        origin: "task-anchor",
        path: "plan.md",
        mode: { kind: "full-file" },
        reason: "Task anchor material",
      },
    ] satisfies SourceMaterialRef[];
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [makeTask({ id: "t1", sourceRefs, sourceMaterialRefs })],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceMaterialRefs).toEqual(
        sourceMaterialRefs,
      );
      expect(result.value.tasks[0].sourceRefs).toEqual(sourceRefs);
    }
  });

  it("parses valid line-range sourceMaterialRefs", () => {
    const sourceMaterialRefs = [
      {
        origin: "task-link",
        path: "requirements.md",
        mode: { kind: "line-range", startLine: 3, endLine: 8 },
        reason: "Linked requirement excerpt",
      },
      {
        origin: "planner",
        path: "src/feature.ts",
        mode: { kind: "line-range", startLine: 10, endLine: 12 },
        reason: "Planner-selected code excerpt",
      },
    ] satisfies SourceMaterialRef[];
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [makeTask({ id: "t1", sourceMaterialRefs })],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceMaterialRefs).toEqual(
        sourceMaterialRefs,
      );
    }
  });

  it("preserves sourceMaterialRefs across execution manifest serialization", () => {
    const sourceMaterialRefs = [
      {
        origin: "needs-material",
        path: "plan.md",
        mode: { kind: "full-file" },
        reason: "Requested full context",
      },
      {
        origin: "fallback",
        path: "notes.md",
        mode: { kind: "line-range", startLine: 2, endLine: 4 },
        reason: "Fallback excerpt",
      },
    ] satisfies SourceMaterialRef[];
    const manifest = makeManifest([makeTask({ id: "t1", sourceMaterialRefs })]);
    const runDir = mkdtempSync(join(tmpdir(), "pi-execution-plan-test-"));

    writeExecutionManifest(runDir, manifest);

    expect(readExecutionManifest(runDir)?.tasks[0].sourceMaterialRefs).toEqual(
      sourceMaterialRefs,
    );
  });

  it("downgrades sourceMaterialRefs with invalid origin", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceMaterialRefs: [
              {
                origin: "plan",
                path: "plan.md",
                mode: { kind: "full-file" },
                reason: "Old origin shape",
              },
            ],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceMaterialRefs).toEqual([]);
      expect(result.value.tasks[0].reasons?.[0]).toContain(
        "sourceMaterialRefs[0] origin",
      );
    }
  });

  it("downgrades sourceMaterialRefs without a reason", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceMaterialRefs: [
              {
                origin: "task-anchor",
                path: "plan.md",
                mode: { kind: "full-file" },
              },
            ],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceMaterialRefs).toEqual([]);
      expect(result.value.tasks[0].reasons?.[0]).toContain(
        "sourceMaterialRefs[0] reason",
      );
    }
  });

  it("downgrades line-range sourceMaterialRefs without a valid range", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceMaterialRefs: [
              {
                origin: "task-link",
                path: "requirements.md",
                mode: { kind: "line-range", startLine: 8, endLine: 3 },
                reason: "Invalid excerpt",
              },
            ],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceMaterialRefs).toEqual([]);
      expect(result.value.tasks[0].reasons?.[0]).toContain("line-range");
      expect(result.value.tasks[0].reasons?.[0]).toContain(
        "startLine and endLine",
      );
    }
  });

  it("downgrades sourceMaterialRefs with invalid mode shapes", () => {
    const stringModeResult = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceMaterialRefs: [
              {
                origin: "task-anchor",
                path: "plan.md",
                mode: "full-file",
                reason: "Old mode shape",
              },
            ],
          },
        ],
      }),
    );
    expect(stringModeResult.ok).toBe(true);
    if (stringModeResult.ok) {
      expect(stringModeResult.value.tasks[0].sourceMaterialRefs).toEqual([]);
      expect(stringModeResult.value.tasks[0].reasons?.[0]).toContain(
        "sourceMaterialRefs[0] mode",
      );
    }

    const unknownKindResult = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t2" }),
            sourceMaterialRefs: [
              {
                origin: "task-anchor",
                path: "plan.md",
                mode: { kind: "snippet" },
                reason: "Unknown mode kind",
              },
            ],
          },
        ],
      }),
    );
    expect(unknownKindResult.ok).toBe(true);
    if (unknownKindResult.ok) {
      expect(unknownKindResult.value.tasks[0].sourceMaterialRefs).toEqual([]);
      expect(unknownKindResult.value.tasks[0].reasons?.[0]).toContain(
        "sourceMaterialRefs[0] mode.kind",
      );
    }
  });

  it("keeps legacy sourceReferences provenance fallback unchanged", () => {
    const sourceMaterialRefs = [
      {
        origin: "fallback",
        path: "packet.md",
        mode: { kind: "full-file" },
        reason: "Fallback packet material",
      },
    ] satisfies SourceMaterialRef[];
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceReferences: ["legacy.md"],
            sourceRefs: undefined,
            sourceMaterialRefs,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceRefs).toEqual([{ path: "legacy.md" }]);
      expect(result.value.tasks[0].sourceMaterialRefs).toEqual(
        sourceMaterialRefs,
      );
    }
  });

  it("rejects task missing compiledContract", () => {
    const task = { ...makeTask({ id: "t1" }), compiledContract: undefined };
    const result = parseExecutionPlan(
      JSON.stringify({ version: 1, tasks: [task] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("compiledContract");
    }
  });

  it("rejects task with non-object compiledContract", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), compiledContract: "do it" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("compiledContract must be an object");
    }
  });

  it("rejects empty inScope array", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            compiledContract: makeContract({ inScope: [] }),
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("inScope");
    }
  });

  it("rejects inScope array with blank strings", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            compiledContract: makeContract({ inScope: ["valid", "   "] }),
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("inScope");
    }
  });

  it("rejects empty acceptanceCriteria array", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            compiledContract: makeContract({ acceptanceCriteria: [] }),
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("acceptanceCriteria");
    }
  });

  it("rejects acceptanceCriteria array with blank strings", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            compiledContract: makeContract({
              acceptanceCriteria: ["valid", "   "],
            }),
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("acceptanceCriteria");
    }
  });

  it("rejects empty outOfScope array", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            compiledContract: makeContract({ outOfScope: [] }),
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("outOfScope");
    }
  });

  it("rejects outOfScope array with blank strings", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            compiledContract: makeContract({
              outOfScope: ["valid", "   "],
            }),
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("outOfScope");
    }
  });

  it("rejects empty compiledContract objective", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            compiledContract: makeContract({ objective: "   " }),
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("objective");
    }
  });

  it("rejects ambiguous multiple JSON objects", () => {
    const first = makeManifest([makeTask({ id: "t1" })]);
    const second = makeManifest([makeTask({ id: "t2" })]);
    const result = parseExecutionPlan(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("multiple JSON objects");
    }
  });

  it("parses optional top-level metadata fields", () => {
    const manifest = makeManifest([makeTask({ id: "t1" })], {
      sourcePlanHash: "abc123",
      sourcePlanPath: "/plan.md",
      plannerReason: "Because",
      plannerConfidence: "high",
      maxConcurrency: 3,
    });
    const result = parseExecutionPlan(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourcePlanHash).toBe("abc123");
      expect(result.value.sourcePlanPath).toBe("/plan.md");
      expect(result.value.plannerReason).toBe("Because");
      expect(result.value.plannerConfidence).toBe("high");
      expect(result.value.maxConcurrency).toBe(3);
    }
  });

  it("rejects non-positive maxConcurrency", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [makeTask({ id: "t1" })],
        maxConcurrency: 0,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxConcurrency).toBeUndefined();
    }
  });

  it("rejects non-integer maxConcurrency at parse time", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [makeTask({ id: "t1" })],
        maxConcurrency: 1.5,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxConcurrency).toBeUndefined();
    }
  });

  it("trims optional string fields", () => {
    const manifest = makeManifest([makeTask({ id: "t1" })], {
      sourcePlanHash: "  abc  ",
      plannerReason: "  Because  ",
    });
    const result = parseExecutionPlan(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourcePlanHash).toBe("abc");
      expect(result.value.plannerReason).toBe("Because");
    }
  });
});

describe("validateExecutionManifest", () => {
  it("accepts a valid single-task manifest", () => {
    const manifest = makeManifest([makeTask({ id: "t1" })]);
    expect(validateExecutionManifest(manifest)).toEqual({ ok: true });
  });

  it("accepts a valid two-task manifest with dependency", () => {
    const manifest = makeManifest([
      makeTask({ id: "t1" }),
      makeTask({ id: "t2", dependsOn: ["t1"] }),
    ]);
    expect(validateExecutionManifest(manifest)).toEqual({ ok: true });
  });

  it("rejects empty task list", () => {
    const manifest = makeManifest([]);
    const result = validateExecutionManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("at least one task");
    }
  });

  it("rejects duplicate task ids", () => {
    const manifest = makeManifest([
      makeTask({ id: "t1" }),
      makeTask({ id: "t1" }),
    ]);
    const result = validateExecutionManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Duplicate task id");
    }
  });

  it("rejects unknown dependency id", () => {
    const manifest = makeManifest([
      makeTask({ id: "t1", dependsOn: ["unknown"] }),
    ]);
    const result = validateExecutionManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unknown");
    }
  });

  it("rejects self-dependency", () => {
    const manifest = makeManifest([makeTask({ id: "t1", dependsOn: ["t1"] })]);
    const result = validateExecutionManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("itself");
    }
  });

  it("rejects a direct cycle", () => {
    const manifest = makeManifest([
      makeTask({ id: "t1", dependsOn: ["t2"] }),
      makeTask({ id: "t2", dependsOn: ["t1"] }),
    ]);
    const result = validateExecutionManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Cycle");
    }
  });

  it("rejects a three-node cycle", () => {
    const manifest = makeManifest([
      makeTask({ id: "t1", dependsOn: ["t3"] }),
      makeTask({ id: "t2", dependsOn: ["t1"] }),
      makeTask({ id: "t3", dependsOn: ["t2"] }),
    ]);
    const result = validateExecutionManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Cycle");
    }
  });

  it("rejects version not 1", () => {
    const manifest = makeManifest([makeTask({ id: "t1" })], {
      version: 2 as 1,
    });
    const result = validateExecutionManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("version");
    }
  });
});

describe("renderCompiledContract", () => {
  it("renders a minimal contract deterministically", () => {
    const contract = makeContract();
    const output = renderCompiledContract(contract);
    expect(output).toContain("# Task Contract");
    expect(output).toContain("## Objective");
    expect(output).toContain("Do the thing");
    expect(output).toContain("## In-Scope Items");
    expect(output).toContain("- Item one");
    expect(output).toContain("## Acceptance Criteria");
    expect(output).toContain("- Criterion one");
    expect(output).toContain("## Out-of-Scope Items");
    expect(output).toContain("- Nothing else");
    expect(output).not.toContain("Supporting Design Context");
    expect(output).not.toContain("Implementation Notes");
    expect(output).not.toContain("Verification Guidance");
  });

  it("renders a full contract with all optional fields", () => {
    const contract = makeContract({
      supportingDesignContext: "Use pattern X",
      implementationNotes: "Watch out for Y",
      verificationGuidance: "Run Z",
    });
    const output = renderCompiledContract(contract);
    expect(output).toContain("## Supporting Design Context");
    expect(output).toContain("Use pattern X");
    expect(output).toContain("## Implementation Notes");
    expect(output).toContain("Watch out for Y");
    expect(output).toContain("## Verification Guidance");
    expect(output).toContain("Run Z");
  });

  it("renders multiple items as a list", () => {
    const contract = makeContract({
      inScope: ["A", "B", "C"],
      acceptanceCriteria: ["D", "E"],
      outOfScope: ["F"],
    });
    const output = renderCompiledContract(contract);
    expect(output).toContain("- A");
    expect(output).toContain("- B");
    expect(output).toContain("- C");
    expect(output).toContain("- D");
    expect(output).toContain("- E");
    expect(output).toContain("- F");
  });

  it("produces deterministic output on repeated calls", () => {
    const contract = makeContract();
    const first = renderCompiledContract(contract);
    const second = renderCompiledContract(contract);
    expect(first).toBe(second);
  });
});

describe("parseExecutionPlan sourceCheckbox", () => {
  it("parses a task with sourceCheckbox", () => {
    const manifest = makeManifest([
      makeTask({
        id: "t1",
        sourceCheckbox: {
          path: "plan.md",
          lineNumber: 5,
          lineText: "- [ ] Do thing",
        },
      }),
    ]);
    const result = parseExecutionPlan(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceCheckbox).toEqual({
        path: "plan.md",
        lineNumber: 5,
        lineText: "- [ ] Do thing",
      });
    }
  });

  it("accepts a task without sourceCheckbox", () => {
    const manifest = makeManifest([makeTask({ id: "t1" })]);
    const result = parseExecutionPlan(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks[0].sourceCheckbox).toBeUndefined();
    }
  });

  it("rejects non-object sourceCheckbox", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [{ ...makeTask({ id: "t1" }), sourceCheckbox: "plan.md" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("sourceCheckbox must be an object");
    }
  });

  it("rejects sourceCheckbox with empty path", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceCheckbox: {
              path: "",
              lineNumber: 5,
              lineText: "- [ ] Do thing",
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("path must be a non-empty string");
    }
  });

  it("rejects sourceCheckbox with non-integer lineNumber", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceCheckbox: {
              path: "plan.md",
              lineNumber: 1.5,
              lineText: "- [ ] Do thing",
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("lineNumber must be a positive integer");
    }
  });

  it("rejects sourceCheckbox with zero lineNumber", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceCheckbox: {
              path: "plan.md",
              lineNumber: 0,
              lineText: "- [ ] Do thing",
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("lineNumber must be a positive integer");
    }
  });

  it("rejects sourceCheckbox with non-string lineText", () => {
    const result = parseExecutionPlan(
      JSON.stringify({
        version: 1,
        tasks: [
          {
            ...makeTask({ id: "t1" }),
            sourceCheckbox: { path: "plan.md", lineNumber: 5, lineText: 123 },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("lineText must be a string");
    }
  });
});
