import { describe, expect, it, vi } from "vitest";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatListRows, showAgentsDashboard } from "./agents-dashboard.js";
import type {
  RuntimeInspection,
  RuntimeSnapshot,
  SubagentRuntime,
} from "./runtime.js";

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
    rosterVisibility: "show",
    timestamps: {
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: "2024-01-01T00:00:01.000Z",
      updatedAt: "2024-01-01T00:00:03.000Z",
    },
    ...overrides,
  };
}

function makeTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (text: string) => text,
    getBashModeBorderColor: () => (text: string) => text,
  } as unknown as Theme;
}

function makeCtx(selects: string[] = [], options: { tui?: boolean } = {}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const requestRender = vi.fn();
  const terminalInputHandlers: Array<
    (data: string) => { consume?: boolean; data?: string } | undefined
  > = [];
  let component: Component | undefined;
  let done: ((result?: unknown) => void) | undefined;
  const custom = vi.fn(
    (
      factory: (
        tui: TUI,
        theme: Theme,
        kb: unknown,
        done: (result?: unknown) => void,
      ) => Component,
    ) => {
      component = factory(
        { terminal: { rows: 24 }, requestRender } as unknown as TUI,
        makeTheme(),
        {},
        (result?: unknown) => done?.(result),
      );
      return new Promise((resolve) => {
        done = resolve;
      });
    },
  );
  return {
    ctx: {
      hasUI: options.tui ?? true,
      mode: options.tui === false ? "json" : "tui",
      ui: {
        notify: vi.fn((message: string, type?: string) => {
          notifications.push({ message, type });
        }),
        select: vi.fn(async (title: string, rows: string[]) => {
          selectCalls.push({ title, options: rows });
          return selects.shift();
        }),
        custom,
        onTerminalInput: vi.fn(
          (
            handler: (
              data: string,
            ) => { consume?: boolean; data?: string } | undefined,
          ) => {
            terminalInputHandlers.push(handler);
            return () => {
              const index = terminalInputHandlers.indexOf(handler);
              if (index >= 0) {
                terminalInputHandlers.splice(index, 1);
              }
            };
          },
        ),
      },
    },
    notifications,
    selectCalls,
    custom,
    requestRender,
    get component() {
      return component;
    },
    get terminalInputListenerCount() {
      return terminalInputHandlers.length;
    },
    sendTerminalInput(data: string) {
      for (const handler of terminalInputHandlers.slice()) {
        const result = handler(data);
        if (result?.consume) {
          return true;
        }
      }
      return false;
    },
    closeCustom() {
      component?.handleInput?.("\u001b");
    },
  };
}

