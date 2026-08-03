import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveRun, CompletedRunResources } from "./run.js";
import type { RunState } from "./store.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
  createUnboundSchedulerRun,
} from "./scheduler/scheduler-test-support.js";
import { SchedulerActor } from "./scheduler/scheduler-actor.js";
import { renderTerminalHandoff } from "./terminal-handoff.js";

const mocks = vi.hoisted(() => ({
  releaseResources: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
}));

vi.mock("./run.js", () => ({
  startRun: mocks.startRun,
  stopRun: mocks.stopRun,
}));

vi.mock("./controls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./controls.js")>()),
  releaseCompletedRunResources: mocks.releaseResources,
}));

import { registerImplementCommand } from "./command.js";

type StartOptions = Parameters<typeof import("./run.js").startRun>[0];
type Command = { handler: (input: string, ctx: any) => Promise<void> };
type Message = { message: unknown; options: unknown };
type EventHandler = (event: unknown, ctx: any) => unknown;

const config = {
  path: "/agent/pipkin/config.json",
  issues: [],
  config: {
    models: {
      utility: { model: "test/utility", thinking: "minimal" },
      low: { model: "test/low", thinking: "low" },
      medium: { model: "test/medium", thinking: "medium" },
      high: { model: "test/high", thinking: "high" },
    },
    implement: { workerConcurrency: 3 },
  },
} as const;

afterEach(() => {
  cleanupSchedulerStores();
  mocks.releaseResources.mockReset();
  mocks.startRun.mockReset();
  mocks.stopRun.mockReset();
});

