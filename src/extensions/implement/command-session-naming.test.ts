import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWelcome } from "../personality/welcome.js";
import type { ActiveRun } from "./run.js";
import type { RunState } from "./store.js";

const mocks = vi.hoisted(() => ({
  generateSessionName: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
}));

vi.mock("#personality/session-name", () => ({
  generateSessionName: mocks.generateSessionName,
}));

vi.mock("./run.js", () => ({
  startRun: mocks.startRun,
  stopRun: mocks.stopRun,
}));

import { registerImplementCommand } from "./command.js";

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

const temporaryDirectories = new Set<string>();

type Command = { handler: (input: string, ctx: any) => Promise<void> };
type EventHandler = (event: unknown, ctx: any) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fixture(options?: {
  cwd?: string;
  existingName?: string;
  welcome?: boolean;
}) {
  const handlers = new Map<string, EventHandler[]>();
  const activity: unknown[] = [];
  const notifications: string[] = [];
  const setHeader = vi.fn();
  let command: Command | undefined;
  let name = options?.existingName;
  const ctx = {
    cwd: options?.cwd ?? process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (message: string) => notifications.push(message),
      setHeader,
    },
  };
  const pi = {
    events: {
      emit: (_channel: string, event: unknown) => activity.push(event),
    },
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(_name: string, next: Command) {
      command = next;
    },
    getSessionName: () => name,
    setSessionName: vi.fn((next: string) => {
      name = next;
      for (const handler of handlers.get("session_info_changed") ?? []) {
        handler({ name: next }, ctx);
      }
    }),
    appendEntry() {},
    sendMessage() {},
  };

  if (options?.welcome) {
    registerWelcome(pi as never, "Mads");
  }
  registerImplementCommand(pi as never, config);
  return {
    activity,
    command: command!,
    ctx,
    handlers,
    notifications,
    setHeader,
    setSessionName: pi.setSessionName,
  };
}

function planFixture(): { cwd: string; planPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "pipkin-implement-naming-"));
  temporaryDirectories.add(cwd);
  const planPath = "tmp/plans/08-managed-processes/index.md";
  const path = join(cwd, planPath);
  mkdirSync(join(cwd, "tmp/plans/08-managed-processes"), { recursive: true });
  writeFileSync(
    path,
    "# Phase 8: Add Sandbox-composed managed processes\n\n- [ ] Name Implement runs\n",
  );
  return { cwd, planPath };
}

function activeRun(
  runId = "run-1",
  phase: RunState["phase"] = "planning",
): ActiveRun {
  const state = {
    phase,
    run: { id: runId },
    tasks: {},
    workstreams: { source: {}, overall: {} },
  } as RunState;
  return {
    runId,
    store: { read: () => state },
  } as ActiveRun;
}

