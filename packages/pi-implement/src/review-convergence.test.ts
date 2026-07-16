import { describe, expect, it } from "vitest";
import {
  applyAnchoredReview,
  applyNoopReview,
  createReviewConvergenceState,
  openRegressionReviewEpoch,
} from "./review-convergence.js";

const finding = (summary: string) => ({
  summary,
  evidence: `${summary} evidence`,
  requiredChange: `${summary} required change`,
  acceptanceCriteria: [`${summary} acceptance`],
});

const assessment = (id: string, status: "resolved" | "unresolved") => ({
  id,
  status,
  evidence: status,
});

const regression = (summary: string, changedPaths: string[]) => ({
  ...finding(summary),
  changedPaths,
  causalEvidence: "The latest edit caused this behavior.",
});

describe("review convergence", () => {
  it("allocates deterministic IDs and preserves unresolved finding contracts", () => {
    const state = createReviewConvergenceState({
      drafts: [finding("first"), finding("second")],
    });
    expect(state.findings.map((item) => item.id)).toEqual(["R1", "R2"]);
    const result = applyAnchoredReview({
      state,
      review: {
        assessments: [
          assessment("R1", "resolved"),
          assessment("R2", "unresolved"),
        ],
        regressions: [],
      },
      latestDeltaPaths: [],
    });
    expect(result.state.outstandingIds).toEqual(["R2"]);
    expect(result.state.findings[1]).toMatchObject({
      ...finding("second"),
      evidence: "unresolved",
    });
    expect(result.state.consecutiveStalledRounds).toBe(0);
  });

  it("assigns qualifying regressions new IDs and demotes unattributed concerns", () => {
    const state = createReviewConvergenceState({
      drafts: [finding("initial")],
    });
    const result = applyAnchoredReview({
      state,
      review: {
        assessments: [assessment("R1", "resolved")],
        regressions: [
          regression("qualified", ["src/changed.ts"]),
          regression("unattributed", ["src/old.ts"]),
        ],
      },
      latestDeltaPaths: ["src/changed.ts"],
    });
    expect(result.state.outstandingIds).toEqual(["R2"]);
    expect(result.state.findings.at(-1)).toMatchObject({
      id: "R2",
      summary: "qualified",
      origin: "regression",
    });
    expect(result.observations).toEqual([
      { summary: "unattributed", evidence: "unattributed evidence" },
    ]);
  });

  it("approves at zero and stalls after two rounds without a new low", () => {
    const state = createReviewConvergenceState({
      drafts: [finding("initial")],
    });
    const first = applyAnchoredReview({
      state,
      review: {
        assessments: [assessment("R1", "unresolved")],
        regressions: [],
      },
      latestDeltaPaths: [],
    });
    expect(first.outcome).toBe("continue");
    const second = applyAnchoredReview({
      state: first.state,
      review: {
        assessments: [assessment("R1", "unresolved")],
        regressions: [],
      },
      latestDeltaPaths: [],
    });
    expect(second.outcome).toBe("stalled");
    const approved = applyAnchoredReview({
      state,
      review: { assessments: [assessment("R1", "resolved")], regressions: [] },
      latestDeltaPaths: [],
    });
    expect(approved.outcome).toBe("approved");
  });

  it("counts replacement, increases, and ping-pong as stalled rounds", () => {
    const state = createReviewConvergenceState({
      drafts: [finding("initial")],
    });
    const replacement = applyAnchoredReview({
      state,
      review: {
        assessments: [assessment("R1", "resolved")],
        regressions: [regression("replacement", ["src/new.ts"])],
      },
      latestDeltaPaths: ["src/new.ts"],
    });
    expect(replacement.state.consecutiveStalledRounds).toBe(1);
    const increased = applyAnchoredReview({
      state: replacement.state,
      review: {
        assessments: [assessment("R2", "unresolved")],
        regressions: [regression("another", ["src/newer.ts"])],
      },
      latestDeltaPaths: ["src/newer.ts"],
    });
    expect(increased.outcome).toBe("stalled");
  });

  it("counts unchanged rework as a semantic stalled round without a review", () => {
    const state = createReviewConvergenceState({
      drafts: [finding("initial")],
    });
    const first = applyNoopReview(state);
    expect(first.outcome).toBe("continue");
    expect(first.state.round).toBe(1);
    const second = applyNoopReview(first.state);
    expect(second.outcome).toBe("stalled");
  });

  it("stalls when outstanding IDs ping-pong without reducing the low-water mark", () => {
    const state = createReviewConvergenceState({
      drafts: [finding("initial")],
    });
    const first = applyAnchoredReview({
      state,
      review: {
        assessments: [assessment("R1", "resolved")],
        regressions: [regression("regression", ["src/one.ts"])],
      },
      latestDeltaPaths: ["src/one.ts"],
    });
    const second = applyAnchoredReview({
      state: first.state,
      review: {
        assessments: [assessment("R2", "resolved")],
        regressions: [regression("initial again", ["src/two.ts"])],
      },
      latestDeltaPaths: ["src/two.ts"],
    });
    expect(second.state.outstandingIds).toEqual(["R3"]);
    expect(second.outcome).toBe("stalled");
  });

  it("opens a regression-only epoch after approval without reopening old IDs", () => {
    const initial = createReviewConvergenceState({
      drafts: [finding("initial")],
    });
    const approved = applyAnchoredReview({
      state: initial,
      review: { assessments: [assessment("R1", "resolved")], regressions: [] },
      latestDeltaPaths: [],
    });
    const epoch = openRegressionReviewEpoch({
      closedState: approved.state,
      regressions: [regression("later regression", ["src/api.ts"])],
      latestDeltaPaths: ["src/api.ts"],
    });
    expect(epoch.state.outstandingIds).toEqual(["R2"]);
    expect(epoch.state.findings[0]).toMatchObject({
      id: "R1",
      summary: "initial",
    });
    expect(epoch.state.bestOutstandingCount).toBe(1);
  });

  it("does not activate unattributed regressions when opening an epoch", () => {
    const initial = createReviewConvergenceState({
      drafts: [finding("initial")],
    });
    const approved = applyAnchoredReview({
      state: initial,
      review: { assessments: [assessment("R1", "resolved")], regressions: [] },
      latestDeltaPaths: [],
    });
    const epoch = openRegressionReviewEpoch({
      closedState: approved.state,
      regressions: [regression("old concern", ["src/old.ts"])],
      latestDeltaPaths: ["src/new.ts"],
    });

    expect(epoch.state.outstandingIds).toEqual([]);
    expect(epoch.observations).toEqual([
      { summary: "old concern", evidence: "old concern evidence" },
    ]);
  });

  it("rejects missing assessment coverage", () => {
    const state = createReviewConvergenceState({
      drafts: [finding("first"), finding("second")],
    });
    expect(() =>
      applyAnchoredReview({
        state,
        review: {
          assessments: [assessment("R1", "resolved")],
          regressions: [],
        },
        latestDeltaPaths: [],
      }),
    ).toThrow("omitted");
  });
});
