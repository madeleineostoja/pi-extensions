import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runImplementation } from "./orchestrator.js";
import type { CommandResult, GitClient } from "./git.js";
import type { SpawnArgs, SubagentClient, SubagentResult } from "./subagents.js";
import type { RunState } from "./status.js";

class FakeGit implements GitClient {
  commits: string[] = [];
  statusText = "";
  headValue = "h1";
  diffText = "diff --git a/file.ts b/file.ts";

  async root() {
    return "/repo";
  }
  async head() {
    return this.headValue;
  }
  async status() {
    return this.statusText;
  }
  async isClean() {
    return this.statusText.trim() === "";
  }
  async isCleanExcept() {
    return this.statusText.trim() === "";
  }
  async stageAllExcept() {}
  async hasStagedChanges() {
    return true;
  }
  async stagedDiffStat() {
    return " file.ts | 1 +";
  }
  async stagedNameStatus() {
    return "M\tfile.ts";
  }
  async stagedDiff() {
    return this.diffText;
  }
  worktreeFingerprintText = "worktree";
  restoredFromIndex = 0;
  restoredPatches: string[] = [];
  async stagedFingerprint() {
    return `${this.diffText}:${this.statusText}`;
  }
  async worktreeFingerprintExcept() {
    return this.worktreeFingerprintText;
  }
  async restoreWorktreeFromIndexExcept() {
    this.restoredFromIndex++;
    this.worktreeFingerprintText = "worktree";
  }
  async restoreStagedPatch(patch: string) {
    this.restoredPatches.push(patch);
    this.worktreeFingerprintText = "worktree";
  }
  async commit(message: string): Promise<CommandResult> {
    this.commits.push(message);
    return { command: "git commit", exitCode: 0, stdout: "", stderr: "" };
  }
  async reset() {}
}

class FakeSubagents implements SubagentClient {
  spawns: SpawnArgs[] = [];
  results: SubagentResult[] = [];

  async spawn(args: SpawnArgs) {
    this.spawns.push(args);
    return `agent-${this.spawns.length}`;
  }
  async stop() {}
  async waitFor() {
    const result = this.results.shift();
    if (!result) {
      throw new Error("missing fake result");
    }
    return result;
  }
}

describe("runImplementation", () => {
  it("implements, reviews, marks, and commits one task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result:
          '<pi-implement-result>{"summary":"done","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"feat: do thing"}</pi-implement-result>',
      },
      {
        status: "completed",
        result: '<pi-review-result>{"verdict":"approved"}</pi-review-result>',
      },
    ];
    const states: Partial<RunState>[] = [];

    await runImplementation({
      git,
      subagents,
      planPath,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: (state) => states.push(state),
      shouldStop: () => false,
    });

    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
    expect(git.commits).toEqual(["feat: do thing"]);
    expect(subagents.spawns.map((spawn) => spawn.type)).toEqual([
      "general-purpose",
      "general-purpose",
    ]);
    expect(states.at(-1)).toMatchObject({ phase: "done" });
  });

  it("does not spawn planner in serial mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result:
          '<pi-implement-result>{"summary":"done","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"feat: do thing"}</pi-implement-result>',
      },
      {
        status: "completed",
        result: '<pi-review-result>{"verdict":"approved"}</pi-review-result>',
      },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(2);
    expect(subagents.spawns.map((s) => s.type)).not.toContain("Explore");
  });

  it("tracks reviewer requests separately from system failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const implementation =
      '<pi-implement-result>{"summary":"done","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"fix: do thing"}</pi-implement-result>';
    subagents.results = [
      { status: "completed", result: "not json" },
      { status: "completed", result: implementation },
      {
        status: "completed",
        result:
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it"]}</pi-review-result>',
      },
      { status: "completed", result: implementation },
      {
        status: "completed",
        result:
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it again"]}</pi-review-result>',
      },
      { status: "completed", result: implementation },
      {
        status: "completed",
        result: '<pi-review-result>{"verdict":"approved"}</pi-review-result>',
      },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(git.commits).toEqual(["fix: do thing"]);
    expect(subagents.spawns).toHaveLength(7);
  });
});