async function emit(
  handlers: Map<string, EventHandler[]>,
  event: string,
  context: unknown,
  payload: unknown = {},
): Promise<void> {
  await Promise.all(
    (handlers.get(event) ?? []).map((handler) => handler(payload, context)),
  );
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  mocks.generateSessionName.mockReset();
  mocks.startRun.mockReset();
  mocks.stopRun.mockReset();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe("/implement session naming", () => {
  it("starts Activity before deferred naming, replaces an existing name, and dismisses Welcome", async () => {
    const plan = planFixture();
    const fixtureState = fixture({
      cwd: plan.cwd,
      existingName: "Manual session name",
      welcome: true,
    });
    let resolveName: (value: unknown) => void = () => {};
    mocks.startRun.mockResolvedValue({ kind: "started", active: activeRun() });
    mocks.generateSessionName.mockReturnValue(
      new Promise((resolve) => {
        resolveName = resolve;
      }),
    );
    await emit(fixtureState.handlers, "session_start", fixtureState.ctx, {
      reason: "startup",
    });

    await fixtureState.command.handler(plan.planPath, fixtureState.ctx);
    await vi.waitFor(() =>
      expect(mocks.generateSessionName).toHaveBeenCalledTimes(1),
    );

    expect(fixtureState.notifications).toContain(
      "Implement started run run-1.",
    );
    expect(fixtureState.activity).toContainEqual(
      expect.objectContaining({ operation: "upsert" }),
    );
    expect(fixtureState.setHeader).toHaveBeenCalledTimes(1);
    expect(fixtureState.setSessionName).not.toHaveBeenCalled();
    const input = mocks.generateSessionName.mock.calls[0]![2] as {
      kind: string;
      planExcerpt: string;
    };
    expect(input).toMatchObject({ kind: "implement" });
    expect(input.planExcerpt).toContain(
      "# Phase 8: Add Sandbox-composed managed processes",
    );

    resolveName({ outcome: "success", title: "Implement managed processes" });
    await flushPromises();

    expect(fixtureState.setSessionName).toHaveBeenCalledWith(
      "Implement managed processes",
    );
    expect(fixtureState.setHeader).toHaveBeenLastCalledWith(undefined);
  });

  it("does not apply a settled run's late name to a newer Activity", async () => {
    const plan = planFixture();
    const fixtureState = fixture({ cwd: plan.cwd });
    const starts: any[] = [];
    const firstName = deferred<{ outcome: "success"; title: string }>();
    const secondName = deferred<{ outcome: "success"; title: string }>();
    mocks.startRun.mockImplementation(async (options) => {
      starts.push(options);
      return {
        kind: "started",
        active: activeRun(`run-${starts.length}`),
      };
    });
    mocks.generateSessionName
      .mockReturnValueOnce(firstName.promise)
      .mockReturnValueOnce(secondName.promise);

    await fixtureState.command.handler(plan.planPath, fixtureState.ctx);
    await vi.waitFor(() =>
      expect(mocks.generateSessionName).toHaveBeenCalledTimes(1),
    );
    starts[0]!.onTransition?.(activeRun("run-1", "failed").store.read(), {
      kind: "planner_bound",
    });
    starts[0]!.onCompleted?.(activeRun("run-1", "failed") as never);
    await flushPromises();

    await fixtureState.command.handler(plan.planPath, fixtureState.ctx);
    await vi.waitFor(() =>
      expect(mocks.generateSessionName).toHaveBeenCalledTimes(2),
    );
    firstName.resolve({ outcome: "success", title: "Implement stale title" });
    await flushPromises();

    expect(fixtureState.setSessionName).not.toHaveBeenCalled();

    secondName.resolve({
      outcome: "success",
      title: "Implement current title",
    });
    await flushPromises();

    expect(fixtureState.setSessionName).toHaveBeenCalledTimes(1);
    expect(fixtureState.setSessionName).toHaveBeenCalledWith(
      "Implement current title",
    );
  });

  it("does not apply naming that settles after shutdown", async () => {
    const plan = planFixture();
    const fixtureState = fixture({ cwd: plan.cwd });
    let resolveName: (value: unknown) => void = () => {};
    mocks.startRun.mockResolvedValue({ kind: "started", active: activeRun() });
    mocks.generateSessionName.mockReturnValue(
      new Promise((resolve) => {
        resolveName = resolve;
      }),
    );

    await fixtureState.command.handler(plan.planPath, fixtureState.ctx);
    await vi.waitFor(() =>
      expect(mocks.generateSessionName).toHaveBeenCalledTimes(1),
    );
    const signal = mocks.generateSessionName.mock.calls[0]![3] as AbortSignal;
    await emit(fixtureState.handlers, "session_shutdown", fixtureState.ctx);
    resolveName({ outcome: "success", title: "Implement stale title" });
    await flushPromises();

    expect(signal.aborted).toBe(true);
    expect(fixtureState.setSessionName).not.toHaveBeenCalled();
  });

  it("does not name a run that returns after session shutdown", async () => {
    const plan = planFixture();
    const fixtureState = fixture({ cwd: plan.cwd });
    let resolveStart: (value: unknown) => void = () => {};
    mocks.startRun.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );

    const command = fixtureState.command.handler(
      plan.planPath,
      fixtureState.ctx,
    );
    await vi.waitFor(() => expect(mocks.startRun).toHaveBeenCalledTimes(1));
    const shutdown = emit(
      fixtureState.handlers,
      "session_shutdown",
      fixtureState.ctx,
    );
    await flushPromises();
    resolveStart({ kind: "started", active: activeRun() });
    await command;
    await shutdown;
    await flushPromises();

    expect(mocks.generateSessionName).not.toHaveBeenCalled();
    expect(fixtureState.setSessionName).not.toHaveBeenCalled();
  });

  it("does not name rejected commands", async () => {
    const fixtureState = fixture();

    await fixtureState.command.handler("-bad", fixtureState.ctx);
    await flushPromises();

    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.generateSessionName).not.toHaveBeenCalled();
    expect(fixtureState.setSessionName).not.toHaveBeenCalled();
  });
});
