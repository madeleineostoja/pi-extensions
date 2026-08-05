import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_CHANNEL } from "#ui/activity";
import { ActivityStore } from "../ui/activity-store.js";
import { ProcessActivityProjector } from "./activity-projector.js";
import type { ProcessSnapshot } from "./runtime.js";

function snapshot(
  status: ProcessSnapshot["status"],
  description = "Build the project",
): ProcessSnapshot {
  return {
    id: "process-1",
    status,
    description,
    command: "npm test -- --sensitive",
    cwd: "/secret/worktree",
    pid: 1234,
    exitCode: status === "completed" ? 0 : null,
    signal: null,
    startedAt: "2026-03-09T10:00:00.000Z",
    ...(status === "running" ? {} : { endedAt: "2026-03-09T10:01:00.000Z" }),
    retainedBytes: 4096,
    droppedBytes: 512,
    outputComplete: true,
  };
}

describe("ProcessActivityProjector", () => {
  it("projects only bounded operational process state", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    const activityEvents: unknown[] = [];
    events.on(ACTIVITY_CHANNEL, (event) => {
      activityEvents.push(event);
      store.accept(event);
    });
    let snapshots = [snapshot("running", `Build\nthe\u0000project`)];
    let listener: ((value: readonly ProcessSnapshot[]) => void) | undefined;
    const runtime = {
      snapshots: () => snapshots,
      subscribe: vi.fn((next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
    };

    const projector = new ProcessActivityProjector(runtime as never, events);
    projector.start();

    expect(store.records).toEqual([
      expect.objectContaining({
        source: "processes",
        id: "entry-1",
        label: "Process",
        title: "Build the project",
        state: "running",
      }),
    ]);
    expect(JSON.stringify(store.records)).not.toContain("npm test");
    expect(JSON.stringify(store.records)).not.toContain("/secret/worktree");
    expect(JSON.stringify(store.records)).not.toContain("1234");
    expect(JSON.stringify(activityEvents)).not.toContain("process-1");

    snapshots = [snapshot("failed")];
    listener?.(snapshots);
    expect(store.records).toEqual([]);

    snapshots = [];
    listener?.(snapshots);
    expect(store.records).toEqual([]);

    projector.dispose();
    expect(store.records).toEqual([]);
  });

  it("notifies once for a failure after a process has started", () => {
    const events = createEventBus();
    let snapshots = [snapshot("running")];
    let listener: ((value: readonly ProcessSnapshot[]) => void) | undefined;
    const runtime = {
      snapshots: () => snapshots,
      subscribe: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    };
    const notify = vi.fn();
    const projector = new ProcessActivityProjector(runtime as never, events);
    projector.start(notify);

    snapshots = [snapshot("failed")];
    listener?.(snapshots);
    listener?.(snapshots);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "Managed process failed: Build the project",
      "warning",
    );
  });
});
