import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { buildRecoveryPacket } from "./recovery-packet.js";
import { RecoverySafetyError } from "./recovery-service.js";
import {
  reduceRunEvent,
  SchedulerActor,
  type SchedulerEvent,
} from "./scheduler.js";
import { RunStateSchema, type RunStore } from "./store.js";
import {
  createLifecycleFixture,
  type LifecycleFixture,
} from "./lifecycle-test-support.js";
import {
  buildWorkstreamPacket,
  workstreamWorkspace,
} from "./workstream-candidate.js";

type LifecycleModel = {
  selected: boolean;
  recovering: boolean;
  paused: boolean;
  providerFailures: number;
  revision: number;
};
type LifecycleReal = { fixture: LifecycleFixture; store: RunStore };

async function apply(
  real: LifecycleReal,
  event: SchedulerEvent,
): Promise<ReturnType<typeof reduceRunEvent>> {
  const current = real.store.read();
  const result = reduceRunEvent(current, event);
  if (result.accepted) {
    await real.store.update(current.revision, () => result.state);
  }
  return result;
}

function assertDurableState(real: LifecycleReal): void {
  const state = real.store.read();
  expect(RunStateSchema.safeParse(state).success).toBe(true);
  for (const lease of Object.values(state.processLeases)) {
    expect(lease.kind).toBe("implementation");
    if (lease.workstream.kind !== "source") {
      throw new Error("Lifecycle fixture only selects source workstreams.");
    }
    expect(state.workstreams.source[lease.workstream.id]?.phase).toBe(
      "implementing",
    );
  }
}

class SelectReadyWork implements fc.AsyncCommand<
  LifecycleModel,
  LifecycleReal
> {
  check(model: Readonly<LifecycleModel>): boolean {
    return !model.selected && !model.recovering && !model.paused;
  }

  async run(model: LifecycleModel, real: LifecycleReal): Promise<void> {
    const before = real.store.read();
    const result = await apply(real, {
      kind: "workstreams_selected",
      now: "2026-01-01T00:00:00.000Z",
      baseShas: { "first-stream": "base-sha" },
    });
    expect(result.accepted).toBe(true);
    const effect = result.effects[0];
    if (!effect || effect.kind !== "run_implementation") {
      throw new Error("Expected an implementation effect.");
    }
    if (effect.workstream.kind !== "source") {
      throw new Error("Expected a source implementation effect.");
    }
    const state = real.store.read();
    buildWorkstreamPacket({
      state,
      plan: real.fixture.plan,
      workstreamId: effect.workstream.id,
      workspace: workstreamWorkspace(state, effect.workstream.id),
    });
    model.selected = true;
    model.revision = before.revision + 1;
    expect(state.revision).toBe(model.revision);
    assertDurableState(real);
  }

  toString(): string {
    return "select-ready-work";
  }
}

class RejectStaleCompletion implements fc.AsyncCommand<
  LifecycleModel,
  LifecycleReal
> {
  check(model: Readonly<LifecycleModel>): boolean {
    return model.selected;
  }

  async run(model: LifecycleModel, real: LifecycleReal): Promise<void> {
    const before = real.store.read();
    const result = await apply(real, {
      kind: "implementation_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "stale-lease",
      outcome: {
        kind: "candidate_ready",
        candidate: {
          id: "stale-candidate",
          workstream: { kind: "source", id: "first-stream" },
          baseSha: "base-sha",
          commitSha: "stale-commit",
          treeSha: "stale-tree",
        },
        checkpoints: { first: "stale-commit" },
        satisfied: {},
      },
    });
    expect(result.accepted).toBe(false);
    expect(real.store.read().revision).toBe(before.revision);
    expect(model.revision).toBe(before.revision);
    assertDurableState(real);
  }

  toString(): string {
    return "reject-stale-completion";
  }
}

class FailImplementation implements fc.AsyncCommand<
  LifecycleModel,
  LifecycleReal
> {
  check(model: Readonly<LifecycleModel>): boolean {
    return model.selected && !model.recovering && !model.paused;
  }

  async run(model: LifecycleModel, real: LifecycleReal): Promise<void> {
    const before = real.store.read();
    const lease = Object.values(before.processLeases)[0];
    if (!lease || lease.workstream.kind !== "source") {
      throw new Error("Expected the selected source implementation lease.");
    }
    const result = await apply(real, {
      kind: "implementation_failed",
      workstream: lease.workstream,
      leaseId: lease.id,
      evidence: "provider interrupted before a candidate was retained",
    });
    expect(result.accepted).toBe(true);
    model.selected = false;
    model.recovering = true;
    model.revision = before.revision + 1;
    expect(real.store.read().revision).toBe(model.revision);
    expect(Object.values(real.store.read().recoveryEpisodes)).toHaveLength(1);
    assertDurableState(real);
  }

  toString(): string {
    return "fail-implementation";
  }
}