describe("/implement terminal handoff lifecycle", () => {
  it("delivers one displayed immediate handoff for direct and repaired approvals", async () => {
    for (const scenario of [
      { draft: "Initial reviewer approval.", residual: false },
      { draft: "Replacement reviewer approval after repair.", residual: true },
    ]) {
      const state = completedState(scenario.draft, scenario.residual);
      const fixture = commandFixture();
      const starts: StartOptions[] = [];
      mocks.startRun.mockImplementation(async (options: StartOptions) => {
        starts.push(options);
        return { kind: "started", active: activeRun(state) };
      });

      await fixture.command.handler("plan.md", fixture.idle);
      const options = starts[0]!;
      options.onTransition?.(state, { kind: "planner_bound" });
      options.onTransition?.(state, completedEvent());
      options.onTransition?.(state, completedEvent());

      expect(fixture.messages).toHaveLength(1);
      expect(fixture.messages[0]).toMatchObject({
        message: {
          customType: "pipkin.implement.terminal-handoff",
          data: {
            phase: "completed",
            runId: state.run.id,
            text: expect.stringContaining(scenario.draft),
          },
        },
        options: undefined,
      });
      expect(
        (fixture.messages[0]!.message as { content: string }).content,
      ).toContain(
        `- Residual findings: ${scenario.residual ? "1 material finding retained." : "None."}`,
      );
      mocks.startRun.mockReset();
    }
  });

  it("delivers accepted incomplete and interrupted handoffs from retained state", async () => {
    for (const state of [incompleteState(), failedState()]) {
      const fixture = commandFixture();
      const starts: StartOptions[] = [];
      mocks.startRun.mockImplementation(async (options: StartOptions) => {
        starts.push(options);
        return { kind: "started", active: activeRun(state) };
      });

      await fixture.command.handler("plan.md", fixture.idle);
      starts[0]!.onTransition?.(state, {
        kind: state.phase === "incomplete" ? "run_incomplete" : "run_failed",
      });

      expect(fixture.messages).toHaveLength(1);
      const message = fixture.messages[0]!.message as { content: string };
      expect(message).toMatchObject({
        customType: "pipkin.implement.terminal-handoff",
        data: { phase: state.phase, runId: state.run.id },
      });
      expect(message.content).toContain("- Delivered: `first-stream`");
      expect(message.content).toContain("- Not delivered: `second-stream`");
      expect(message.content).not.toContain("candidate-unpublished");
      expect(message.content).not.toContain("candidate-first");
      expect(message.content).toContain(`/implement inspect ${state.run.id}`);
      expect(message.content).toContain(`/implement cleanup ${state.run.id}`);
      if (state.phase === "failed") {
        expect(message.content).toContain("Stopped with retained resources.");
      }
      mocks.startRun.mockReset();
    }
  });

  it("captures only persisted completion, cleans busy resources, and delivers the immutable handoff after settle", async () => {
    const fixture = commandFixture();
    const store = await completedSchedulerStore("Persisted reviewer handoff.");
    const calls: string[] = [];
    let actor: SchedulerActor | undefined;
    mocks.releaseResources.mockImplementation(async () => {
      calls.push("resources");
    });
    mocks.startRun.mockImplementation(async (options: StartOptions) => {
      const active = persistedActiveRun(store, options, calls);
      actor = active.actor;
      return { kind: "started", active };
    });

    await fixture.command.handler("plan.md", fixture.busy);
    await expect(
      actor!.dispatch({
        kind: "run_completed",
        targetSha: "wrong-target",
        targetTreeSha: "target-tree",
      }),
    ).rejects.toThrow();
    expect(fixture.messages).toEqual([]);

    await actor!.dispatch(completedEvent());
    const captured = renderTerminalHandoff(store.read());
    await vi.waitFor(() => expect(calls).toEqual(["resources", "lease"]));
    expect(fixture.messages).toEqual([]);

    await fixture.settle(true);
    await fixture.settle(true);
    expect(fixture.messages).toHaveLength(1);
    expect((fixture.messages[0]!.message as { content: string }).content).toBe(
      captured,
    );

    await actor!.dispatch(completedEvent(), {
      kind: "complete_whole_plan_run",
    } as never);
    expect(fixture.messages).toHaveLength(1);
  });

  it("publishes persisted incomplete and stopped terminal transitions", async () => {
    const incompleteFixture = commandFixture();
    const incompleteStore = await incompleteSchedulerStore();
    let incompleteActor: SchedulerActor | undefined;
    mocks.startRun.mockImplementation(async (options: StartOptions) => {
      const active = persistedActiveRun(incompleteStore, options, []);
      incompleteActor = active.actor;
      return { kind: "started", active };
    });

    await incompleteFixture.command.handler("plan.md", incompleteFixture.idle);
    await incompleteActor!.dispatch({ kind: "run_incomplete" });
    expect(incompleteStore.read().phase).toBe("incomplete");
    expect(
      (incompleteFixture.messages[0]!.message as { content: string }).content,
    ).toContain("The run is incomplete.");

    mocks.startRun.mockReset();
    const stoppedFixture = commandFixture();
    const stoppedStore = await createSchedulerStore();
    let stoppedActor: SchedulerActor | undefined;
    mocks.startRun.mockImplementation(async (options: StartOptions) => {
      const active = persistedActiveRun(stoppedStore, options, []);
      stoppedActor = active.actor;
      return { kind: "started", active };
    });

    await stoppedFixture.command.handler("plan.md", stoppedFixture.idle);
    await stoppedActor!.stop(
      "Session interrupted with retained evidence.",
      "interrupted",
    );
    expect(stoppedStore.read().phase).toBe("failed");
    const stoppedHandoff = stoppedFixture.messages[0]!.message as {
      content: string;
    };
    expect(stoppedHandoff.content).toContain(
      "Session interrupted with retained evidence.",
    );
    expect(stoppedHandoff.content).toContain("/implement inspect run-1");
    expect(stoppedHandoff.content).toContain("/implement cleanup run-1");
  });

  it("retains a failed completed append through cleanup, blocks starts, and retries once settled", async () => {
    const state = completedState("Approved handoff.", false);
    const calls: string[] = [];
    let sendAttempts = 0;
    const fixture = commandFixture({
      appendEntry(customType, data) {
        calls.push("append");
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error("session unavailable");
        }
        fixture.messages.push(entryRecord(customType, data));
      },
    });
    const run = activeRun(state, calls);
    let options: StartOptions | undefined;
    mocks.releaseResources.mockImplementation(async () => {
      calls.push("resources");
    });
    mocks.startRun.mockImplementation(async (next: StartOptions) => {
      options = next;
      return { kind: "started", active: run };
    });

    await fixture.command.handler("plan.md", fixture.idle);
    options!.onTransition?.(state, completedEvent());
    options!.onCompleted?.(run as CompletedRunResources);
    await vi.waitFor(() =>
      expect(calls).toEqual(["append", "resources", "lease"]),
    );

    await fixture.command.handler("another-plan.md", fixture.idle);
    await fixture.command.handler(
      "restart another-plan.md run-1",
      fixture.idle,
    );
    expect(mocks.startRun).toHaveBeenCalledTimes(1);
    expect(fixture.notifications).toContain(
      "Implement has an undelivered terminal handoff in this session.",
    );

    await fixture.settle(true);
    await fixture.settle(true);
    expect(calls).toEqual(["append", "resources", "lease", "append"]);
    expect(fixture.messages).toHaveLength(1);

    await fixture.command.handler("another-plan.md", fixture.idle);
    expect(mocks.startRun).toHaveBeenCalledTimes(2);
  });

  it("delivers a captured handoff and retains the cleanup warning when release fails", async () => {
    const state = completedState("Approved despite cleanup failure.", false);
    const calls: string[] = [];
    const fixture = commandFixture({
      appendEntry(customType, data) {
        calls.push("append");
        fixture.messages.push(entryRecord(customType, data));
      },
    });
    const run = activeRun(state, calls, true);
    let options: StartOptions | undefined;
    mocks.releaseResources.mockImplementation(async () => {
      calls.push("resources");
      throw new Error("worktree removal failed");
    });
    mocks.startRun.mockImplementation(async (next: StartOptions) => {
      options = next;
      return { kind: "started", active: run };
    });

    await fixture.command.handler("plan.md", fixture.idle);
    options!.onTransition?.(state, completedEvent());
    options!.onCompleted?.(run as CompletedRunResources);
    await vi.waitFor(() =>
      expect(calls).toEqual(["append", "resources", "lease"]),
    );

    expect(fixture.messages).toHaveLength(1);
    expect(fixture.notifications).toContain(
      "Implement completed run run-1, but automatic resource cleanup was blocked: worktree removal failed; lease release failed",
    );
  });

  it("defers busy delivery once and makes registered lifecycle callbacks inert after shutdown", async () => {
    const state = completedState("Deferred reviewer handoff.", false);
    const fixture = commandFixture();
    let options: StartOptions | undefined;
    mocks.startRun.mockImplementation(async (next: StartOptions) => {
      options = next;
      return { kind: "started", active: activeRun(state) };
    });

    await fixture.command.handler("plan.md", fixture.busy);
    options!.onTransition?.(state, completedEvent());
    options!.onTransition?.(state, completedEvent());
    await fixture.settle(false);
    expect(fixture.messages).toEqual([]);

    await fixture.settle(true);
    await fixture.settle(true);
    expect(fixture.messages).toHaveLength(1);

    const pending = commandFixture();
    let pendingOptions: StartOptions | undefined;
    mocks.startRun.mockImplementation(async (next: StartOptions) => {
      pendingOptions = next;
      return { kind: "started", active: activeRun(state) };
    });
    await pending.command.handler("plan.md", pending.busy);
    pendingOptions!.onTransition?.(state, completedEvent());
    await pending.shutdown();
    await pending.settle(true);

    expect(pending.messages).toEqual([]);
  });
});

