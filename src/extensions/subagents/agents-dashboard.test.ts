import { describe, expect, it } from "vitest";
import { staticAgentsProjection } from "./agents-dashboard.js";
import type { RuntimeSnapshot, SubagentRuntime } from "./runtime.js";

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    id: "agent-1",
    key: "agent-1",
    status: "running",
    owner: "public-tool",
    type: "General",
    description: "inspect a focused task",
    cwd: "/repo",
    extensionBinding: "bound",
    rosterVisibility: "show",
    timestamps: {
      queuedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("/agents non-TUI projection", () => {
  it("uses one bounded active/retained projection with typed Implement roles", () => {
    const runtime = {
      snapshots: () => [
        snapshot({
          owner: { kind: "pipkin:implement", runId: "run", role: "reviewer" },
        }),
        snapshot({ id: "done", key: "done", status: "completed" }),
      ],
    } as unknown as SubagentRuntime;

    expect(staticAgentsProjection(runtime)).toBe(
      "Active agents\n1. running · Implement: Reviewer · inspect a focused task\nRetained agents\n1. completed · General · inspect a focused task",
    );
  });
});
