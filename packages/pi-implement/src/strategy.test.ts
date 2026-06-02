import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTriagePrompt,
  extractSurfaceAreas,
  parseTriageOutput,
  selectStrategy,
} from "./strategy.js";
import { parsePlan } from "./plan.js";
import type { SubagentClient } from "./subagents.js";
import type { StatePaths } from "./state.js";
import type { EffectiveRoles } from "./config.js";
import type { ImplementGraph } from "./graph.js";

const PLAN_PATH = "/repo/plan.md";

let tmpRunDir: string;

beforeEach(() => {
  tmpRunDir = join(tmpdir(), `pi-strategy-test-${Date.now()}`);
  mkdirSync(tmpRunDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRunDir, { recursive: true, force: true });
});

function makePlan(taskLines: string[], checked: boolean[] = []) {
  const lines = taskLines.map((text, i) => {
    const mark = checked[i] ? "x" : " ";
    return `- [${mark}] ${text}`;
  });
  return parsePlan(PLAN_PATH, `# Plan\n\n## Tasks\n\n${lines.join("\n")}\n`);
}

function makeStatePaths(): StatePaths {
  return {
    baseDir: join(tmpRunDir, "state"),
    runDir: tmpRunDir,
    runJson: join(tmpRunDir, "run.json"),
    eventsJsonl: join(tmpRunDir, "events.jsonl"),
    planSnapshot: join(tmpRunDir, "plan.snapshot.md"),
    tasksDir: join(tmpRunDir, "tasks"),
    worktreesDir: join(tmpRunDir, "worktrees"),
    lockFile: join(tmpRunDir, "run.lock"),
  };
}

function makeRoles(): EffectiveRoles {
  return {
    implementer: { model: "p/m", type: "general-purpose" },
    reviewer: { model: "p/m", type: "general-purpose" },
    planner: { model: "p/m", type: "Explore" },
  };
}

