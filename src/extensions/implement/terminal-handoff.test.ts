import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stagingIdentity } from "./candidate-replay.js";
import { checkoutPaths, type RunState } from "./store.js";
import { renderTerminalHandoff } from "./terminal-handoff.js";
import {
  cleanupSchedulerStores,
  createUnboundSchedulerRun,
} from "./scheduler/scheduler-test-support.js";

afterEach(() => cleanupSchedulerStores());

describe("terminal handoff rendering", () => {
  it("appends a deterministic completed delivery receipt to the accepted draft", () => {
    const state = terminalState("completed");
    const draft = "Accepted reviewer handoff.\n\nIt remains opaque.";
    state.wholePlanReview = {
      status: "approved",
      handoffDraft: draft,
      reviewedTargetSha: "published-second",
      reviewedTargetTreeSha: "tree-second",
      evidence: "whole-plan verification passed",
      epoch: {
        initialTargetSha: "base-sha",
        initialTargetTreeSha: "base-tree",
        findingIds: [],
        pendingCorrectionIds: [],
      },
    };
    addPublishedSource(
      state,
      "first-stream",
      "candidate-first",
      "published-first",
      "2026-01-01T00:00:00.000Z",
    );
    addPublishedSource(
      state,
      "second-stream",
      "candidate-second",
      "published-second",
      "2026-01-01T00:01:00.000Z",
    );

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toMatch(
      /^Accepted reviewer handoff\.\n\nIt remains opaque\.\n\n## Delivery receipt/,
    );
    expect(handoff).toContain("- Run: `run-1`");
    expect(handoff).toContain(
      "- Published: `published-second` → `refs/heads/main`",
    );
    expect(handoff).toContain(
      "- Delivered workstreams: `first-stream`, `second-stream`",
    );
    expect(handoff).toContain("- Residual findings: None.");
    expect(handoff).toContain("`/implement inspect run-1`");
    expect(handoff).not.toContain("/worktrees/");
  });

  it("reports canonical open final findings in a completed receipt", () => {
    const state = terminalState("completed");
    state.wholePlanReview = {
      status: "approved",
      handoffDraft: "Accepted handoff.",
      reviewedTargetSha: "published-first",
      reviewedTargetTreeSha: "tree-first",
      evidence: "review evidence",
      epoch: {
        initialTargetSha: "base-sha",
        initialTargetTreeSha: "base-tree",
        findingIds: ["whole-open", "whole-resolved"],
        pendingCorrectionIds: [],
      },
    };
    addPublishedSource(
      state,
      "first-stream",
      "candidate-first",
      "published-first",
      "2026-01-01T00:00:00.000Z",
    );
    addFinding(state, "whole-open", "whole_plan", "open", "final issue");
    addFinding(
      state,
      "whole-resolved",
      "whole_plan",
      "resolved",
      "fixed issue",
    );

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toContain(
      "- Residual findings: 1 material finding retained.",
    );
    expect(handoff).not.toContain("whole-open");
    expect(handoff).not.toContain("whole-resolved");
  });

  it("summarizes incomplete delivery, causal failures, and findings without forensic bookkeeping", () => {
    const state = terminalState("incomplete");
    addPublishedSource(
      state,
      "first-stream",
      "candidate-first",
      "published-first",
      "2026-01-01T00:00:00.000Z",
    );
    state.workstreams.source["second-stream"]!.phase = "dependency_skipped";
    state.workstreams.source["first-stream"]!.phase = "failed";
    addFinding(state, "source-open", "source", "open", "source remains open");
    addFinding(
      state,
      "whole-open",
      "whole_plan",
      "open",
      "whole plan remains open",
    );
    state.failures["failure:protocol:first"] = {
      id: "failure:protocol:first",
      category: "protocol_failure",
      assignment: "operational_retry",
      workstream: { kind: "source", id: "first-stream" },
      evidence: "Earlier reviewer packet mismatch.",
      at: "2026-01-01T00:00:00.000Z",
    };
    state.failures["failure:protocol:second"] = {
      id: "failure:protocol:second",
      category: "protocol_failure",
      assignment: "operational_retry",
      workstream: { kind: "source", id: "first-stream" },
      evidence: "Earlier reviewer packet mismatch.",
      at: "2026-01-01T00:01:00.000Z",
    };
    state.failures["failure:first"] = {
      id: "failure:first",
      category: "provider_failure",
      assignment: "blocked",
      workstream: { kind: "source", id: "first-stream" },
      evidence: "provider exhausted",
      at: "2026-01-01T00:02:00.000Z",
    };
    state.failures["failure:skipped"] = {
      id: "failure:skipped",
      category: "dependency_skipped",
      assignment: "dependency_skip",
      workstream: { kind: "source", id: "second-stream" },
      evidence: "first-stream was unavailable",
      at: "2026-01-01T00:03:00.000Z",
    };

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toContain("## Run outcome");
    expect(handoff).toContain(
      "Primary blocker: `first-stream` — provider exhausted",
    );
    expect(handoff).toContain("- Delivered: `first-stream`");
    expect(handoff).toContain("- Failed: None.");
    expect(handoff).toContain("- Dependency-skipped: `second-stream`");
    expect(handoff).toContain(
      "Open finding in `first-stream`: source remains open",
    );
    expect(handoff).toContain(
      "Open finding in `first-stream`: whole plan remains open",
    );
    expect(handoff).not.toContain("failure:first");
    expect(handoff).not.toContain("Earlier reviewer packet mismatch");
    expect(handoff).not.toContain("first-stream was unavailable");
    expect(handoff).not.toContain("/worktrees/run-1/first-stream");
    expect(handoff).toContain("`/implement inspect run-1`");
    expect(handoff).toContain("`/implement cleanup run-1`");
  });

  it("renders failed interruption with explicit uncertainty and no guessed publication", () => {
    const state = terminalState("failed");
    state.failure = {
      category: "interrupted",
      reason: "Actor stopped while retained resources were still owned.",
      originPhase: "running",
      at: "2026-01-01T00:00:00.000Z",
    };
    state.failures["failure:publication"] = {
      id: "failure:publication",
      category: "publication_uncertain",
      assignment: "blocked",
      workstream: { kind: "source", id: "first-stream" },
      evidence: "Target ref outcome was not observed.",
      at: "2026-01-01T00:01:00.000Z",
    };

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toContain("The run failed.");
    expect(handoff).toContain(
      "Actor stopped while retained resources were still owned.",
    );
    expect(handoff).toContain(
      "- Last proven published head: `base-sha (no ref advancement is proven)`",
    );
    expect(handoff).toContain(
      "`first-stream`: Target ref outcome was not observed.",
    );
    expect(handoff).toContain("/implement inspect run-1");
    expect(handoff).toContain("/implement cleanup run-1");
  });

  it("uses durable intent history rather than receipt timestamps for retained heads", () => {
    const state = terminalState("incomplete");
    state.publication.intents["intent-receipt"] = publicationIntent(
      "intent-receipt",
      "base-sha",
    );
    state.publication.receipts["intent-receipt"] = {
      operationId: "operation-receipt",
      intentId: "intent-receipt",
      candidateId: "candidate-first",
      targetBaseSha: "base-sha",
      publishedCommitSha: "published-first",
      publishedTreeSha: "tree-published-first",
      targetRef: "refs/heads/main",
      protectedArtifactHashes: {},
      publishedAt: "2099-01-01T00:00:00.000Z",
    };
    state.publication.intents["intent-superseded"] = publicationIntent(
      "intent-superseded",
      "published-first",
    );
    state.publication.supersessions["intent-superseded"] = {
      intentId: "intent-superseded",
      publicationOperationId: "operation-superseded",
      preparationOperationId: "preparation-superseded",
      workstream: { kind: "source", id: "first-stream" },
      candidateId: "candidate-first",
      preparationId: "preparation-superseded",
      targetRef: "refs/heads/main",
      expectedTargetSha: "published-first",
      actualTargetSha: "superseded-head",
      supersededAt: "2000-01-01T00:00:00.000Z",
    };
    state.publication.intents["intent-abandoned"] = publicationIntent(
      "intent-abandoned",
      "superseded-head",
    );
    state.publication.abandonments["intent-abandoned"] = {
      intentId: "intent-abandoned",
      publicationOperationId: "operation-abandoned",
      preparationOperationId: "preparation-abandoned",
      workstream: { kind: "source", id: "first-stream" },
      candidateId: "candidate-first",
      preparationId: "preparation-abandoned",
      targetRef: "refs/heads/main",
      targetBaseSha: "superseded-head",
      evidence: "publication was not attempted",
      abandonedAt: "1999-01-01T00:00:00.000Z",
    };
    state.publication.intents["intent-unresolved"] = publicationIntent(
      "intent-unresolved",
      "superseded-head",
    );

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toContain("- Branch: `refs/heads/main`");
    expect(handoff).toContain(
      "- Last proven published head: `superseded-head`",
    );
    expect(handoff).toContain(
      "Not verified: The outcome of 1 publication attempt is uncertain.",
    );
  });

  it("uses a supersession head even when no receipt was retained", () => {
    const state = terminalState("failed");
    state.publication.intents["intent-superseded"] = publicationIntent(
      "intent-superseded",
      "base-sha",
    );
    state.publication.supersessions["intent-superseded"] = {
      intentId: "intent-superseded",
      publicationOperationId: "operation-superseded",
      preparationOperationId: "preparation-superseded",
      workstream: { kind: "source", id: "first-stream" },
      candidateId: "candidate-first",
      preparationId: "preparation-superseded",
      targetRef: "refs/heads/main",
      expectedTargetSha: "base-sha",
      actualTargetSha: "superseded-head",
      supersededAt: "1999-01-01T00:00:00.000Z",
    };

    expect(renderTerminalHandoff(state)).toContain(
      "- Last proven published head: `superseded-head`",
    );
  });

  it("treats a satisfaction receipt as delivery without a publication receipt", () => {
    const state = terminalState("incomplete");
    state.satisfaction.receipts["satisfaction:first"] = {
      id: "satisfaction:first",
      candidateId: "unchanged-first",
      workstream: { kind: "source", id: "first-stream" },
      assessedTargetSha: "base-sha",
      evidence: "target already satisfies the workstream",
      assessedAt: "2026-01-01T00:00:00.000Z",
    };

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toContain("- Delivered: `first-stream`");
    expect(handoff).toContain(
      "- Last proven published head: `base-sha (no ref advancement is proven)`",
    );
  });

  it("reports undelivered workstreams without exposing retained candidate identities", () => {
    const state = terminalState("incomplete");
    addPublishedSource(
      state,
      "first-stream",
      "candidate-published",
      "published-first",
      "2026-01-01T00:00:00.000Z",
    );
    state.candidates["candidate-unpublished"] = {
      id: "candidate-unpublished",
      workstream: { kind: "source", id: "second-stream" },
      baseSha: "published-first",
      commitSha: "candidate-second",
      treeSha: "tree-candidate-second",
    };
    state.workstreams.source["second-stream"]!.phase = "candidate_ready";
    state.workstreams.source["second-stream"]!.candidateId =
      "candidate-unpublished";

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toContain("- Delivered: `first-stream`");
    expect(handoff).toContain("- Not delivered: `second-stream`");
    expect(handoff).not.toContain("candidate-unpublished");
    expect(handoff).not.toContain("candidate-published");
  });

  it("reports exhausted whole-plan review retries as the incomplete terminal blocker", () => {
    const state = terminalState("incomplete");
    state.wholePlanReview.reviewRetry = {
      attempts: 3,
      status: "exhausted",
      evidence: ["third retry failed", "first retry failed"],
    };

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toContain(
      "Whole-plan review could not complete after 3 attempts.",
    );
    expect(handoff).toContain(
      "Whole-plan review exhausted 3 attempts: first retry failed",
    );
    expect(handoff).not.toContain("third retry failed");
  });

  it("hides cleanup-owned workspace locations behind durable inspection", () => {
    const state = terminalState("incomplete");
    state.candidates["candidate-first"] = candidate("candidate-first");
    state.candidates["candidate-history"] = candidate("candidate-history");
    state.publication.preparations["preparation-first"] = {
      id: "preparation-first",
      operationId: "operation-publication",
      candidateId: "candidate-first",
      candidateCommitSha: "commit-candidate-first",
      candidateTreeSha: "tree-candidate-first",
      targetBaseSha: "base-sha",
      targetRef: "refs/heads/main",
      preparedCommitSha: "prepared-sha",
      preparedTreeSha: "prepared-tree",
      stagingWorktree: "/retained/publication-staging",
      stagingBranch: "pipkin/implement/run-1/publication-staging",
      replayPatchHash: "a".repeat(64),
      changedPaths: ["src/example.ts"],
      disposition: "same_base",
      hookEvidence: "hook passed",
      hookCommand: {
        command: "npm run check",
        cwd: "/retained",
        timedOut: false,
        output: "passed",
      },
    };
    state.satisfaction.assessments["assessment-first"] = {
      id: "assessment-first",
      candidateId: "candidate-first",
      workstream: { kind: "source", id: "first-stream" },
      historicalBaseSha: "base-sha",
      targetSha: "base-sha",
      operationId: "operation-satisfaction",
      evidence: "assessment retained",
      status: "pending",
    };
    const satisfaction = stagingIdentity({
      runId: state.run.id,
      operationId: "operation-satisfaction",
      candidateId: "candidate-first",
      candidateCommitSha: "commit-candidate-first",
      candidateTreeSha: "tree-candidate-first",
      targetBaseSha: "base-sha",
      targetRef: "refs/heads/main",
    });
    const candidatePath = join(
      checkoutPaths(state.run.checkout.root).worktrees,
      state.run.id,
      "first-stream",
    );
    const satisfactionPath = join(
      checkoutPaths(state.run.checkout.root).worktrees,
      state.run.id,
      satisfaction.id,
    );

    const handoff = renderTerminalHandoff(state);

    expect(handoff).not.toContain(candidatePath);
    expect(handoff).not.toContain("/retained/publication-staging");
    expect(handoff).not.toContain(satisfactionPath);
    expect(handoff).toContain(
      "Detailed evidence and owned resources remain retained",
    );
    expect(handoff).toContain("`/implement inspect run-1`");
  });

  it("redacts released workspace paths from completed deterministic excerpts", () => {
    const state = terminalState("completed");
    const candidatePath = join(
      checkoutPaths(state.run.checkout.root).worktrees,
      state.run.id,
      "first-stream",
    );
    state.wholePlanReview = {
      status: "approved",
      handoffDraft: "Accepted handoff.",
      reviewedTargetSha: "published-first",
      reviewedTargetTreeSha: "tree-first",
      evidence: `whole-plan evidence at ${candidatePath}`,
      epoch: {
        initialTargetSha: "base-sha",
        initialTargetTreeSha: "base-tree",
        findingIds: ["whole-open"],
        pendingCorrectionIds: [],
      },
    };
    state.candidates["candidate-first"] = {
      ...candidate("candidate-first"),
      implementationEvidence: {
        summary: "implemented",
        verification: [`npm run check in ${candidatePath}`, "passed"],
      },
    };
    state.publication.preparations["preparation-first"] = {
      id: "preparation-first",
      operationId: "operation-publication",
      candidateId: "candidate-first",
      candidateCommitSha: "commit-candidate-first",
      candidateTreeSha: "tree-candidate-first",
      targetBaseSha: "base-sha",
      targetRef: "refs/heads/main",
      preparedCommitSha: "prepared-sha",
      preparedTreeSha: "prepared-tree",
      stagingWorktree: "/released/publication-staging",
      stagingBranch: "pipkin/implement/run-1/publication-staging",
      replayPatchHash: "a".repeat(64),
      changedPaths: ["src/example.ts"],
      disposition: "same_base",
      hookEvidence: "hook passed",
      hookCommand: {
        command: "npm run check",
        cwd: "/released",
        timedOut: false,
        output: "passed",
      },
    };
    state.satisfaction.assessments["assessment-first"] = {
      id: "assessment-first",
      candidateId: "candidate-first",
      workstream: { kind: "source", id: "first-stream" },
      historicalBaseSha: "base-sha",
      targetSha: "base-sha",
      operationId: "operation-satisfaction",
      evidence: "assessment retained",
      status: "approved",
    };
    const satisfaction = stagingIdentity({
      runId: state.run.id,
      operationId: "operation-satisfaction",
      candidateId: "candidate-first",
      candidateCommitSha: "commit-candidate-first",
      candidateTreeSha: "tree-candidate-first",
      targetBaseSha: "base-sha",
      targetRef: "refs/heads/main",
    });
    const satisfactionPath = join(
      checkoutPaths(state.run.checkout.root).worktrees,
      state.run.id,
      satisfaction.id,
    );
    addFinding(
      state,
      "whole-open",
      "whole_plan",
      "open",
      `finding retained ${candidatePath} /released/publication-staging ${satisfactionPath}`,
    );

    const handoff = renderTerminalHandoff(state);

    expect(handoff.startsWith("Accepted handoff.\n\n## Delivery receipt")).toBe(
      true,
    );
    expect(handoff).not.toContain("passed");
    expect(handoff).not.toContain("[released workspace]");
    expect(handoff).not.toContain(candidatePath);
    expect(handoff).not.toContain("/released/publication-staging");
    expect(handoff).not.toContain(satisfactionPath);
  });

  it("orders durable receipts and findings independently of record insertion order", () => {
    const state = terminalState("incomplete");
    addPublishedSource(
      state,
      "second-stream",
      "candidate-second",
      "published-second",
      "2026-01-01T00:01:00.000Z",
    );
    addPublishedSource(
      state,
      "first-stream",
      "candidate-first",
      "published-first",
      "2026-01-01T00:00:00.000Z",
    );
    addFinding(state, "source-z", "source", "open", "later by id");
    addFinding(state, "source-a", "source", "open", "earlier by id");

    const handoff = renderTerminalHandoff(state);

    expect(handoff).toContain(
      "- Last proven published head: `published-second`",
    );
    expect(handoff.indexOf("`first-stream`, `second-stream`")).toBeGreaterThan(
      -1,
    );
    expect(handoff.indexOf("earlier by id")).toBeLessThan(
      handoff.indexOf("later by id"),
    );
  });

  it("is deterministic and bounds long retained prose, evidence, and lists", () => {
    const state = terminalState("incomplete");
    const long = "e".repeat(2_000);
    for (let index = 0; index < 8; index += 1) {
      addFinding(
        state,
        `source-${index}`,
        "source",
        "open",
        `${index}-${long}`,
      );
      state.candidates[`candidate-${index}`] = {
        id: `candidate-${index}`,
        workstream: { kind: "source", id: "first-stream" },
        baseSha: "base-sha",
        commitSha: `commit-${index}`,
        treeSha: `tree-${index}`,
        implementationEvidence: {
          summary: long,
          verification: [long],
          uncertainty: long,
        },
      };
    }

    const before = JSON.stringify(state);
    const first = renderTerminalHandoff(state);
    const second = renderTerminalHandoff(state);

    expect(first).toBe(second);
    expect(JSON.stringify(state)).toBe(before);
    expect(first).toContain("- Delivered: None.");
    expect(first.length).toBeLessThanOrEqual(12_000);
    expect(first).toContain("…");
    expect(first).not.toContain("candidate-0");
    expect(first).toContain("/implement inspect run-1");
    expect(first).toContain("/implement cleanup run-1");
  });
});

