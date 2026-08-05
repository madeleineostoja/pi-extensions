import { afterEach, describe, expect, it } from "vitest";
import { bindSandboxBashExecutor } from "../sandbox/bash-binding.js";
import type { SandboxExecutionTerminal } from "../sandbox/bash-capability.js";
import { ProcessRuntime } from "./runtime.js";

type LeaseControl = {
  complete: (terminal: SandboxExecutionTerminal) => void;
  write: (stream: "stdout" | "stderr", data: Buffer) => void;
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
      const control = {
        complete: resolve,
        write: (stream: "stdout" | "stderr", data: Buffer) =>
          request.onOutput({ stream, data }),
      };
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

  it("waits eventfully for same-stream split readiness without consuming output", async () => {
    const fixture = runtime({ output: [] });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    const waiting = fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
      "ready ✓",
    );
    fixture.controls[0].write("stdout", Buffer.from("rea"));
    fixture.controls[0].write("stderr", Buffer.from("dy ✓"));
    await expect(
      Promise.race([
        waiting.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 5)),
      ]),
    ).resolves.toBe("pending");
    fixture.controls[0].write("stdout", Buffer.from("dy ✓"));
    await expect(waiting).resolves.toMatchObject({ waitOutcome: "ready" });
    expect(fixture.runtime.snapshot(snapshot.id).status).toBe("running");
    await expect(
      fixture.runtime.result(
        snapshot.id,
        true,
        undefined,
        undefined,
        "ready ✓",
      ),
    ).resolves.toMatchObject({ waitOutcome: "ready" });
  });

  it("seeds readiness from retained same-stream output without joining streams", async () => {
    const fixture = runtime({
      output: [{ stream: "stdout", data: Buffer.from("rea") }],
    });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    const waiting = fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
      "ready",
    );
    fixture.controls[0].write("stderr", Buffer.from("dy"));
    fixture.controls[0].write("stdout", Buffer.from("dy"));
    await expect(waiting).resolves.toMatchObject({ waitOutcome: "ready" });

    const terminalWait = fixture.runtime.result(
      snapshot.id,
      true,
      undefined,
      undefined,
      "never",
    );
    fixture.controls[0].complete({
      exitCode: 0,
      signal: null,
      termination: "natural",
      outputComplete: true,
    });
    await expect(terminalWait).resolves.toMatchObject({
      waitOutcome: "terminal",
      snapshot: { status: "completed" },
    });
  });

  it("reports retained readiness before an already-settled terminal outcome", async () => {
    const fixture = runtime({
      output: [{ stream: "stdout", data: Buffer.from("ready\n") }],
      terminal: {
        exitCode: 0,
        signal: null,
        termination: "natural",
        outputComplete: true,
      },
    });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    await expect(
      fixture.runtime.result(snapshot.id, true, undefined, undefined, "ready"),
    ).resolves.toMatchObject({ waitOutcome: "ready" });
    await expect(
      fixture.runtime.result(
        snapshot.id,
        true,
        undefined,
        undefined,
        "missing",
      ),
    ).resolves.toMatchObject({ waitOutcome: "terminal" });
  });

  it("keeps the full retained output available to the live inspector", async () => {
    const fixture = runtime({ output: [] });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    for (let line = 1; line <= 81; line += 1) {
      fixture.controls[0].write("stdout", Buffer.from(`line ${line}\n`));
    }

    const inspection = await fixture.runtime.inspectionOutput(snapshot.id);
    expect(inspection.output).toContain("[stdout] line 1");
    expect(inspection.output).toContain("[stdout] line 81");
    expect(inspection.output).not.toContain("omitted by tail selection");
  });

  it("keeps the newest contiguous tail and source-relative find line numbers", async () => {
    const fixture = runtime({ output: [] });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    for (let line = 0; line < 20; line += 1) {
      fixture.controls[0].write(
        "stdout",
        Buffer.from(`${line}:${"x".repeat(4_000)}\n`),
      );
    }
    const tail = await fixture.runtime.result(
      snapshot.id,
      false,
      undefined,
      undefined,
      undefined,
      { tailLines: 20 },
    );
    expect(tail.output).toContain("[stdout] 19:");
    expect(tail.output).toContain("Output projection truncated;");
    expect(tail.output).not.toContain("[stdout] 0:");

    fixture.controls[0].write("stdout", Buffer.from("x\n".repeat(600_000)));
    fixture.controls[0].write("stderr", Buffer.from("Needle\n"));
    const found = await fixture.runtime.result(
      snapshot.id,
      false,
      undefined,
      undefined,
      undefined,
      { find: "needle" },
    );
    expect(found.output).toMatch(/\d+ \[stderr\] Needle/);
    expect(found.output).not.toMatch(/(?:^|\n)1 \[stderr\] Needle/);
    expect(found.output).toContain("Older retained output dropped:");
  });

  it("selects bounded case-insensitive source-line matches", async () => {
    const fixture = runtime({
      output: [
        { stream: "stdout", data: Buffer.from("zero\nneedle one\n") },
        { stream: "stderr", data: Buffer.from("NEEDLE two\nlast\n") },
      ],
    });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    const result = await fixture.runtime.result(
      snapshot.id,
      false,
      undefined,
      undefined,
      undefined,
      { find: " Needle " },
    );
    expect(result.output).toContain("2 [stdout] needle one");
    expect(result.output).toContain("3 [stderr] NEEDLE two");
    expect(result.selector).toMatchObject({
      type: "find",
      totalMatches: 2,
      selectedMatchAnchors: 2,
    });
  });

  it("keeps logical lines, stream identity, and mandatory notices bounded", async () => {
    const fixture = runtime({
      output: [
        { stream: "stdout", data: Buffer.from("first") },
        { stream: "stdout", data: Buffer.from(" line\n") },
        { stream: "stderr", data: Buffer.from("second\n") },
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

  it("keeps same-stream continuations together across interleaved callbacks", async () => {
    const fixture = runtime({ output: [] });
    bindings.push(fixture.binding);
    const snapshot = await start(fixture.runtime);
    fixture.controls[0].write("stdout", Buffer.from("stdout "));
    fixture.controls[0].write("stderr", Buffer.from("stderr\n"));
    fixture.controls[0].write("stdout", Buffer.from("continuation\n"));
    const result = await fixture.runtime.result(
      snapshot.id,
      false,
      undefined,
      undefined,
    );
    expect(result.output).toContain("[stdout] stdout continuation");
    expect(result.output).toContain("[stderr] stderr");
    expect(result.output).not.toContain("[stdout] stdout \n");
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
