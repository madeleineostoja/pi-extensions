import { describe, expect, it, vi } from "vitest";
import {
  SubagentRosterController,
  elapsedLabel,
  formatRosterRows,
} from "./roster.js";
import type { RuntimeSnapshot, SubagentRuntime } from "./runtime.js";

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    id: "subagent-1",
    status: "running",
    owner: "public-tool",
    type: "General",
    description: "do work",
    cwd: "/workspace",
    extensionBinding: "bound",
    rosterVisibility: "show",
    timestamps: {
      queuedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    },
    health: {
      activeTool: "read",
      turns: 2,
      tokensTotal: 123,
    },
    ...overrides,
  };
}

function makeRuntime(snapshots: RuntimeSnapshot[]) {
  return {
    snapshots: vi.fn(() => snapshots),
  } as unknown as SubagentRuntime;
}

function makeCtx() {
  return {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget: vi.fn(),
    },
  } as any;
}

describe("subagent roster", () => {
  it("formats active roster rows with progress fields", () => {
    const rows = formatRosterRows([snapshot()]);

    expect(rows.join("\n")).toContain("General");
    expect(rows.join("\n")).toContain("running");
    expect(rows.join("\n")).toContain("read");
    expect(rows.join("\n")).toContain("2");
    expect(rows.join("\n")).toContain("123");
    expect(rows.join("\n")).toContain("do work");
  });

  it("omits agents hidden from the generic roster", () => {
    const rows = formatRosterRows([
      snapshot({ id: "visible", description: "visible work" }),
      snapshot({
        id: "hidden",
        description: "hidden work",
        rosterVisibility: "hide",
      }),
    ]);

    expect(rows.join("\n")).toContain("visible work");
    expect(rows.join("\n")).not.toContain("hidden work");
  });

  it("formats larger token counts compactly", () => {
    const rows = formatRosterRows([
      snapshot({ health: { activeTool: "read", turns: 2, tokensTotal: 1500 } }),
      snapshot({
        health: { activeTool: "bash", turns: 3, tokensTotal: 10000 },
      }),
      snapshot({
        health: { activeTool: "edit", turns: 4, tokensTotal: 110000 },
      }),
      snapshot({
        health: { activeTool: "Agent", turns: 5, tokensTotal: 1420280 },
      }),
    ]);

    expect(rows.join("\n")).toContain("1.5k");
    expect(rows.join("\n")).toContain("10k");
    expect(rows.join("\n")).toContain("110k");
    expect(rows.join("\n")).toContain("1.42M");
    expect(rows.join("\n")).not.toContain("1420.28k");
  });

  it("separates minutes and seconds in elapsed labels", () => {
    expect(
      elapsedLabel(
        snapshot({
          timestamps: {
            queuedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:01:05.000Z",
            updatedAt: "2026-01-01T00:01:05.000Z",
          },
        }),
      ),
    ).toBe("1m 05s");
  });

  it("adds, updates, and removes the widget during the active lifecycle", () => {
    vi.useFakeTimers();
    try {
      const snapshots = [snapshot()];
      const runtime = makeRuntime(snapshots);
      const ctx = makeCtx();
      const controller = new SubagentRosterController(runtime);

      controller.track(ctx);
      expect(ctx.ui.setWidget).toHaveBeenCalledWith(
        "subagents",
        expect.any(Function),
        { placement: "aboveEditor" },
      );
      const factory = ctx.ui.setWidget.mock.calls[0][1];
      const tui = { requestRender: vi.fn(), terminal: { rows: 24 } };
      const widget = factory(tui, {
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      } as any);

      vi.advanceTimersByTime(350);
      expect(tui.requestRender).toHaveBeenCalled();
      snapshots[0] = snapshot({
        health: { activeTool: "bash", turns: 3, tokensTotal: 456 },
      });
      expect(widget.render(120).join("\n")).toContain("bash");
      expect(widget.render(120).join("\n")).toContain("456");

      snapshots[0] = snapshot({
        status: "completed",
        timestamps: {
          queuedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:05.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      });
      vi.advanceTimersByTime(350);
      expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("subagents", undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up old UI context when the context is replaced", () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime([snapshot()]);
      const first = makeCtx();
      const second = makeCtx();
      const controller = new SubagentRosterController(runtime);

      controller.track(first);
      controller.track(second);

      expect(first.ui.setWidget).toHaveBeenLastCalledWith(
        "subagents",
        undefined,
      );
      expect(second.ui.setWidget).toHaveBeenCalledWith(
        "subagents",
        expect.any(Function),
        { placement: "aboveEditor" },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call UI or inject transcript messages outside TUI", () => {
    const runtime = makeRuntime([snapshot()]);
    const controller = new SubagentRosterController(runtime);
    const ctx = {
      mode: "print",
      hasUI: false,
      ui: { setWidget: vi.fn() },
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as any;

    controller.track(ctx);

    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    expect(ctx.appendEntry).not.toHaveBeenCalled();
  });
});