function terminalState(phase: "completed" | "incomplete" | "failed"): RunState {
  const { run } = createUnboundSchedulerRun();
  const state = structuredClone(run.read());
  state.workstreams.source = {
    "first-stream": {
      kind: "source",
      id: "first-stream",
      taskIds: ["first"],
      dependsOn: [],
      phase: "completed",
      baseSha: "base-sha",
    },
    "second-stream": {
      kind: "source",
      id: "second-stream",
      taskIds: ["second"],
      dependsOn: ["first-stream"],
      phase: "completed",
      baseSha: "base-sha",
    },
  };
  state.phase = phase;
  return state;
}

function candidate(id: string): RunState["candidates"][string] {
  return {
    id,
    workstream: { kind: "source", id: "first-stream" },
    baseSha: "base-sha",
    commitSha: `commit-${id}`,
    treeSha: `tree-${id}`,
  };
}

function publicationIntent(
  id: string,
  targetBaseSha: string,
): RunState["publication"]["intents"][string] {
  return {
    id,
    operationId: `operation-${id}`,
    workstream: { kind: "source", id: "first-stream" },
    candidateId: "candidate-first",
    preparationId: `preparation-${id}`,
    targetBaseSha,
    preparedCommitSha: `prepared-${id}`,
    preparedTreeSha: `tree-prepared-${id}`,
    targetRef: "refs/heads/main",
    protectedArtifactSnapshots: {},
    protectedArtifactHashes: {},
  };
}