function makeSubagents(result?: string): SubagentClient {
  const spawnFn = vi.fn().mockResolvedValue("agent-1");
  const waitForFn = vi
    .fn()
    .mockResolvedValue(
      result !== undefined
        ? { status: "completed", result }
        : { status: "failed", error: "not configured" },
    );
  return {
    probe: vi.fn().mockResolvedValue({ ok: true }),
    spawn: spawnFn,
    stop: vi.fn().mockResolvedValue(undefined),
    waitFor: waitForFn,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("extractSurfaceAreas", () => {
  it("extracts path-like tokens", () => {
    const areas = extractSurfaceAreas(
      "Add packages/foo/bar.ts and src/routes/x",
    );
    expect(areas).toContain("packages/foo/bar.ts");
    expect(areas).toContain("src/routes/x");
  });

  it("extracts backticked names with extensions", () => {
    const areas = extractSurfaceAreas(
      "Update `config.json` and `vitest.config.ts`",
    );
    expect(areas).toContain("config.json");
    expect(areas).toContain("vitest.config.ts");
  });

  it("does not extract short common words in backticks", () => {
    const areas = extractSurfaceAreas(
      "Use `the` and `bug` and `app` to fix it",
    );
    expect(areas).not.toContain("the");
    expect(areas).not.toContain("bug");
    expect(areas).not.toContain("app");
  });

  it("extracts leading nouns before surface words", () => {
    const areas = extractSurfaceAreas("Add the user model and payment route");
    expect(areas).toContain("user");
    expect(areas).toContain("payment");
  });

  it("returns empty array for plain prose", () => {
    const areas = extractSurfaceAreas("refactor to be cleaner");
    expect(areas).toHaveLength(0);
  });

  it("extracts docs path", () => {
    const areas = extractSurfaceAreas("Write docs/api/reference.md");
    expect(areas).toContain("docs/api/reference.md");
  });
});

describe("parseTriageOutput", () => {
  it("parses serial decision", () => {
    const result = parseTriageOutput(
      JSON.stringify({ decision: "serial", reason: "too coupled" }),
    );
    expect(result).toEqual({ decision: "serial", reason: "too coupled" });
  });

  it("parses escalate-to-planner decision", () => {
    const result = parseTriageOutput(
      JSON.stringify({
        decision: "escalate-to-planner",
        reason: "distinct areas",
      }),
    );
    expect(result).toEqual({
      decision: "escalate-to-planner",
      reason: "distinct areas",
    });
  });

  it("defaults to serial for unknown decision", () => {
    const result = parseTriageOutput(
      JSON.stringify({ decision: "parallel", reason: "fast" }),
    );
    expect(result.decision).toBe("serial");
  });

  it("rejects decision embedded in prose", () => {
    const text =
      'Analysis complete.\n\n{"decision":"escalate-to-planner","reason":"independent"}\n\nDone.';
    const result = parseTriageOutput(text);
    expect(result.decision).toBe("serial");
    expect(result.reason).toBeTruthy();
  });

  it("uses a fallback reason when reason is missing", () => {
    const result = parseTriageOutput(JSON.stringify({ decision: "serial" }));
    expect(result.decision).toBe("serial");
    expect(typeof result.reason).toBe("string");
  });
});

describe("buildTriagePrompt", () => {
  it("includes task text and plan content", () => {
    const plan = makePlan(["Task A", "Task B", "Task C"]);
    const unchecked = plan.tasks;
    const prompt = buildTriagePrompt(plan, unchecked);
    expect(prompt).toContain("Task A");
    expect(prompt).toContain("Task B");
    expect(prompt).toContain("Task C");
    expect(prompt).toContain("planIndex=");
  });

  it("does not include repo root, file tree, package manifests, git status, or file contents", () => {
    const plan = makePlan(["Task A", "Task B", "Task C"]);
    const unchecked = plan.tasks;
    const prompt = buildTriagePrompt(plan, unchecked);
    expect(prompt).not.toContain("/repo");
    expect(prompt).not.toContain("node_modules");
    expect(prompt).not.toContain("package.json content");
    expect(prompt).not.toContain("git ls-files");
    expect(prompt).not.toContain("git status");
    expect(prompt).not.toContain("## File Tree");
    expect(prompt).not.toContain("## Git Status");
    expect(prompt).not.toContain("## Package Manifests");
  });

  it("requests only serial or escalate-to-planner", () => {
    const plan = makePlan(["Task A", "Task B", "Task C"]);
    const prompt = buildTriagePrompt(plan, plan.tasks);
    expect(prompt).toContain("escalate-to-planner");
    expect(prompt).toContain("serial");
  });
});

describe("selectStrategy - forced serial", () => {
  it("selects serial immediately for --serial without calling triage", async () => {
    const subagents = makeSubagents();
    const plan = makePlan(["Task A", "Task B", "Task C"]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "serial",
    });
    expect(result.mode).toBe("serial");
    expect(result.reason).toContain("--serial");
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });
});

describe("selectStrategy - auto mode deterministic preconditions", () => {
  it("selects serial when zero unchecked tasks without LLM calls", async () => {
    const subagents = makeSubagents();
    const plan = makePlan(["Task A"], [true]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "auto",
    });
    expect(result.mode).toBe("serial");
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it("selects serial when one unchecked task without LLM calls", async () => {
    const subagents = makeSubagents();
    const plan = makePlan(["Task A", "Task B"], [true]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "auto",
    });
    expect(result.mode).toBe("serial");
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });
});

describe("selectStrategy - auto mode escalation rule", () => {
  it("selects serial for fewer than 3 unchecked tasks", async () => {
    const subagents = makeSubagents();
    const plan = makePlan(["packages/foo task", "packages/bar task"]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "auto",
    });
    expect(result.mode).toBe("serial");
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it("selects serial for 3+ tasks but fewer than 2 distinct surface areas (one noun yields 1 area)", async () => {
    const subagents = makeSubagents();
    // All tasks reference the same "auth" noun → 1 distinct area, not 2
    const plan = makePlan([
      "Add the auth model",
      "Test the auth model",
      "Document the auth model",
    ]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "auto",
    });
    expect(result.mode).toBe("serial");
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it("selects serial when only one task names areas (others name none), even if union has 2+ areas", async () => {
    const subagents = makeSubagents();
    // Only task 1 names areas; tasks 2 and 3 name no areas → tasksWithAreas < 2
    const plan = makePlan([
      "Add the user model and payment route",
      "Update configuration settings",
      "Refactor utilities",
    ]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "auto",
    });
    expect(result.mode).toBe("serial");
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it("calls triage for 3+ tasks with 2+ distinct surface areas", async () => {
    const subagents = makeSubagents(
      JSON.stringify({ decision: "serial", reason: "too coupled" }),
    );
    const plan = makePlan([
      "Update packages/auth/login.ts for auth",
      "Update src/routes/api.ts for API route",
      "Update docs/reference.md documentation",
    ]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "auto",
    });
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
    expect(result.mode).toBe("serial");
  });
});

describe("selectStrategy - forced parallel", () => {
  it("skips triage and calls graph planner", async () => {
    const graph: ImplementGraph = {
      version: 1,
      runId: "",
      baseSha: "",
      planPath: "",
      planHash: "",
      nodes: [
        {
          id: "t1",
          planIndex: 1,
          title: "Task A",
          taskHash: "a",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: ["packages/foo"],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "t2",
          planIndex: 2,
          title: "Task B",
          taskHash: "b",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: ["packages/bar"],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    };
    const plannerOutput = JSON.stringify({
      mode: "parallel",
      reason: "Independent areas",
      confidence: "high",
      maxConcurrency: 2,
      graph,
    });
    const subagents = makeSubagents(plannerOutput);
    const plan = makePlan(["Task A", "Task B"]);

    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "sha1",
      config: { maxParallel: 4 },
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "parallel",
      requestedConcurrency: 3,
    });

    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
    expect(result.mode).toBe("parallel");
    if (result.mode === "parallel") {
      expect(result.graph.nodes).toHaveLength(2);
      expect(result.graph.runId).toBe("r1");
      expect(result.graph.baseSha).toBe("sha1");
    }
  });

  it("falls back to serial with recorded reason when planner output is invalid", async () => {
    const subagents = makeSubagents("not valid json");
    const plan = makePlan(["Task A", "Task B"]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "parallel",
      requestedConcurrency: 2,
    });
    expect(result.mode).toBe("serial");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("falls back to serial when graph validation fails", async () => {
    const graph: ImplementGraph = {
      version: 1,
      runId: "",
      baseSha: "",
      planPath: "",
      planHash: "",
      nodes: [
        {
          id: "t1",
          planIndex: 1,
          title: "Task A",
          taskHash: "a",
          dependsOn: ["t-unknown"],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "t2",
          planIndex: 2,
          title: "Task B",
          taskHash: "b",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    };
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        graph,
      }),
    );
    const plan = makePlan(["Task A", "Task B"]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "parallel",
      requestedConcurrency: 2,
    });
    expect(result.mode).toBe("serial");
    expect(result.reason.toLowerCase()).toContain("serial");
  });

  it("excludes an absolute source plan path from planner git status", async () => {
    const repoRoot = join(tmpRunDir, "repo");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    git(repoRoot, "init");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    const planPath = join(repoRoot, "plan.md");
    const sourcePath = join(repoRoot, "src", "file.ts");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Update src/file.ts\n- [ ] Update docs/readme.md\n",
    );
    writeFileSync(sourcePath, "export const value = 1;\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "chore: init");
    const changedPlan =
      "# Plan\n\n## Tasks\n\n- [ ] Update src/file.ts\n- [ ] Update docs/readme.md\n\nDirty local note\n";
    writeFileSync(planPath, changedPlan);
    writeFileSync(sourcePath, "export const value = 2;\n");

    const subagents = makeSubagents("not valid json");
    const plan = parsePlan(planPath, changedPlan);
    await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot,
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "parallel",
      requestedConcurrency: 2,
    });

    const spawnMock = subagents.spawn as unknown as {
      mock: { calls: Array<Array<{ prompt: string }>> };
    };
    const prompt = spawnMock.mock.calls[0][0].prompt;
    expect(prompt).toContain(" M src/file.ts");
    expect(prompt).not.toContain(" M plan.md");
  });
});