class FailRecoveryProvider implements fc.AsyncCommand<
  LifecycleModel,
  LifecycleReal
> {
  check(model: Readonly<LifecycleModel>): boolean {
    return model.recovering && !model.paused && model.providerFailures < 3;
  }

  async run(model: LifecycleModel, real: LifecycleReal): Promise<void> {
    const requested = await apply(real, {
      kind: "recovery_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:00:02.000Z",
    });
    const effect = requested.effects[0];
    if (!effect || effect.kind !== "run_recovery") {
      throw new Error("Expected a recovery effect.");
    }
    const failed = await apply(real, {
      kind: "recovery_provider_failed",
      workstream: effect.workstream,
      leaseId: effect.leaseId,
      error: "provider disconnected",
      now: "2026-01-01T00:00:03.000Z",
    });
    expect(failed.accepted).toBe(true);
    model.providerFailures += 1;
    model.revision += 2;
    if (model.providerFailures === 3) {
      model.paused = true;
      model.recovering = false;
      expect(real.store.read().phase).toBe("paused");
    }
    expect(real.store.read().revision).toBe(model.revision);
    assertDurableState(real);
  }

  toString(): string {
    return "fail-recovery-provider";
  }
}

class ReopenPersistedStore implements fc.AsyncCommand<
  LifecycleModel,
  LifecycleReal
> {
  check(): boolean {
    return true;
  }

  async run(model: LifecycleModel, real: LifecycleReal): Promise<void> {
    real.store = await real.fixture.reopen();
    expect(real.store.read().revision).toBe(model.revision);
    assertDurableState(real);
  }

  toString(): string {
    return "reopen-persisted-store";
  }
}

