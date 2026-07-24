import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileExecutionPlan,
  type ExecutionPlan,
} from "./execution-plan-vnext.js";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";
import {
  checkoutPaths,
  createPlanningRun,
  sourceIdentityForExecutionPlan,
  type CheckoutLeaseCapability,
  type VNextRunStore,
} from "./vnext-store.js";
import {
  reduceVNextRunEvent,
  selectReadyWorkstreams,
  VNextSchedulerActor,
} from "./scheduler-vnext.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function plannerTask(
  id: string,
  planIndex: number,
  title: string,
  path: string,
  dependsOn: string[] = [],
) {
  return {
    id,
    planIndex,
    title,
    dependsOn,
    provenance: [{ path, quote: title }],
    compiledContract: {
      objective: `Implement ${title}.`,
      inScope: ["Required behavior"],
      acceptanceCriteria: ["Observable behavior works"],
      outOfScope: ["Unrelated changes"],
    },
  };
}

function planFor(directory: string, concurrency = 1): ExecutionPlan {
  const planPath = join(directory, "plan.md");
  const content = "# Plan\n\n## Tasks\n\n- [ ] First task\n- [ ] Second task\n";
  writeFileSync(planPath, content);
  const plan = parsePlan(planPath, content);
  const materialStore = buildMaterialStore({
    plan,
    planPath,
    repoRoot: directory,
  });
  const result = compileExecutionPlan(
    {
      version: 1,
      plannerReason: "The tasks are ordered.",
      plannerConfidence: "high",
      tasks: [
        plannerTask("first", 1, "First task", planPath),
        plannerTask("second", 2, "Second task", planPath, ["first"]),
      ],
      workstreams: [
        {
          id: "first-stream",
          taskIds: ["first"],
          dependsOn: [],
          rationale: "First change establishes the required base.",
          risk: "normal",
        },
        {
          id: "second-stream",
          taskIds: ["second"],
          dependsOn: ["first-stream"],
          rationale: "Second change depends on the first change.",
          risk: "normal",
        },
      ],
    },
    {
      plan,
      planHash: sha256(content),
      materialStore,
      checkoutId: join(directory, ".git"),
      baseSha: "base-sha",
      workerConcurrency: concurrency,
    },
  );
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.value;
}

function fakeLease(directory: string): CheckoutLeaseCapability {
  const paths = checkoutPaths(directory);
  return {
    paths,
    owner: {
      runId: "run-1",
      runPath: join(paths.runs, "run-1"),
      checkoutRoot: directory,
      gitDir: join(directory, ".git"),
      pid: process.pid,
      hostname: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
    assertOwned() {},
    async release() {},
  };
}

async function store(concurrency = 1): Promise<VNextRunStore> {
  const directory = mkdtempSync(
    join(tmpdir(), "pi-implement-vnext-scheduler-"),
  );
  const plan = planFor(directory, concurrency);
  const lease = fakeLease(directory);
  const run = createPlanningRun({
    lease,
    runId: "run-1",
    checkout: {
      root: directory,
      gitDir: join(directory, ".git"),
      commonGitDir: join(directory, ".git"),
      branchRef: "refs/heads/main",
      startHead: "base-sha",
    },
    source: sourceIdentityForExecutionPlan(plan),
    workerConcurrency: concurrency,
  });
  await run.bindExecutionPlan(plan);
  return run;
}

describe("VNext scheduler reducer", () => {
  it("selects only dependency-ready workstreams within the persisted capacity", async () => {
    const run = await store(1);
    const initial = run.read();

    expect(selectReadyWorkstreams(initial)).toEqual(["first-stream"]);
    const selected = reduceVNextRunEvent(initial, {
      kind: "workstreams_selected",
      now: "now",
    });

    expect(selected.accepted).toBe(true);
    expect(selected.effects).toEqual([
      {
        kind: "run_implementation",
        workstream: { kind: "source", id: "first-stream" },
        leaseId: "implementation:run-1:2:0",
      },
    ]);
    expect(selectReadyWorkstreams(selected.state)).toEqual([]);

    selected.state.processLeases = {};
    selected.state.workstreams.source["first-stream"]!.phase = "completed";
    expect(selectReadyWorkstreams(selected.state)).toEqual(["second-stream"]);
  });

  it("rejects a stale process result without changing canonical state", async () => {
    const initial = (await store()).read();
    const result = reduceVNextRunEvent(initial, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "missing",
      outcome: "approved",
    });

    expect(result).toMatchObject({ accepted: false, state: initial });
  });

  it("permits an overall repair only in whole-plan review after source completion", async () => {
    const initial = (await store()).read();
    initial.workstreams.source["first-stream"]!.phase = "completed";
    initial.workstreams.source["second-stream"]!.phase = "completed";
    const review = reduceVNextRunEvent(initial, {
      kind: "whole_plan_review_requested",
    });
    const repair = reduceVNextRunEvent(review.state, {
      kind: "overall_repair_queued",
      repairId: "overall-repair-1",
    });

    expect(repair.accepted).toBe(true);
    expect(repair.state.workstreams.overall).toEqual({
      "overall-repair-1": {
        kind: "overall",
        repairId: "overall-repair-1",
        phase: "queued",
      },
    });
  });
});