describe("selectStrategy - concurrency clamping", () => {
  it("clamps effective concurrency to min(requested, config.maxParallel, 8)", async () => {
    const graph: ImplementGraph = {
      version: 1,
      runId: "",
      baseSha: "",
      planPath: "",
      planHash: "",
      nodes: [
        {
          id: "t1",
          planIndex: 1,
          title: "Task A",
          taskHash: "a",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "t2",
          planIndex: 2,
          title: "Task B",
          taskHash: "b",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    };
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        maxConcurrency: 10,
        graph,
      }),
    );
    const plan = makePlan(["Task A", "Task B"]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: { maxParallel: 3 },
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "parallel",
      requestedConcurrency: 5,
    });
    expect(result.mode).toBe("parallel");
    expect(result.maxConcurrency).toBe(3);
  });

  it("clamps for auto mode with planner-proposed maxConcurrency", async () => {
    const graph: ImplementGraph = {
      version: 1,
      runId: "",
      baseSha: "",
      planPath: "",
      planHash: "",
      nodes: [
        {
          id: "t1",
          planIndex: 1,
          title: "T1",
          taskHash: "a",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "t2",
          planIndex: 2,
          title: "T2",
          taskHash: "b",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "t3",
          planIndex: 3,
          title: "T3",
          taskHash: "c",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    };
    // Triage response followed by planner
    let callCount = 0;
    const subagents: SubagentClient = {
      probe: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(`agent-${callCount}`);
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      waitFor: vi.fn().mockImplementation((id: string) => {
        if (id === "agent-1") {
          return Promise.resolve({
            status: "completed" as const,
            result: JSON.stringify({
              decision: "escalate-to-planner",
              reason: "ok",
            }),
          });
        }
        return Promise.resolve({
          status: "completed" as const,
          result: JSON.stringify({
            mode: "parallel",
            reason: "ok",
            confidence: "high",
            maxConcurrency: 100,
            graph,
          }),
        });
      }),
    };
    const plan = makePlan([
      "Update packages/auth/login.ts for auth",
      "Update src/routes/api.ts route",
      "Update docs/reference.md documentation",
    ]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: { maxParallel: 2 },
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "auto",
    });
    if (result.mode === "parallel") {
      expect(result.maxConcurrency).toBeLessThanOrEqual(2);
    }
  });
});

