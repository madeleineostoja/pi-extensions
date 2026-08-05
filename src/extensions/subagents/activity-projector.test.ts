import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANNEL } from "#ui/activity";
import { ActivityStore } from "../ui/activity-store.js";
import { SubagentActivityProjector } from "./activity-projector.js";

describe("Subagent Activity projector", () => {
  it("projects the bounded task description while retaining the agent type", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const runtime = {
      snapshots: () => [
        {
          id: "agent-1",
          owner: "public-tool",
          type: "Explore",
          description: "Inspect the code\ncarefully",
          rosterVisibility: "show",
          status: "running",
          timestamps: {
            startedAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
          },
        },
      ],
      subscribeSnapshots: vi.fn(() => () => {}),
    };

    const projector = new SubagentActivityProjector(runtime as never, events);
    projector.start();

    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      label: "Agent · Explore",
      title: "Inspect the code carefully",
    });
  });

  it("removes terminal work and notifies a detached background failure once", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    let snapshots: any[] = [
      {
        id: "agent-1",
        owner: "public-tool",
        type: "Explore",
        description: "Inspect renderer ownership",
        rosterVisibility: "show",
        launchMode: "background" as const,
        status: "running" as const,
        health: {
          contextUsage: { tokens: 82_000 },
          lastAssistantText: "Reading renderer registration paths.",
        },
        timestamps: {
          startedAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
        },
      },
    ];
    let listener: (() => void) | undefined;
    const runtime = {
      snapshots: () => snapshots,
      subscribeSnapshots: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    };
    const notify = vi.fn();
    const projector = new SubagentActivityProjector(runtime as never, events);
    projector.start(notify);
    expect(store.records[0]).toMatchObject({
      metric: "82k context",
      detail: "Reading renderer registration paths.",
    });

    snapshots = [
      {
        ...snapshots[0],
        status: "failed" as const,
        error: "provider unavailable",
      },
    ];
    listener?.();
    listener?.();

    expect(store.records).toEqual([]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "Background subagent agent-1 failed: provider unavailable",
      "warning",
    );
  });
});
