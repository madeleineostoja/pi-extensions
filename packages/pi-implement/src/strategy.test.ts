import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectStrategy } from "./strategy.js";
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

describe("selectStrategy - forced serial", () => {
  it("selects serial immediately for --serial without calling planner", async () => {
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
      updateState: () => ({}),
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
      updateState: () => ({}),
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
      updateState: () => ({}),
      requestedMode: "auto",
    });
    expect(result.mode).toBe("serial");
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });
});

describe("selectStrategy - auto mode planner", () => {
  it("calls planner directly for 2 unchecked tasks in auto mode", async () => {
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "serial",
        reason: "clear sequential dependency",
        confidence: "high",
      }),
    );
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
      updateState: () => ({}),
      requestedMode: "auto",
    });
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
    expect(result.mode).toBe("serial");
  });

  it("calls planner directly for 3+ tasks", async () => {
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "serial",
        reason: "clear semantic chain",
        confidence: "high",
      }),
    );
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
      updateState: () => ({}),
      requestedMode: "auto",
    });
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
    expect(result.mode).toBe("serial");
  });

  it("planner can return serial for auto mode", async () => {
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "serial",
        reason: "clear semantic sequence",
        confidence: "high",
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
      updateState: () => ({}),
      requestedMode: "auto",
    });
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
    expect(result.mode).toBe("serial");
  });

  it("planner can return parallel for auto mode", async () => {
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
      baseSha: "abc",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      updateState: () => ({}),
      requestedMode: "auto",
    });
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
    expect(result.mode).toBe("parallel");
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
      updateState: () => ({}),
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
      updateState: () => ({}),
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
      updateState: () => ({}),
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
      updateState: () => ({}),
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

describe("selectStrategy - planner prompt content", () => {
  it("does not contain old eager-context section headings", async () => {
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "serial",
        reason: "clear sequence",
        confidence: "high",
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
      updateState: () => ({}),
      requestedMode: "auto",
    });

    const spawnMock = subagents.spawn as unknown as {
      mock: { calls: Array<Array<{ prompt: string }>> };
    };
    const prompt = spawnMock.mock.calls[0][0].prompt;
    expect(prompt).not.toContain("File Tree");
    expect(prompt).not.toContain("Package Manifests");
    expect(prompt).not.toContain("Targeted Evidence");
  });

  it("contains the deterministic context packet", async () => {
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "serial",
        reason: "clear sequence",
        confidence: "high",
      }),
    );
    const plan = makePlan(["Task A", "Task B"]);
    await selectStrategy({
      plan,
      planContent: plan.content,
      planHash: "planhash123",
      repoRoot: "/repo",
      baseSha: "abc123",
      config: {},
      roles: makeRoles(),
      subagents,
      paths: makeStatePaths(),
      runId: "r1",
      updateState: () => ({}),
      requestedMode: "auto",
    });

    const spawnMock = subagents.spawn as unknown as {
      mock: { calls: Array<Array<{ prompt: string }>> };
    };
    const prompt = spawnMock.mock.calls[0][0].prompt;
    expect(prompt).toContain("Repo root: /repo");
    expect(prompt).toContain("Base SHA: abc123");
    expect(prompt).toContain("Plan path: /repo/plan.md");
    expect(prompt).toContain("Plan hash: planhash123");
    expect(prompt).toContain("Current Git Status");
    expect(prompt).toContain("- [planIndex=1] Task A");
    expect(prompt).toContain("- [planIndex=2] Task B");
    expect(prompt).toContain("Task hashes:");
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
      updateState: () => ({}),
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
    const subagents = makeSubagents(
      JSON.stringify({
        mode: "parallel",
        reason: "ok",
        confidence: "high",
        maxConcurrency: 100,
        graph,
      }),
    );
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
      updateState: () => ({}),
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
      updateState: () => ({}),
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
    // selectStrategy only spawns subagents for planner calls, never to
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
      updateState: () => ({}),
      requestedMode: "parallel",
      requestedConcurrency: 2,
    });
    // Only one spawn: the graph planner. validationCommands are never executed.
    expect(
      (subagents.spawn as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
  });
});
