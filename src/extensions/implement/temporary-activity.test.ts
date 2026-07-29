import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "./execution-plan.js";
import type { RunState } from "./store.js";
import {
  createTemporaryActivity,
  formatTemporaryActivity,
} from "./temporary-activity.js";

function state(): RunState {
  return {
    run: { id: "run-1" },
    phase: "running",
    tasks: {
      first: { workstreamId: "api", phase: "pending" },
      second: {
        workstreamId: "docs",
        phase: "published",
        evidence: "published",
      },
    },
    workstreams: {
      source: {
        api: {
          kind: "source",
          id: "api",
          taskIds: ["first"],
          dependsOn: [],
          phase: "recovering",
        },
        docs: {
          kind: "source",
          id: "docs",
          taskIds: ["second"],
          dependsOn: [],
          phase: "completed",
        },
      },
      overall: {},
    },
    gates: [
      {
        id: "environment:api:1",
        kind: "environment",
        workstream: { kind: "source", id: "api" },
        attempt: 1,
        outcome: "failed",
        evidence: "The implementation tests timed out.",
        outstandingFindingIds: [],
      },
    ],
    findings: {
      finding: {
        id: "finding",
        candidateId: "candidate",
        workstream: { kind: "source", id: "api" },
        summary: "The endpoint still drops authentication errors.",
        evidence: "review.json",
        requiredChange: "Preserve authentication errors.",
        acceptanceCriteria: ["Errors are preserved."],
        origin: "initial",
        introducedRound: 1,
        status: "open",
      },
    },
    wholePlanReview: { status: "pending" },
    processLeases: {},
    recoveryEpisodes: {},
    reviews: {},
    candidates: {},
    satisfaction: { receipts: {}, assessments: {} },
    publication: { preparations: {}, intents: {}, receipts: {} },
    projectionDebt: [],
  } as unknown as RunState;
}

const plan = {
  tasks: [
    { id: "first", title: "Add the API endpoint" },
    { id: "second", title: "Update the documentation" },
  ],
} as ExecutionPlan;

describe("temporary pipkin-implement activity", () => {
  it("shows live task stages, progress, failures, and findings", () => {
    expect(formatTemporaryActivity(state(), plan)).toEqual([
      "implement run-1 · running · 1/2 published",
      "  recovering · api · Add the API endpoint",
      "    last failure · environment · The implementation tests timed out.",
      "    finding · The endpoint still drops authentication errors.",
      "  completed · docs · Update the documentation",
    ]);
  });

  it("shows planning before task identities are bound", () => {
    const planning = state();
    planning.phase = "planning";
    planning.tasks = {};
    planning.workstreams.source = {};

    expect(formatTemporaryActivity(planning)).toEqual([
      "implement run-1 · planning",
    ]);
  });

  it("strips terminal controls from repository and process text", () => {
    const unsafePlan = {
      ...plan,
      tasks: [
        {
          id: "first",
          title:
            "\u001b]8;;https://example.com\u0007Add endpoint\u001b]8;;\u0007\u001b[31m",
        },
      ],
    } as ExecutionPlan;
    const unsafe = state();
    delete unsafe.workstreams.source.docs;
    unsafe.tasks = { first: unsafe.tasks.first! };
    unsafe.gates[0]!.evidence = "failed\u0007\u001b[2J\nnow";

    expect(formatTemporaryActivity(unsafe, unsafePlan)).toEqual([
      "implement run-1 · running · 0/1 published",
      "  recovering · api · Add endpoint",
      "    last failure · environment · failed now",
      "    finding · The endpoint still drops authentication errors.",
    ]);
  });

  it("cannot be recreated by late transitions after it is cleared", () => {
    const widgets: unknown[] = [];
    const activity = createTemporaryActivity({
      mode: "tui",
      ui: {
        setWidget(_key: string, value: unknown) {
          widgets.push(value);
        },
        notify() {},
      },
    } as never);

    activity.update(state());
    activity.clear();
    activity.update(state(), { kind: "run_failed" });

    expect(widgets).toHaveLength(2);
    expect(widgets.at(-1)).toBeUndefined();
  });

  it("cannot interrupt orchestration when presentation methods throw", () => {
    const activity = createTemporaryActivity({
      mode: "tui",
      ui: {
        setWidget() {
          throw new Error("widget failed");
        },
        notify() {
          throw new Error("notification failed");
        },
      },
    } as never);

    expect(() => activity.starting("plan.md")).not.toThrow();
    expect(() =>
      activity.update(state(), {
        kind: "planner_failed",
        reason: "planner failed",
      }),
    ).not.toThrow();
    expect(() => activity.clear()).not.toThrow();
  });
});