describe("durable lifecycle harness", () => {
  const fixtures: LifecycleFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures) {
      fixture.dispose();
    }
    fixtures.length = 0;
  });

  it("keeps selection, stale completion rejection, and reload deterministic", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(
          [
            fc.constant(new SelectReadyWork()),
            fc.constant(new RejectStaleCompletion()),
            fc.constant(new FailImplementation()),
            fc.constant(new FailRecoveryProvider()),
            fc.constant(new ReopenPersistedStore()),
          ],
          { maxCommands: 12 },
        ),
        async (commands) => {
          const fixture = await createLifecycleFixture();
          fixtures.push(fixture);
          const real: LifecycleReal = { fixture, store: fixture.store };
          const model: LifecycleModel = {
            selected: false,
            recovering: false,
            paused: false,
            providerFailures: 0,
            revision: real.store.read().revision,
          };
          await fc.asyncModelRun(() => ({ model, real }), commands);
        },
      ),
      { numRuns: 50, verbose: true },
    );
  });

  it("reconstructs an actor, abandons persisted work, and pauses an unsafe recovery", async () => {
    const fixture = await createLifecycleFixture();
    fixtures.push(fixture);
    const selected = reduceRunEvent(fixture.store.read(), {
      kind: "workstreams_selected",
      now: "2026-01-01T00:00:00.000Z",
      baseShas: { "first-stream": "base-sha" },
    });
    expect(selected.accepted).toBe(true);
    await fixture.store.update(
      fixture.store.read().revision,
      () => selected.state,
    );
    const effects: string[] = [];
    const actor = new SchedulerActor({
      store: await fixture.reopen(),
      executeEffect: async ({ effect }) => {
        effects.push(effect.kind);
        if (effect.kind === "run_implementation") {
          throw new Error("provider interrupted");
        }
        if (effect.kind === "run_recovery") {
          throw new RecoverySafetyError("no safe correction");
        }
      },
    });

    await actor.start();
    await actor.settle();

    expect(effects).toEqual(["run_implementation", "run_recovery"]);
    expect(Object.keys(actor.snapshot().processLeases)).toEqual([]);
    expect(actor.snapshot()).toMatchObject({ phase: "paused" });
    expect(Object.values(actor.snapshot().recoveryEpisodes)).toHaveLength(1);
  });

  it("materializes only the latest narrowed recovery finding set", async () => {
    const fixture = await createLifecycleFixture();
    fixtures.push(fixture);
    let state = fixture.store.read();
    const workstream = { kind: "source" as const, id: "first-stream" };
    state.workstreams.source[workstream.id]!.phase = "recovering";
    state.workstreams.source[workstream.id]!.baseSha = "base-sha";
    state.workstreams.source[workstream.id]!.candidateId = "candidate-2";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream,
      baseSha: "base-sha",
      commitSha: "commit-1",
      treeSha: "tree-1",
    };
    state.candidates["candidate-2"] = {
      ...state.candidates["candidate-1"],
      id: "candidate-2",
      commitSha: "commit-2",
      treeSha: "tree-2",
    };
    for (const id of ["finding-1", "finding-2"]) {
      state.findings[id] = {
        id,
        candidateId: "candidate-1",
        workstream,
        summary: `${id} remains`,
        evidence: `${id} evidence`,
        requiredChange: `Fix ${id}`,
        acceptanceCriteria: [`${id} passes`],
        origin: "initial",
        introducedRound: 0,
        status: "open",
      };
    }
    state.reviews["source:first-stream"] = {
      candidateId: "candidate-2",
      previousCandidateId: "candidate-1",
      round: 1,
      outstandingIds: ["finding-1", "finding-2"],
      latestCorrection: {
        fromCandidateId: "candidate-1",
        changedPaths: ["src/fix.ts"],
        evidence: "Corrected both findings.",
      },
      evidence: ["first review"],
      observations: [],
    };
    state.gates.push({
      id: "review:source:first-stream:candidate-2:1",
      kind: "review",
      workstream,
      candidateId: "candidate-2",
      attempt: 1,
      outcome: "failed",
      evidence: "Both findings remain open.",
      outstandingFindingIds: ["finding-1", "finding-2"],
    });
    state.recoveryEpisodes.episode = {
      id: "episode",
      gateId: "review:source:first-stream:candidate-2:1",
      gateAttempts: ["review:source:first-stream:candidate-2:1"],
      workstream,
      candidateId: "candidate-2",
      workspace: {
        id: "source:first-stream",
        checkpoint: "commit-2",
        changedPaths: [],
        stateEvidence: "The first review failed.",
      },
      outstandingFindingIds: ["finding-1", "finding-2"],
      status: "open",
      cycle: {
        signature: "first",
        identicalNoActionCycles: 0,
        independentlyEscalated: false,
      },
      providerFailures: 0,
      actions: [],
    };

    const requested = reduceRunEvent(state, {
      kind: "recovery_requested",
      workstream,
      now: "now",
    });
    const recovery = requested.effects[0];
    if (!recovery || recovery.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    const retried = reduceRunEvent(requested.state, {
      kind: "recovery_completed",
      workstream,
      leaseId: recovery.leaseId,
      action: {
        kind: "retry",
        outcome: "completed",
        summary: "The existing candidate can be reviewed again.",
        evidence: "No further changes are needed before review.",
        at: "later",
      },
    });
    const reviewRequested = reduceRunEvent(retried.state, {
      kind: "review_requested",
      workstream,
      now: "later",
    });
    const review = reviewRequested.effects[0];
    if (!review || review.kind !== "run_review") {
      throw new Error("Expected review effect.");
    }
    const narrowed = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "candidate-2",
        evidence: "The first finding is resolved; the second remains.",
        completion: {
          assessments: [
            {
              id: "finding-1",
              status: "resolved",
              evidence: "The first behavior now works.",
            },
            {
              id: "finding-2",
              status: "unresolved",
              evidence: "The second behavior still fails.",
            },
          ],
          regressions: [],
        },
      },
    });
    expect(narrowed.accepted).toBe(true);
    const packet = buildRecoveryPacket({
      state: narrowed.state,
      effect: {
        kind: "run_recovery",
        workstream,
        leaseId: "next-lease",
        episodeId: "episode",
        independentlyEscalated: false,
      },
    });

    expect(narrowed.state.recoveryEpisodes.episode).toMatchObject({
      gateId: "review:source:first-stream:candidate-2:3",
      gateAttempts: [
        "review:source:first-stream:candidate-2:1",
        "review:source:first-stream:candidate-2:3",
      ],
      outstandingFindingIds: ["finding-2"],
    });
    expect(narrowed.state.findings["finding-1"]?.status).toBe("resolved");
    expect(packet.gate).toMatchObject({
      id: "review:source:first-stream:candidate-2:3",
      evidence: "The first finding is resolved; the second remains.",
    });
    expect(packet.outstandingFindings.map((item) => item.id)).toEqual([
      "finding-2",
    ]);
  });
});
