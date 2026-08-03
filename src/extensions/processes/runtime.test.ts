import { afterEach, describe, expect, it } from "vitest";
import { bindSandboxBashExecutor } from "../sandbox/bash-binding.js";
import type { SandboxExecutionTerminal } from "../sandbox/bash-capability.js";
import { ProcessRuntime } from "./runtime.js";

type LeaseControl = {
  complete: (terminal: SandboxExecutionTerminal) => void;
};

function runtime(
  options: {
    terminal?: SandboxExecutionTerminal;
    output?: Array<{ stream: "stdout" | "stderr"; data: Buffer }>;
  } = {},
) {
  const host = {} as never;
  const controls: LeaseControl[] = [];
  const binding = bindSandboxBashExecutor(
    host,
    async () => ({ content: [], details: undefined }),
    async (request) => {
      let resolve: (terminal: SandboxExecutionTerminal) => void = () =>
        undefined;
      const completion = options.terminal
        ? Promise.resolve(options.terminal)
        : new Promise<SandboxExecutionTerminal>((settle) => {
            resolve = settle;
          });
      const control = { complete: resolve };
      controls.push(control);
      for (const event of options.output ?? [
        { stream: "stdout" as const, data: Buffer.from("hello\n") },
      ]) {
        request.onOutput(event);
      }
      return {
        pid: controls.length,
        completion,
        stop: async () => {
          control.complete({
            exitCode: 0,
            signal: null,
            termination: "stopped",
            outputComplete: true,
          });
          return completion;
        },
      };
    },
  );
  return { runtime: new ProcessRuntime(host, () => true), controls, binding };
}

async function start(runtime: ProcessRuntime, signal?: AbortSignal) {
  return runtime.start({
    command: "echo hello",
    description: "hello",
    cwd: "/tmp",
    ctx: {} as never,
    signal,
    toolCallId: "process-call",
  });
}

describe("ProcessRuntime", () => {
  const bindings: { dispose: () => void }[] = [];
  afterEach(() => bindings.pop()?.dispose());

  it("starts a stable record and maps natural completion", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await fixture.runtime.start({
      command: "echo hello",
      description: "hello",
      cwd: "/tmp",
      ctx: {} as never,
      signal: undefined,
    });
    expect(snapshot).toMatchObject({
      id: "process-1",
      status: "running",
      pid: 1,
    });

    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    const result = await fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
    );
    expect(result.snapshot.status).toBe("completed");
    expect(result.waitOutcome).toBe("terminal");
    expect(result.output).toContain("[stdout] hello");
  });

  it("stops through the lease without a direct process owner", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await fixture.runtime.start({
      command: "sleep 1",
      description: "sleep",
      cwd: "/tmp",
      ctx: {} as never,
      signal: undefined,
    });
    const result = await fixture.runtime.stop(snapshot.id);
    expect(result.snapshot.status).toBe("stopped");
  });

  it("settles a waiting caller while disposing its session", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await fixture.runtime.start({
      command: "sleep 1",
      description: "sleep",
      cwd: "/tmp",
      ctx: {} as never,
      signal: undefined,
    });
    const waiting = fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
    );
    await fixture.runtime.dispose();
    await expect(waiting).resolves.toMatchObject({
      waitOutcome: expect.stringMatching(/terminal|cancelled/),
    });
  });

  it("times out a waiter without stopping the running process", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await fixture.runtime.start({
      command: "sleep 1",
      description: "sleep",
      cwd: "/tmp",
      ctx: {} as never,
      signal: undefined,
    });
    const result = await fixture.runtime.result(
      snapshot.id,
      true,
      0.001,
      undefined,
    );
    expect(result.waitOutcome).toBe("timed_out");
    expect(result.snapshot.status).toBe("running");
  });

  it("publishes an already-settled launch truthfully", async () => {
    const fixture = runtime({
      terminal: {
        exitCode: 1,
        signal: null,
        termination: "natural",
        outputComplete: true,
      },
    });
    bindings.push(fixture.binding);
    await expect(start(fixture.runtime)).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
    });
  });

  it("validates wait arguments before allocating a waiter", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    await expect(
      fixture.runtime.result(snapshot.id, false, 1, undefined),
    ).rejects.toThrow("requires wait:true");
    await expect(
      fixture.runtime.result(snapshot.id, true, 0, undefined),
    ).rejects.toThrow("invalid timeoutSeconds");
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.runtime.result(snapshot.id, true, 1, controller.signal),
    ).resolves.toMatchObject({ waitOutcome: "cancelled" });
    expect(fixture.runtime.snapshot(snapshot.id).status).toBe("running");
  });

  it("enforces waiter capacity without affecting other terminal waits", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    const waits = Array.from({ length: 16 }, () =>
      fixture.runtime.result(snapshot.id, true, undefined, undefined),
    );
    await expect(
      fixture.runtime.result(snapshot.id, true, undefined, undefined),
    ).rejects.toThrow("maximum of 16 waiters");
    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    await expect(Promise.all(waits)).resolves.toHaveLength(16);
  });

  it("keeps logical lines, stream identity, and mandatory notices bounded", async () => {
    const fixture = runtime({
      output: [
        { stream: "stdout", data: Buffer.from("first") },
        { stream: "stdout", data: Buffer.from(" line\\n") },
        { stream: "stderr", data: Buffer.from("second\\n") },
      ],
    });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: false,
    });
    const result = await fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
    );
    expect(result.output).toContain("[stdout] first line");
    expect(result.output).toContain("[stderr] second");
    expect(result.output).toContain("Final output may be incomplete.");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(24 * 1024);
  });

  it("isolates observation subscribers and removes them idempotently", async () => {
    const fixture = runtime();
    bindings.push(fixture.binding);
    const updates: number[] = [];
    fixture.runtime.subscribe(() => {
      throw new Error("observer failure");
    });
    const unsubscribe = fixture.runtime.subscribe((snapshots) =>
      updates.push(snapshots.length),
    );
    const snapshot = await start(fixture.runtime);
    const recordUpdates: Array<string | undefined> = [];
    const unsubscribeRecord = fixture.runtime.subscribeRecord(
      snapshot.id,
      (next) => recordUpdates.push(next?.status),
    );
    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    await fixture.runtime.result(snapshot.id, true, undefined, undefined);
    expect(updates.length).toBeGreaterThan(0);
    expect(recordUpdates).toContain("completed");
    unsubscribe();
    unsubscribe();
    unsubscribeRecord();
    unsubscribeRecord();
  });
});
