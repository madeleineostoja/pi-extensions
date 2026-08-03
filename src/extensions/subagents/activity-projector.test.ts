import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANNEL } from "#ui/activity";
import { ActivityStore } from "../ui/activity-store.js";
import { SubagentActivityProjector } from "./activity-projector.js";

describe("Subagent Activity projector", () => {
  it("does not project the agent description or prompt", () => {
    const events = createEventBus();
    const store = new ActivityStore();
    events.on(ACTIVITY_CHANNEL, (event) => store.accept(event));
    const runtime = {
      snapshots: () => [
        {
          id: "agent-1",
          owner: "public-tool",
          type: "Explore",
          description: "Inspect the secret prompt text",
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
      title: "Explore agent",
    });
    expect(JSON.stringify(store.records)).not.toContain("secret prompt");
  });
});