function commandFixture(options?: {
  appendEntry?: (customType: string, data: unknown) => void;
}) {
  const handlers = new Map<string, EventHandler>();
  const messages: Message[] = [];
  const notifications: string[] = [];
  let command: Command | undefined;
  const appendEntry =
    options?.appendEntry ??
    ((customType: string, data: unknown) => {
      messages.push(entryRecord(customType, data));
    });
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, next: Command) {
      command = next;
    },
    appendEntry,
    sendMessage() {
      throw new Error("Terminal handoffs must not enter agent context.");
    },
  };
  const context = (idle: boolean) => ({
    cwd: "/repo",
    mode: "print",
    hasUI: false,
    isIdle: () => idle,
    ui: { notify: (message: string) => notifications.push(message) },
  });

  registerImplementCommand(pi as never, config);
  return {
    command: command!,
    messages,
    notifications,
    idle: context(true),
    busy: context(false),
    settle: async (idle: boolean) => {
      await handlers.get("agent_settled")!({}, context(idle));
    },
    shutdown: async () => {
      await handlers.get("session_shutdown")!({}, context(true));
    },
  };
}

function entryRecord(customType: string, data: unknown): Message {
  const content = (data as { text?: unknown })?.text;
  return {
    message: { customType, data, content },
    options: undefined,
  };
}

async function incompleteSchedulerStore() {
  const store = await completedSchedulerStore("Initial reviewer handoff.");
  const state = store.read();
  state.wholePlanReview = {
    status: "pending",
    handoffDraft: "Initial reviewer handoff.",
    reviewRetry: {
      attempts: 3,
      status: "exhausted",
      evidence: ["malformed overall review"],
    },
  };
  await store.update(state.revision, () => state);
  return store;
}

async function completedSchedulerStore(draft: string) {
  const store = await createSchedulerStore();
  const state = store.read();
  state.phase = "whole_plan_review";
  for (const workstream of Object.values(state.workstreams.source)) {
    const candidateId = `candidate:${workstream.id}`;
    workstream.phase = "completed";
    workstream.baseSha = "base-sha";
    workstream.candidateId = candidateId;
    state.candidates[candidateId] = {
      id: candidateId,
      workstream: { kind: "source", id: workstream.id },
      baseSha: "base-sha",
      commitSha: "base-sha",
      treeSha: "base-tree",
    };
    state.reviews[`source:${workstream.id}`] = {
      candidateId,
      comparisonBase: "base-sha",
      round: 0,
      pendingCorrectionIds: [],
      correctionConsumed: false,
      evidence: ["persisted review evidence"],
      observations: [],
    };
  }
  state.wholePlanReview = {
    status: "approved",
    handoffDraft: draft,
    evidence: "persisted whole-plan review evidence",
    reviewedTargetSha: "target-sha",
    reviewedTargetTreeSha: "target-tree",
  };
  await store.update(state.revision, () => state);
  return store;
}

