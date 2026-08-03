import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { formatStatus } from "./controls.js";
import { checkoutPaths } from "./store.js";
import {
  createLifecycleFixture,
  type LifecycleFixture,
} from "./lifecycle-test-support.js";
import {
  boundOutput,
  formatRunList,
  inspectImplementRun,
  registerImplementInspectionTool,
} from "./inspection-tool.js";

const fixtures: LifecycleFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.dispose();
  }
});

async function fixture(): Promise<LifecycleFixture> {
  const value = await createLifecycleFixture();
  fixtures.push(value);
  return value;
}

function copyRun(
  root: string,
  sourceRunId: string,
  runId: string,
  phase: "running" | "failed",
  updatedAt: string,
): void {
  const paths = checkoutPaths(root);
  const source = join(paths.runs, sourceRunId);
  const destination = join(paths.runs, runId);
  cpSync(source, destination, { recursive: true });
  const statePath = join(destination, "run-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.run.id = runId;
  state.executionPlan.path = join(destination, "execution-plan.json");
  state.phase = phase;
  state.updatedAt = updatedAt;
  if (phase === "failed") {
    state.failure = {
      category: "runtime",
      reason: "Worker stopped",
      originPhase: "running",
      at: updatedAt,
    };
  }
  writeFileSync(statePath, JSON.stringify(state));
}

function inspectionTool(): any {
  let definition: unknown;
  registerImplementInspectionTool({
    registerTool: (tool: unknown) => {
      definition = tool;
    },
  } as never);
  return definition;
}

describe("inspect_implement_run", () => {
  it("lists valid retained runs with phases and timestamps", async () => {
    const run = await fixture();
    copyRun(
      run.root,
      "run-1",
      "failed-1",
      "failed",
      "2026-02-02T00:00:00.000Z",
    );

    expect(formatRunList(run.root)).toContain("run-1 · running · updated ");
    expect(formatRunList(run.root)).toContain(
      "failed-1 · failed · updated 2026-02-02T00:00:00.000Z",
    );
  });

  it("reports an empty checkout clearly", () => {
    expect(formatRunList("/tmp/pipkin-implement-empty")).toBe(
      "Implement: no retained runs in this checkout.",
    );
  });

  it("keeps historical artifacts visible alongside valid runs", async () => {
    const run = await fixture();
    const historical = join(checkoutPaths(run.root).runs, "old-run");
    mkdirSync(historical);
    writeFileSync(join(historical, "run-state.json"), "old state");

    expect(formatRunList(run.root)).toContain(
      "old-run · historical artifact (manual inspection/removal only)",
    );
    expect(formatRunList(run.root)).toContain("run-1 · running");
  });

  it("returns detailed status and durable paths for one run", async () => {
    const run = await fixture();
    const paths = checkoutPaths(run.root);
    const worktree = join(paths.worktrees, "run-1");
    mkdirSync(worktree, { recursive: true });

    const result = inspectImplementRun(run.root, { runId: "run-1" });
    const text = result.content[0].text;

    expect(text).toContain("Run: run-1");
    expect(text).toContain(
      `State: ${join(paths.runs, "run-1", "run-state.json")}`,
    );
    expect(text).toContain(
      `Execution plan: ${join(paths.runs, "run-1", "execution-plan.json")}`,
    );
    expect(text).toContain(
      `Source corpus: ${join(paths.runs, "run-1", "source-corpus.json")}`,
    );
    expect(text).toContain(
      `Artifacts: ${join(paths.runs, "run-1", "artifacts")}`,
    );
    expect(text).toContain(`Retained worktree: ${worktree}`);
    expect(result.details).toEqual({
      checkoutRoot: run.root,
      runId: "run-1",
      truncated: false,
    });
  });

  it("structures finding evidence without changing its content", async () => {
    const run = await fixture();
    const state = run.store.read();
    state.findings["finding-1"] = {
      id: "finding-1",
      candidateId: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      scope: { kind: "source", id: "first-stream" },
      summary: "Finding summary",
      evidence: "Detailed finding evidence",
      requiredChange: "Required change",
      acceptanceCriteria: ["Expected behavior"],
      origin: "initial",
      introducedRound: 1,
      status: "open",
    };

    const text = formatStatus(state);

    expect(text).toContain("Workstreams:\n- first-stream:");
    expect(text).toContain(
      "Open findings: 1\n- finding-1: Detailed finding evidence",
    );
  });

  it("renders a quiet collapsed row and the canonical result when expanded", async () => {
    const run = await fixture();
    const tool = inspectionTool();
    const result = inspectImplementRun(run.root, { runId: "run-1" });
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };

    expect(
      tool
        .renderCall({ runId: "run-1" }, theme, {})
        .render(200)
        .map((line: string) => line.trimEnd())
        .join("\n"),
    ).toBe("inspect_implement_run run-1");
    expect(
      tool
        .renderResult(result, { expanded: false, isPartial: false }, theme, {
          isError: false,
        })
        .render(200),
    ).toEqual([]);
    expect(
      tool
        .renderResult(result, { expanded: true, isPartial: false }, theme, {
          isError: false,
        })
        .render(20_000)
        .map((line: string) => line.trimEnd())
        .join("\n"),
    ).toBe(result.content[0].text);
  });

  it("keeps inspection errors visible while collapsed", () => {
    const tool = inspectionTool();
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const text = tool
      .renderResult(
        {
          content: [
            { type: "text", text: "Run is unavailable or historical." },
          ],
        },
        { expanded: false, isPartial: false },
        theme,
        { isError: true },
      )
      .render(200)
      .map((line: string) => line.trimEnd())
      .join("\n");

    expect(text).toBe("Run is unavailable or historical.");
  });

  it("rejects symlinked retained runs through durable validation", async () => {
    const run = await fixture();
    const paths = checkoutPaths(run.root);
    const runPath = join(paths.runs, "run-1");
    const target = join(run.root, "other-run");
    cpSync(runPath, target, { recursive: true });
    rmSync(runPath, { recursive: true });
    symlinkSync(target, runPath);

    expect(() => inspectImplementRun(run.root, { runId: "run-1" })).toThrow(
      "symlinked",
    );
  });

  it("bounds output and directs the agent to authoritative durable state", () => {
    const path = "/checkout/.pi/pipkin/implement/runs/run-1/run-state.json";
    const result = boundOutput(`${"x".repeat(30)}\n`.repeat(3_000), path);

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
    expect(result.text.split("\n").length).toBeLessThanOrEqual(
      DEFAULT_MAX_LINES,
    );
    expect(result).toMatchObject({ truncated: true });
    expect(result.text).toContain(`Read ${path}`);
  });

  it("resolves the checkout root from the invoking cwd", async () => {
    const run = await fixture();
    rmSync(join(run.root, ".pi"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: run.root });
    const nested = join(run.root, "nested", "directory");
    mkdirSync(nested, { recursive: true });
    const tool = inspectionTool();

    const result = await tool.execute("tool-call", {}, undefined, undefined, {
      cwd: nested,
    });

    expect(tool.name).toBe("inspect_implement_run");
    expect(tool.promptSnippet).toBe(
      "List and inspect durable Pipkin Implement runs in the current checkout.",
    );
    expect(tool.promptGuidelines).toEqual([
      expect.stringContaining("before searching `.pi/pipkin/implement`"),
    ]);
    expect(result.content[0].text).toBe(
      "Implement: no retained runs in this checkout.",
    );
    expect(result.details.checkoutRoot).toBe(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: nested,
        encoding: "utf8",
      }).trim(),
    );
  });
});