function addPublishedSource(
  state: RunState,
  workstreamId: "first-stream" | "second-stream",
  candidateId: string,
  publishedCommitSha: string,
  publishedAt: string,
): void {
  state.candidates[candidateId] = {
    id: candidateId,
    workstream: { kind: "source", id: workstreamId },
    baseSha: "base-sha",
    commitSha: publishedCommitSha,
    treeSha: `tree-${publishedCommitSha}`,
    implementationEvidence: {
      summary: "Implemented the accepted workstream.",
      verification: ["npm run check"],
    },
  };
  state.publication.receipts[`receipt:${candidateId}`] = {
    operationId: `operation:${candidateId}`,
    intentId: `intent:${candidateId}`,
    candidateId,
    targetBaseSha: "base-sha",
    publishedCommitSha,
    publishedTreeSha: `tree-${publishedCommitSha}`,
    targetRef: "refs/heads/main",
    protectedArtifactHashes: state.protectedArtifactHashes,
    publishedAt,
  };
}

function addFinding(
  state: RunState,
  id: string,
  scope: "source" | "whole_plan",
  status: "open" | "resolved",
  summary: string,
): void {
  state.findings[id] = {
    id,
    candidateId: "candidate-first",
    workstream: { kind: "source", id: "first-stream" },
    scope:
      scope === "source"
        ? { kind: "source", id: "first-stream" }
        : {
            kind: "whole_plan",
            initialTargetSha: "base-sha",
            initialTargetTreeSha: "base-tree",
          },
    summary,
    evidence: `evidence for ${summary}`,
    requiredChange: "Fix the retained issue.",
    acceptanceCriteria: ["The issue is addressed."],
    origin: "initial",
    introducedRound: 0,
    status,
  };
}
