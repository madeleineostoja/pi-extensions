import { describe, expect, it, vi } from "vitest";
import { ProcessesSurface } from "./processes-surface.js";
import type { ProcessSnapshot } from "./runtime.js";

function snapshot(
  id: string,
  status: ProcessSnapshot["status"],
): ProcessSnapshot {
  return {
    id,
    status,
    description: `Build ${id}`,
    command: "npm test",
    cwd: "/workspace",
    pid: 42,
    exitCode: status === "completed" ? 0 : null,
    signal: null,
    startedAt: "2026-03-09T10:00:00.000Z",
    ...(status === "running" ? {} : { endedAt: "2026-03-09T10:01:00.000Z" }),
    retainedBytes: 10,
    droppedBytes: 0,
    outputComplete: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

describe("ProcessesSurface", () => {
  it("updates an inspected record through its exact subscription and closes it on back", async () => {
    let current = snapshot("process-1", "running");
    let completeListener: (() => void) | undefined;
    let recordListener:
      | ((value: ProcessSnapshot | undefined) => void)
      | undefined;
    const unsubscribeComplete = vi.fn();
    const unsubscribeRecord = vi.fn();
    const runtime = {
      snapshots: () => [current],
      snapshot: (id: string) => (id === current.id ? current : undefined),
      result: vi.fn(async () => ({ output: "recent output" })),
      stop: vi.fn(),
      subscribe: vi.fn((next: () => void) => {
        completeListener = next;
        return unsubscribeComplete;
      }),
      subscribeRecord: vi.fn((id: string, next: typeof recordListener) => {
        expect(id).toBe("process-1");
        recordListener = next;
        return unsubscribeRecord;
      }),
    };
    const surface = new ProcessesSurface(
      runtime as never,
      { ui: { notify: vi.fn() } } as never,
      { requestRender: vi.fn() } as never,
      theme,
      vi.fn(),
    );

    surface.handleInput("\r");
    await flush();
    expect(runtime.subscribeRecord).toHaveBeenCalledOnce();
    expect(surface.render(100).join("\n")).toContain("Stop");

    current = snapshot("process-1", "completed");
    recordListener?.(current);
    await flush();
    expect(surface.render(100).join("\n")).not.toContain("Stop");
    expect(surface.render(100).join("\n")).toContain("Status: completed");

    surface.handleInput("\u001b");
    expect(unsubscribeRecord).toHaveBeenCalledOnce();
    surface.dispose();
    expect(unsubscribeComplete).toHaveBeenCalledOnce();
    expect(completeListener).toBeDefined();
  });

  it("does not stop an evicted selection or a replacement during confirmation", async () => {
    let records = [snapshot("process-1", "running")];
    let completeListener: (() => void) | undefined;
    let recordListener:
      | ((value: ProcessSnapshot | undefined) => void)
      | undefined;
    const unsubscribeComplete = vi.fn();
    const unsubscribeRecord = vi.fn();
    const confirmation = deferred<boolean>();
    const stop = vi.fn();
    const notify = vi.fn();
    const runtime = {
      snapshots: () => records,
      snapshot: (id: string) => records.find((record) => record.id === id),
      result: vi.fn(async () => ({ output: "recent output" })),
      stop,
      subscribe: vi.fn((next: () => void) => {
        completeListener = next;
        return unsubscribeComplete;
      }),
      subscribeRecord: vi.fn((id: string, next: typeof recordListener) => {
        expect(id).toBe("process-1");
        recordListener = next;
        return unsubscribeRecord;
      }),
    };
    const surface = new ProcessesSurface(
      runtime as never,
      { ui: { confirm: vi.fn(() => confirmation.promise), notify } } as never,
      { requestRender: vi.fn() } as never,
      theme,
      vi.fn(),
    );

    surface.handleInput("\r");
    await flush();
    surface.handleInput("\r");
    await flush();

    records = [snapshot("process-2", "running")];
    recordListener?.(undefined);
    completeListener?.();
    confirmation.resolve(true);
    await flush();

    expect(stop).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Process already settled or is no longer available.",
      "warning",
    );
    expect(surface.render(100).join("\n")).toContain("Build process-2");
    expect(unsubscribeRecord).toHaveBeenCalledOnce();
    surface.dispose();
    expect(unsubscribeComplete).toHaveBeenCalledOnce();
  });
});