function persistedActiveRun(
  store: Awaited<ReturnType<typeof createSchedulerStore>>,
  options: StartOptions,
  calls: string[],
): ActiveRun {
  let active: ActiveRun;
  const actor = new SchedulerActor({
    store,
    onTransition(state, event) {
      options.onTransition?.(state, event);
      if (event.kind === "run_completed") {
        options.onCompleted?.(active as CompletedRunResources);
      }
    },
  });
  active = {
    runId: store.read().run.id,
    actor,
    store,
    lease: {
      release: async () => {
        calls.push("lease");
      },
    },
    git: {},
  } as ActiveRun;
  return active;
}

function activeRun(
  state: RunState,
  calls?: string[],
  failLeaseRelease = false,
): ActiveRun {
  return {
    runId: state.run.id,
    store: { read: () => state },
    lease: {
      release: async () => {
        calls?.push("lease");
        if (failLeaseRelease) {
          throw new Error("lease release failed");
        }
      },
    },
    git: {},
  } as ActiveRun;
}

function completedEvent() {
  return {
    kind: "run_completed" as const,
    targetSha: "target-sha",
    targetTreeSha: "target-tree",
  };
}

function completedState(draft: string, residual: boolean): RunState {
  const state = terminalState("completed");
  state.wholePlanReview = {
    status: "approved",
    handoffDraft: draft,
    reviewedTargetSha: "target-sha",
    reviewedTargetTreeSha: "target-tree",
    evidence: "authoritative reviewer verification",
    epoch: {
      initialTargetSha: "base-sha",
      initialTargetTreeSha: "base-tree",
      findingIds: residual ? ["whole-open"] : [],
      pendingCorrectionIds: [],
    },
  };
  if (residual) {
    state.findings["whole-open"] = {
      id: "whole-open",
      candidateId: "candidate-first",
      workstream: { kind: "source", id: "first-stream" },
      scope: {
        kind: "whole_plan",
        initialTargetSha: "base-sha",
        initialTargetTreeSha: "base-tree",
      },
      summary: "Material residual verification gap",
      evidence: "Representative environment remains unavailable.",
      requiredChange: "Add representative verification.",
      acceptanceCriteria: ["Verification covers the target."],
      origin: "initial",
      introducedRound: 0,
      status: "open",
    };
  }
  return state;
}

function incompleteState(): RunState {
  const state = terminalState("incomplete");
  addSatisfiedDelivery(state);
  addUnpublishedCandidate(state);
  return state;
}

function failedState(): RunState {
  const state = terminalState("failed");
  addSatisfiedDelivery(state);
  addUnpublishedCandidate(state);
  state.failure = {
    category: "interrupted",
    reason: "Stopped with retained resources.",
    originPhase: "running",
    at: "2026-01-01T00:00:00.000Z",
  };
  return state;
}

function terminalState(phase: "completed" | "incomplete" | "failed"): RunState {
  const { run } = createUnboundSchedulerRun();
  const state = structuredClone(run.read());
  state.phase = phase;
  return state;
}

function addUnpublishedCandidate(state: RunState): void {
  state.workstreams.source["second-stream"] = {
    kind: "source",
    id: "second-stream",
    taskIds: ["second"],
    dependsOn: ["first-stream"],
    phase: "candidate_ready",
    baseSha: "base-sha",
    candidateId: "candidate-unpublished",
  };
  state.candidates["candidate-unpublished"] = {
    id: "candidate-unpublished",
    workstream: { kind: "source", id: "second-stream" },
    baseSha: "base-sha",
    commitSha: "candidate-second",
    treeSha: "candidate-second-tree",
  };
}

function addSatisfiedDelivery(state: RunState): void {
  state.candidates["candidate-first"] = {
    id: "candidate-first",
    workstream: { kind: "source", id: "first-stream" },
    baseSha: "base-sha",
    commitSha: "candidate-sha",
    treeSha: "candidate-tree",
    implementationEvidence: {
      summary: "Implemented first stream.",
      verification: ["npm run check"],
    },
  };
  state.satisfaction.receipts["satisfaction:first"] = {
    id: "satisfaction:first",
    candidateId: "candidate-first",
    workstream: { kind: "source", id: "first-stream" },
    assessedTargetSha: "base-sha",
    evidence: "Target already satisfies the workstream.",
    assessedAt: "2026-01-01T00:00:00.000Z",
  };
}
