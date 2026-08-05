import { describe, expect, it } from "vitest";
import { staticAgentsProjection } from "./agents-dashboard.js";
import type { RuntimeSnapshot, SubagentRuntime } from "./runtime.js";

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    id: "agent-1",
    key: "agent-1",
    status: "running",
    owner: "public-tool",
    type: "Worker",
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
  it("uses one bounded status-driven projection with typed Implement roles", () => {
    const runtime = {
      snapshots: () => [
        snapshot({
          owner: { kind: "pipkin:implement", runId: "run", role: "reviewer" },
        }),
        snapshot({ id: "done", key: "done", status: "completed" }),
      ],
    } as unknown as SubagentRuntime;

    expect(staticAgentsProjection(runtime)).toBe(
      "● Implement: Reviewer · inspect a focused task\n✓ Worker · inspect a focused task",
    );
  });

  it("keeps live agents visible ahead of bounded retained history", () => {
    const runtime = {
      snapshots: () => [
        ...Array.from({ length: 24 }, (_, index) =>
          snapshot({
            id: `done-${index}`,
            key: `done-${index}`,
            status: "completed",
            description: `retained ${index}`,
          }),
        ),
        snapshot({ id: "live", key: "live", description: "live work" }),
      ],
    } as unknown as SubagentRuntime;

    const projection = staticAgentsProjection(runtime);
    expect(projection.split("\n")[0]).toBe("● Worker · live work");
    expect(projection).not.toContain("retained 23");
  });
});
