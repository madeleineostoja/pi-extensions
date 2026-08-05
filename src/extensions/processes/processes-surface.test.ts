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
  it("uses headerless Running and Settled wide-list groups with a diagnostics landing page", () => {
    const running = snapshot("process-1", "running");
    const completed = {
      ...snapshot("process-2", "completed"),
      droppedBytes: 12,
      outputComplete: false,
    };
    const runtime = {
      snapshots: () => [running, completed],
      snapshot: (id: string) =>
        [running, completed].find((item) => item.id === id),
      subscribe: vi.fn(() => () => {}),
      subscribeRecord: vi.fn(() => () => {}),
    };
    const surface = new ProcessesSurface(
      runtime as never,
      { ui: { notify: vi.fn() } } as never,
      { requestRender: vi.fn() } as never,
      theme,
      vi.fn(),
    );

    expect(surface.render(100).join("\n")).toContain("Running");
    expect(surface.render(100).join("\n")).toContain("Settled");
    expect(surface.render(100).join("\n")).not.toContain("Status:");

    surface.handleInput("\r");
    const landing = surface.render(100).join("\n");
    expect(landing).toContain("View output");
    expect(landing).toContain("Stop process");
    expect(landing).toContain("npm test");
    expect(landing).toContain("/workspace");
    expect(landing).toContain("Settlement: running");
    expect(landing).not.toContain("Details");
    expect(landing).not.toContain("Tab");
  });

  it("follows live output until manual scrolling, then preserves position through updates", async () => {
    let current = snapshot("process-1", "running");
    let output = Array.from(
      { length: 81 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    let firstRetainedLine = 1;
    let prefixLines = 0;
    let recordListener:
      | ((value: ProcessSnapshot | undefined) => void)
      | undefined;
    const runtime = {
      snapshots: () => [current],
      snapshot: (id: string) => (id === current.id ? current : undefined),
      inspectionOutput: vi.fn(async () => ({
        output,
        firstRetainedLine,
        prefixLines,
      })),
      subscribe: vi.fn(() => () => {}),
      subscribeRecord: vi.fn((_: string, next: typeof recordListener) => {
        recordListener = next;
        return () => {};
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
    surface.handleInput("\r");
    surface.render(100);
    await flush();
    expect(surface.render(100).join("\n")).toContain("line 81");

    surface.handleInput("\u001b[A");
    expect(surface.render(100).join("\n")).toContain("line 57");
    output = [
      "Older retained output dropped: 100 bytes.",
      ...output.split("\n").slice(1),
      "line 82",
    ].join("\n");
    firstRetainedLine = 2;
    prefixLines = 1;
    recordListener?.(current);
    await flush();
    expect(surface.render(100).join("\n")).toContain("line 57");
    expect(surface.render(100).join("\n")).not.toContain("line 82");

    surface.handleInput("\u001b[F");
    expect(surface.render(100).join("\n")).toContain("line 82");
    output = [...output.split("\n"), "line 83"].join("\n");
    recordListener?.(current);
    await flush();
    expect(surface.render(100).join("\n")).toContain("line 83");
  });

  it("shows loading rather than output from a previous process", async () => {
    const first = snapshot("process-1", "running");
    const second = snapshot("process-2", "running");
    const resolvers = new Map<
      string,
      (value: {
        output: string;
        firstRetainedLine: number;
        prefixLines: number;
      }) => void
    >();
    const runtime = {
      snapshots: () => [first, second],
      snapshot: (id: string) => [first, second].find((item) => item.id === id),
      inspectionOutput: vi.fn(
        (id: string) =>
          new Promise<{
            output: string;
            firstRetainedLine: number;
            prefixLines: number;
          }>((resolve) => resolvers.set(id, resolve)),
      ),
      subscribe: vi.fn(() => () => {}),
      subscribeRecord: vi.fn(() => () => {}),
    };
    const surface = new ProcessesSurface(
      runtime as never,
      { ui: { notify: vi.fn() } } as never,
      { requestRender: vi.fn() } as never,
      theme,
      vi.fn(),
    );

    surface.handleInput("\r");
    surface.handleInput("\r");
    surface.render(100);
    resolvers.get("process-1")?.({
      output: "output from process one",
      firstRetainedLine: 1,
      prefixLines: 0,
    });
    await flush();
    expect(surface.render(100).join("\n")).toContain("output from process one");

    surface.handleInput("\u001b");
    surface.handleInput("\u001b");
    surface.handleInput("\u001b[B");
    surface.handleInput("\r");
    surface.handleInput("\r");

    const output = surface.render(100).join("\n");
    expect(output).toContain("Loading retained output…");
    expect(output).not.toContain("output from process one");
  });

  it("does not stop an evicted selection during confirmation", async () => {
    let records = [snapshot("process-1", "running")];
    let recordListener:
      | ((value: ProcessSnapshot | undefined) => void)
      | undefined;
    let resolveConfirmation!: (value: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const stop = vi.fn();
    const notify = vi.fn();
    const runtime = {
      snapshots: () => records,
      snapshot: (id: string) => records.find((record) => record.id === id),
      subscribe: vi.fn(() => () => {}),
      subscribeRecord: vi.fn((_: string, next: typeof recordListener) => {
        recordListener = next;
        return () => {};
      }),
      stop,
    };
    const surface = new ProcessesSurface(
      runtime as never,
      { ui: { confirm: vi.fn(() => confirmation), notify } } as never,
      { requestRender: vi.fn() } as never,
      theme,
      vi.fn(),
    );

    surface.handleInput("\r");
    surface.handleInput("\u001b[B");
    surface.handleInput("\r");
    records = [snapshot("process-2", "running")];
    recordListener?.(undefined);
    resolveConfirmation(true);
    await flush();

    expect(stop).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Process already settled or is no longer available.",
      "warning",
    );
  });
});
