import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveRun, CompletedRunResources } from "./run.js";
import type { RunState } from "./store.js";
import {
  cleanupSchedulerStores,
  createUnboundSchedulerRun,
} from "./scheduler/scheduler-test-support.js";

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
          display: true,
          content: expect.stringContaining(scenario.draft),
        },
        options: { triggerTurn: true },
      });
      expect(
        (fixture.messages[0]!.message as { content: string }).content,
      ).toContain(
        `Material final residual whole-plan findings: ${scenario.residual ? "yes" : "no"}`,
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
        display: true,
      });
      expect(message.content).toContain("first-stream · satisfaction receipt");
      expect(message.content).toContain(`/implement inspect ${state.run.id}`);
      expect(message.content).toContain(`/implement cleanup ${state.run.id}`);
      if (state.phase === "failed") {
        expect(message.content).toContain("Terminal category: interrupted");
      }
      mocks.startRun.mockReset();
    }
  });

  it("retains a failed completed send through cleanup, blocks starts, and retries once settled", async () => {
    const state = completedState("Approved handoff.", false);
    const calls: string[] = [];
    let sendAttempts = 0;
    const fixture = commandFixture({
      sendMessage(message, options) {
        calls.push("send");
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error("session unavailable");
        }
        fixture.messages.push({ message, options });
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
      expect(calls).toEqual(["send", "resources", "lease"]),
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
    expect(calls).toEqual(["send", "resources", "lease", "send"]);
    expect(fixture.messages).toHaveLength(1);

    await fixture.command.handler("another-plan.md", fixture.idle);
    expect(mocks.startRun).toHaveBeenCalledTimes(2);
  });

  it("delivers a captured handoff and retains the cleanup warning when release fails", async () => {
    const state = completedState("Approved despite cleanup failure.", false);
    const calls: string[] = [];
    const fixture = commandFixture({
      sendMessage(message, options) {
        calls.push("send");
        fixture.messages.push({ message, options });
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
      expect(calls).toEqual(["send", "resources", "lease"]),
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
  sendMessage?: (message: unknown, options: unknown) => void;
}) {
  const handlers = new Map<string, EventHandler>();
  const messages: Message[] = [];
  const notifications: string[] = [];
  let command: Command | undefined;
  const sendMessage =
    options?.sendMessage ??
    ((message: unknown, messageOptions: unknown) => {
      messages.push({ message, options: messageOptions });
    });
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, next: Command) {
      command = next;
    },
    sendMessage,
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
  state.workstreams.source["second-stream"] = {
    kind: "source",
    id: "second-stream",
    taskIds: ["second"],
    dependsOn: ["first-stream"],
    phase: "dependency_skipped",
    baseSha: "base-sha",
  };
  return state;
}

function failedState(): RunState {
  const state = terminalState("failed");
  addSatisfiedDelivery(state);
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