function makeRuntime(
  records: RuntimeSnapshot[],
  messages: readonly unknown[] = [],
) {
  const listeners = new Map<string, Set<() => void>>();
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
    inspect: vi.fn((id: string): RuntimeInspection | undefined => {
      const record = records.find((candidate) => candidate.id === id);
      return record ? { snapshot: record, messages } : undefined;
    }),
    subscribe: vi.fn((id: string, listener: () => void) => {
      const set = listeners.get(id) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(id, set);
      return vi.fn(() => set.delete(listener));
    }),
    stop: vi.fn((id: string) => {
      const record = records.find((candidate) => candidate.id === id);
      if (!record) {
        throw new Error(`Unknown ${id}`);
      }
      record.status = "stopped";
      return record;
    }),
    emit(id: string) {
      for (const listener of listeners.get(id) ?? []) {
        listener();
      }
    },
    retire(id: string) {
      const index = records.findIndex((record) => record.id === id);
      if (index >= 0) {
        records.splice(index, 1);
      }
      const set = listeners.get(id);
      if (!set) {
        return;
      }
      const current = [...set];
      set.clear();
      for (const listener of current) {
        listener();
      }
    },
    listenerCount(id: string) {
      return listeners.get(id)?.size ?? 0;
    },
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

  it("formats list rows as aligned columns with structured role labels", () => {
    const rows = formatListRows([
      snapshot({
        id: "subagent-1",
        status: "running",
        type: "General",
        owner: { kind: "pi-implement", runId: "run", role: "implementer" },
        description: "no role words here",
        health: { turns: 2, tokensTotal: 1200, activeTool: "read" },
      }),
      snapshot({
        id: "subagent-2",
        status: "completed",
        type: "Review",
        owner: "public-tool",
        description: "reviewer mentioned in description only",
        health: { turns: 1, tokensTotal: 800 },
      }),
    ]);

    expect(rows[0]).toMatch(/^subagent-1  running\s+General\/implementer\s+/);
    expect(rows[0]).toContain("  2/1200  read");
    expect(rows[1]).toMatch(/^subagent-2  completed\s+Review\s+/);
    expect(rows[1]).not.toContain("Review/reviewer");
  });

  it("lists agents from multiple runtimes without merging duplicate ids", async () => {
    const publicAgent = snapshot({
      id: "subagent-1",
      type: "General",
      description: "public agent",
      status: "completed",
    });
    const implementAgent = snapshot({
      id: "subagent-1",
      type: "pi-implement:implementer",
      owner: { kind: "pi-implement", runId: "run", role: "implementer" },
      description: "implement task",
      status: "completed",
    });
    const publicRuntime = makeRuntime([publicAgent]);
    const implementRuntime = makeRuntime([implementAgent]);
    const { ctx, notifications, selectCalls } = makeCtx();

    ctx.ui.select = vi.fn(async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return options[1];
    });

    await showAgentsDashboard([publicRuntime, implementRuntime], ctx as never);

    expect(selectCalls[0]?.options).toHaveLength(2);
    expect(selectCalls[0]?.options[0]).toContain("public agent");
    expect(selectCalls[0]?.options[1]).toContain("implement task");
    expect(notifications[0]?.message).toContain(
      "Type/role: pi-implement:implementer/implementer",
    );
    expect(implementRuntime.inspect).toHaveBeenCalledWith("subagent-1");
    expect(publicRuntime.inspect).not.toHaveBeenCalled();
  });

  it("hides nested explore children from the top-level list and shows them in static parent detail", async () => {
    const parent = snapshot({
      id: "parent",
      status: "completed",
      description: "parent agent",
    });
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
      return options[0];
    });

    await showAgentsDashboard(runtime, ctx as never);

    expect(selectCalls[0]?.options).toHaveLength(1);
    expect(selectCalls[0]?.options[0]).toContain("parent");
    expect(selectCalls[0]?.options[0]).not.toContain("child");
    expect(notifications[0]?.message).toContain("Nested explore children:");
    expect(notifications[0]?.message).toContain("child");
  });

  it("uses a static summary for running agents outside TUI mode", async () => {
    const running = snapshot({ id: "subagent-1", status: "running" });
    const runtime = makeRuntime([running]);
    const { ctx, notifications, custom } = makeCtx([], { tui: false });
    ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) => options[0],
    );

    await showAgentsDashboard(runtime, ctx as never);

    expect(custom).not.toHaveBeenCalled();
    expect(notifications[0]?.message).toContain("Agent subagent-1");
  });

  it("opens a live TUI inspector, renders fresh inspection data, and cleans up its subscription", async () => {
    const running = snapshot({
      id: "subagent-1",
      status: "running",
      health: {
        turns: 1,
        tokensTotal: 10,
        activeTool: "read",
        lastAssistantText: "first",
      },
    });
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
    ];
    const runtime = makeRuntime([running], messages);
    const ui = makeCtx();
    ui.ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) => options[0],
    );

    const dashboard = showAgentsDashboard(runtime, ui.ctx as never);
    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalled());

    expect(runtime.listenerCount("subagent-1")).toBe(1);
    expect(ui.terminalInputListenerCount).toBe(1);
    expect(ui.component?.render(80).join("\n")).toContain("[Assistant]");
    expect(ui.component?.render(80).join("\n")).toContain("first");

    running.health = {
      ...running.health,
      activeTool: "bash",
      turns: 2,
      tokensTotal: 30,
      lastAssistantText: "second",
    };
    runtime.emit("subagent-1");

    expect(ui.requestRender).toHaveBeenCalled();
    const rendered = ui.component?.render(80).join("\n") ?? "";
    expect(rendered).toContain("Active tool: bash");
    expect(rendered).toContain("Turns/tokens: 2/30");
    expect(rendered).toContain("second");

    expect(ui.sendTerminalInput("\u001b")).toBe(true);
    await dashboard;
    expect(runtime.listenerCount("subagent-1")).toBe(0);
    expect(ui.terminalInputListenerCount).toBe(0);
  });

  it("requires confirmation before stopping from the live inspector", async () => {
    const running = snapshot({ id: "subagent-1", status: "running" });
    const runtime = makeRuntime([running]);
    const ui = makeCtx();
    ui.ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) => options[0],
    );

    const dashboard = showAgentsDashboard(runtime, ui.ctx as never);
    await vi.waitFor(() => expect(ui.component).toBeDefined());

    ui.component?.handleInput?.("s");
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(ui.component?.render(80).join("\n")).toContain(
      "Press s or x again to stop this agent.",
    );

    ui.component?.handleInput?.("s");
    expect(runtime.stop).toHaveBeenCalledWith("subagent-1");

    ui.closeCustom();
    await dashboard;
  });

  it("re-renders and releases the live inspector subscription when a session replacement retires the record", async () => {
    const running = snapshot({ id: "subagent-1", status: "running" });
    const runtime = makeRuntime([running]);
    const ui = makeCtx();
    ui.ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) => options[0],
    );

    const dashboard = showAgentsDashboard(runtime, ui.ctx as never);
    await vi.waitFor(() => expect(ui.component).toBeDefined());
    expect(runtime.listenerCount("subagent-1")).toBe(1);

    runtime.retire("subagent-1");

    expect(ui.requestRender).toHaveBeenCalled();
    expect(runtime.listenerCount("subagent-1")).toBe(0);
    expect(ui.component?.render(80).join("\n")).toContain(
      "Agent is no longer available in this session.",
    );

    ui.closeCustom();
    await dashboard;
    expect(runtime.listenerCount("subagent-1")).toBe(0);
  });

  it("does not restore previous-session records into the dashboard", async () => {
    const runtime = makeRuntime([]);
    const { ctx } = makeCtx();

    await showAgentsDashboard(runtime, ctx as never);

    expect(runtime.snapshots).toHaveBeenCalledWith({ includeNested: true });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});
