import { describe, expect, it, vi } from "vitest";
import { showAgentsDashboard } from "./agents-dashboard.js";
import type { RuntimeSnapshot, SubagentRuntime } from "./runtime.js";

function snapshot(
  overrides: Partial<RuntimeSnapshot> & { id: string },
): RuntimeSnapshot {
  return {
    status: "running",
    owner: "public-tool",
    type: "General",
    description: "test agent",
    cwd: "/repo",
    extensionBinding: "bound",
    timestamps: {
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: "2024-01-01T00:00:01.000Z",
      updatedAt: "2024-01-01T00:00:03.000Z",
    },
    ...overrides,
  };
}

function makeCtx(selects: string[] = []) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  return {
    ctx: {
      ui: {
        notify: vi.fn((message: string, type?: string) => {
          notifications.push({ message, type });
        }),
        select: vi.fn(async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          return selects.shift();
        }),
      },
    },
    notifications,
    selectCalls,
  };
}

function makeRuntime(records: RuntimeSnapshot[]) {
  const runtime = {
    snapshots: vi.fn(({ includeNested }: { includeNested?: boolean } = {}) =>
      includeNested
        ? records
        : records.filter(
            (record) =>
              !(
                typeof record.owner === "object" &&
                record.owner.kind === "nested"
              ),
          ),
    ),
    snapshot: vi.fn((id: string) => records.find((record) => record.id === id)),
    stop: vi.fn((id: string) => {
      const record = records.find((candidate) => candidate.id === id);
      if (!record) {
        throw new Error(`Unknown ${id}`);
      }
      record.status = "stopped";
      return record;
    }),
  };
  return runtime as unknown as SubagentRuntime & typeof runtime;
}

describe("/agents dashboard", () => {
  it("notifies clearly when no current-session agents exist", async () => {
    const runtime = makeRuntime([]);
    const { ctx, notifications } = makeCtx();

    await showAgentsDashboard(runtime, ctx as never);

    expect(notifications).toEqual([
      { message: "No current-session agents.", type: "info" },
    ]);
  });

  it("shows status and health data for running and completed top-level agents", async () => {
    const runtime = makeRuntime([
      snapshot({
        id: "subagent-1",
        status: "running",
        type: "General",
        owner: "public-tool",
        description: "interactive helper",
        health: {
          turns: 2,
          toolUses: 3,
          tokensTotal: 1200,
          activeTool: "read",
          lastActivity: "2024-01-01T00:00:04.000Z",
        },
      }),
      snapshot({
        id: "subagent-2",
        status: "completed",
        type: "Review",
        owner: { kind: "internal", name: "pi-implement" },
        description: "review task 1/2",
        health: { turns: 1, toolUses: 0, tokensTotal: 800 },
      }),
    ]);
    const { ctx, selectCalls } = makeCtx();

    await showAgentsDashboard(runtime, ctx as never);

    expect(selectCalls[0]?.options).toHaveLength(2);
    expect(selectCalls[0]?.options[0]).toContain("subagent-1 running");
    expect(selectCalls[0]?.options[0]).toContain("2 turns");
    expect(selectCalls[0]?.options[0]).toContain("3 tools");
    expect(selectCalls[0]?.options[0]).toContain("1200 tokens");
    expect(selectCalls[0]?.options[0]).toContain("tool read");
    expect(selectCalls[0]?.options[1]).toContain("subagent-2 completed");
    expect(selectCalls[0]?.options[1]).toContain("internal:pi-implement");
  });

  it("hides nested explore children from the top-level list and shows them in parent detail", async () => {
    const parent = snapshot({ id: "parent", description: "parent agent" });
    const child = snapshot({
      id: "child",
      type: "Explore",
      description: "explore: find call sites",
      owner: { kind: "nested", parentId: "parent", tool: "explore" },
      health: { resultPreview: "nested result" },
    });
    const runtime = makeRuntime([parent, child]);
    const { ctx, notifications, selectCalls } = makeCtx();

    ctx.ui.select = vi.fn(async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return selectCalls.length === 1 ? options[0] : "Close";
    });

    await showAgentsDashboard(runtime, ctx as never);

    expect(selectCalls[0]?.options).toHaveLength(1);
    expect(selectCalls[0]?.options[0]).toContain("parent");
    expect(selectCalls[0]?.options[0]).not.toContain("child");
    expect(selectCalls[1]?.title).toContain("Nested explore children:");
    expect(selectCalls[1]?.title).toContain("child running");
    expect(notifications).toEqual([]);
  });

  it("stops running records from the detail view", async () => {
    const running = snapshot({ id: "subagent-1", status: "running" });
    const runtime = makeRuntime([running]);
    const { ctx } = makeCtx();
    ctx.ui.select = vi.fn(async (_title: string, options: string[]) =>
      options.includes("Stop agent") ? "Stop agent" : options[0],
    );

    await showAgentsDashboard(runtime, ctx as never);

    expect(runtime.stop).toHaveBeenCalledWith("subagent-1");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Stopped agent subagent-1.",
      "warning",
    );
  });

  it("does not restore previous-session records into the dashboard", async () => {
    const runtime = makeRuntime([]);
    const { ctx } = makeCtx();

    await showAgentsDashboard(runtime, ctx as never);

    expect(runtime.snapshots).toHaveBeenCalledWith({ includeNested: true });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});