describe("VNext scheduler actor", () => {
  it("persists a lease before its effect and ignores a throwing projection callback", async () => {
    const run = await store();
    const seenLeases: string[][] = [];
    const actor = new VNextSchedulerActor({
      store: run,
      onTransition: () => {
        throw new Error("status sink failed");
      },
      executeEffect: async ({ effect, dispatch }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        seenLeases.push(Object.keys(run.read().processLeases));
        await dispatch({
          kind: "implementation_completed",
          workstream: effect.workstream,
          leaseId: effect.leaseId,
          outcome: {
            kind: "satisfaction_claimed",
            evidence: {
              first: "Repository state already provides this behavior.",
            },
          },
        });
      },
    });

    await actor.start();
    await actor.settle();

    expect(seenLeases).toEqual([["implementation:run-1:2:0"]]);
    expect(run.read().workstreams.source["first-stream"]?.phase).toBe(
      "candidate_ready",
    );
    expect(run.read().processLeases).toEqual({});
  });

  it("aborts, settles, and pauses with retained workstreams requeued", async () => {
    const run = await store();
    let aborted = false;
    const actor = new VNextSchedulerActor({
      store: run,
      executeEffect: async ({ effect, signal }) => {
        if (effect.kind !== "run_implementation") {
          return;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    await actor.start();
    await actor.stop("operator stopped the run");

    expect(aborted).toBe(true);
    expect(run.read()).toMatchObject({
      phase: "paused",
      workstreams: { source: { "first-stream": { phase: "queued" } } },
      processLeases: {},
    });
  });

  it("settles a planner before pausing an unbound planning run", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "pi-implement-vnext-planner-"),
    );
    const plan = planFor(directory);
    const run = createPlanningRun({
      lease: fakeLease(directory),
      runId: "run-1",
      checkout: {
        root: directory,
        gitDir: join(directory, ".git"),
        commonGitDir: join(directory, ".git"),
        branchRef: "refs/heads/main",
        startHead: "base-sha",
      },
      source: sourceIdentityForExecutionPlan(plan),
      workerConcurrency: 1,
    });
    let aborted = false;
    const actor = new VNextSchedulerActor({
      store: run,
      executePlanner: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return plan;
      },
    });

    await actor.start();
    await actor.stop("operator stopped planning");

    expect(aborted).toBe(true);
    expect(run.read()).toMatchObject({
      phase: "paused",
      pause: { resumePhase: "planning", reason: "operator stopped planning" },
    });
    expect(run.read().executionPlan).toBeUndefined();
  });

  it("reconciles abandoned review leases without discarding their candidate", async () => {
    const run = await store();
    const selected = reduceVNextRunEvent(run.read(), {
      kind: "workstreams_selected",
      now: "now",
    });
    const effect = selected.effects.find(
      (effect) => effect.kind === "run_implementation",
    );
    if (!effect) {
      throw new Error("Expected implementation effect.");
    }
    const leaseId = effect.leaseId;
    const candidate = {
      id: "candidate-1",
      workstream: { kind: "source" as const, id: "first-stream" },
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
    };
    const completed = reduceVNextRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate,
        checkpoints: { first: "commit" },
      },
    });
    const reviewing = reduceVNextRunEvent(completed.state, {
      kind: "review_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "now",
    });
    const revision = run.read().revision;
    await run.update(revision, () => reviewing.state);

    const actor = new VNextSchedulerActor({ store: run });
    await actor.start();

    expect(run.read()).toMatchObject({
      candidates: { "candidate-1": candidate },
      workstreams: { source: { "first-stream": { phase: "candidate_ready" } } },
      processLeases: {},
    });
  });
});