describe("selectStrategy - validationCommands are advisory only", () => {
  it("persists validationCommands in graph nodes without executing them", async () => {
    const graph: ImplementGraph = {
      version: 1,
      runId: "",
      baseSha: "",
      planPath: "",
      planHash: "",
      nodes: [
        {
          id: "t1",
          planIndex: 1,
          title: "Task A",
          taskHash: "a",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: ["packages/foo"],
          conflictHints: [],
          validationCommands: ["npm test", "npm run build"],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "t2",
          planIndex: 2,
          title: "Task B",
          taskHash: "b",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: ["packages/bar"],
          conflictHints: [],
          validationCommands: ["npm run lint"],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    };
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "parallel",
        reason: "Independent",
        confidence: "high",
        graph,
      }),
    );
    const plan = makePlan(["Task A", "Task B"]);
    const result = await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "parallel",
      requestedConcurrency: 2,
    });
    if (result.mode === "parallel") {
      expect(result.graph.nodes[0].validationCommands).toEqual([
        "npm test",
        "npm run build",
      ]);
      expect(result.graph.nodes[1].validationCommands).toEqual([
        "npm run lint",
      ]);
    }
  });

  it("strategy module never spawns subagents for validationCommands", async () => {
    // selectStrategy only spawns subagents for triage/planner calls, never to
    // execute validationCommands. Verify no extra spawn calls occur beyond the
    // single graph planner call.
    const graph: ImplementGraph = {
      version: 1,
      runId: "",
      baseSha: "",
      planPath: "",
      planHash: "",
      nodes: [
        {
          id: "t1",
          planIndex: 1,
          title: "Task A",
          taskHash: "a",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: ["packages/foo"],
          conflictHints: [],
          validationCommands: ["npm test", "npm run build", "npm run lint"],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "t2",
          planIndex: 2,
          title: "Task B",
          taskHash: "b",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: ["packages/bar"],
          conflictHints: [],
          validationCommands: ["npm run typecheck"],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    };
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "parallel",
        reason: "Independent",
        confidence: "high",
        graph,
      }),
    );
    const plan = makePlan(["Task A", "Task B"]);
    await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "hash",
      repoRoot: "/repo",
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      requestedMode: "parallel",
      requestedConcurrency: 2,
    });
    // Only one spawn: the graph planner. validationCommands are never executed.
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
  });
});
