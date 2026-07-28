import { describe, expect, it, vi } from "vitest";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  formatDetail,
  formatListRows,
  showAgentsDashboard,
} from "./agents-dashboard.js";
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
    canSteer: true,
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
      model: { provider: "test", id: "model" },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true as const,
          apiKey: "test-key",
          headers: { "x-test": "header" },
        })),
      },
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

let nextTestScope = 1;

function makeRuntime(
  records: RuntimeSnapshot[],
  messages: readonly unknown[] = [],
) {
  const listeners = new Map<string, Set<() => void>>();
  const runtime = {
    scope: `test-${nextTestScope++}`,
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
      return record
        ? {
            snapshot: record,
            messages: messages as never,
            activity: [],
            omittedMessages: 0,
            omittedActivity: 0,
            compactedHistory: false,
          }
        : undefined;
    }),
    subscribe: vi.fn((id: string, listener: () => void) => {
      const set = listeners.get(id) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(id, set);
      return vi.fn(() => set.delete(listener));
    }),
    steer: vi.fn(async (id: string) => {
      const record = records.find((candidate) => candidate.id === id);
      if (!record) {
        throw new Error(`Unknown ${id}`);
      }
      return record;
    }),
    summarise: vi.fn(async () => ({
      ok: true as const,
      text: "summary",
      stopReason: "stop" as never,
    })),
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
  it("renders effective thinking when Pi clamps the requested level", () => {
    expect(
      formatDetail(
        snapshot({ id: "agent-1", thinking: "max", effectiveThinking: "low" }),
      ),
    ).toContain("Thinking: low");
  });

  it("renders bounded inspection disclosure without authoritative result or error payloads", () => {
    const detail = formatDetail({
      snapshot: snapshot({
        id: "agent-1",
        result: "authoritative result must not render",
        error: "authoritative error must not render",
        health: {
          resultPreview: "safe result preview",
          compaction: { status: "failed", error: "safe compaction error" },
        },
      }),
      messages: [],
      activity: [],
      omittedMessages: 2,
      omittedActivity: 3,
      compactedHistory: true,
    });

    expect(detail).toContain("safe result preview");
    expect(detail).toContain("omitted 2 messages and 3 activity records");
    expect(detail).toContain("Compacted history: yes");
    expect(detail).not.toContain("authoritative result must not render");
    expect(detail).not.toContain("authoritative error must not render");
  });

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
        owner: { kind: "pipkin:implement", runId: "run", role: "implementer" },
        description: "no role words here",
        health: {
          turns: 2,
          tokensTotal: 1200,
          estimatedCost: 1.27,
          contextUsage: { tokens: 600, contextWindow: 1000, percent: 60 },
        },
      }),
      snapshot({
        id: "subagent-2",
        status: "completed",
        type: "Review",
        owner: "public-tool",
        description: "reviewer mentioned in description only",
        health: {
          turns: 1,
          tokensTotal: 800,
          contextUsage: { tokens: null, contextWindow: 1000, percent: null },
        },
      }),
    ]);

    expect(rows[0]).toMatch(/^subagent-1  running\s+General\/implementer\s+/);
    expect(rows[0]).toContain("  2/600");
    expect(rows[1]).toContain("  1/?");
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
      type: "pipkin:implement:implementer",
      owner: { kind: "pipkin:implement", runId: "run", role: "implementer" },
      description: "implement task",
      status: "completed",
    });
    const publicRuntime = makeRuntime([publicAgent]);
    const implementRuntime = makeRuntime([implementAgent]);
    const { ctx, notifications, selectCalls } = makeCtx([], { tui: false });
    let selection = 0;
    ctx.ui.select = vi.fn(async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return ["Stopped", options[1], "Inspect activity", "Back", undefined][
        selection++
      ];
    });

    await showAgentsDashboard([publicRuntime, implementRuntime], ctx as never);

    expect(selectCalls[1]?.options).toHaveLength(2);
    expect(selectCalls[1]?.options[0]).toContain("public agent");
    expect(selectCalls[1]?.options[1]).toContain("implement task");
    expect(notifications[0]?.message).toContain(
      "Type/role: pipkin:implement:implementer/implementer",
    );
    expect(implementRuntime.inspect).toHaveBeenCalledWith("subagent-1");
    expect(publicRuntime.inspect).not.toHaveBeenCalled();
  });

  it("keeps a selected runtime-qualified record through inspection before returning to the action loop", async () => {
    const first = snapshot({ id: "subagent-1", description: "identical" });
    const second = snapshot({ id: "subagent-1", description: "identical" });
    const firstRuntime = makeRuntime([first]);
    const secondRuntime = makeRuntime([second]);
    const { ctx } = makeCtx([], { tui: false });
    let selection = 0;
    ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) =>
        ["Running", options[1], "Inspect activity", "Back", undefined][
          selection++
        ],
    );

    await showAgentsDashboard([firstRuntime, secondRuntime], ctx as never);

    expect(secondRuntime.inspect).toHaveBeenCalledWith("subagent-1");
    expect(firstRuntime.inspect).not.toHaveBeenCalled();
    expect(selection).toBe(5);
  });

  it("refreshes a stale selection without dispatching an action", async () => {
    const selected = snapshot({ id: "selected" });
    const remaining = snapshot({ id: "remaining" });
    const runtime = makeRuntime([selected, remaining]);
    const { ctx, notifications } = makeCtx([], { tui: false });
    let selection = 0;
    ctx.ui.select = vi.fn(async (_title: string, options: string[]) => {
      if (selection++ === 0) {
        return "Running";
      }
      if (selection === 2) {
        runtime.retire("selected");
        return options[0];
      }
      return undefined;
    });

    await showAgentsDashboard(runtime, ctx as never);

    expect(notifications).toContainEqual({
      message: "Selected agent is no longer available; refreshed.",
      type: "warning",
    });
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.steer).not.toHaveBeenCalled();
  });

  it("offers guidance only for steerable running records", async () => {
    const running = snapshot({ id: "running", canSteer: false });
    const runtime = makeRuntime([running]);
    const { ctx, selectCalls } = makeCtx([], { tui: false });
    let selection = 0;
    ctx.ui.select = vi.fn(async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return ["Running", options[0], "Back", undefined][selection++];
    });

    await showAgentsDashboard(runtime, ctx as never);

    expect(selectCalls[2]?.options).toEqual([
      "Inspect activity",
      "Summarise activity",
      "Stop agent",
      "Back",
    ]);
  });

  it("does not offer terminal records guidance or stop actions", async () => {
    const terminal = snapshot({
      id: "terminal",
      status: "completed",
      canSteer: false,
    });
    const runtime = makeRuntime([terminal]);
    const { ctx, selectCalls } = makeCtx([], { tui: false });
    let selection = 0;
    ctx.ui.select = vi.fn(async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return ["Stopped", options[0], "Back", undefined][selection++];
    });

    await showAgentsDashboard(runtime, ctx as never);

    expect(selectCalls[2]?.options).toEqual([
      "Inspect activity",
      "Summarise activity",
      "Back",
    ]);
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
    const { ctx, notifications, selectCalls } = makeCtx([], { tui: false });
    let selection = 0;
    ctx.ui.select = vi.fn(async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return ["Stopped", options[0], "Inspect activity", "Back", undefined][
        selection++
      ];
    });

    await showAgentsDashboard(runtime, ctx as never);

    expect(selectCalls[1]?.options).toHaveLength(1);
    expect(selectCalls[1]?.options[0]).toContain("parent");
    expect(selectCalls[1]?.options[0]).not.toContain("child");
    expect(notifications[0]?.message).toContain("Nested explore children:");
    expect(notifications[0]?.message).toContain("child");
  });

  it("uses a static summary for running agents outside TUI mode", async () => {
    const running = snapshot({ id: "subagent-1", status: "running" });
    const runtime = makeRuntime([running]);
    const { ctx, notifications, custom } = makeCtx([], { tui: false });
    let selection = 0;
    ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) =>
        [options[0], options[0], "Inspect activity", "Back", undefined][
          selection++
        ],
    );

    await showAgentsDashboard(runtime, ctx as never);

    expect(custom).not.toHaveBeenCalled();
    expect(notifications[0]?.message).toContain("Agent subagent-1");
  });

  it("resolves active-model auth before summarising", async () => {
    const runtime = makeRuntime([snapshot({ id: "subagent-1" })]);
    const { ctx, notifications } = makeCtx([], { tui: false });
    let selection = 0;
    ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) =>
        [options[0], options[0], "Summarise activity", "Back", undefined][
          selection++
        ],
    );

    await showAgentsDashboard(runtime, ctx as never);

    expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(
      ctx.model,
    );
    expect(runtime.summarise).toHaveBeenCalledWith("subagent-1", ctx.model, {
      apiKey: "test-key",
      headers: { "x-test": "header" },
      env: undefined,
    });
    expect(notifications).toContainEqual({ message: "summary", type: "info" });
  });

  it("opens a live TUI inspector, renders fresh inspection data, and cleans up its subscription", async () => {
    const running = snapshot({
      id: "subagent-1",
      status: "running",
      health: {
        turns: 1,
        tokensTotal: 10,
        estimatedCost: 0.1,
        contextUsage: { tokens: 8, contextWindow: 100, percent: 8 },
        peakContextTokens: 9,
        lastAssistantText: "first",
      },
    });
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
    ];
    const runtime = makeRuntime([running], messages);
    const ui = makeCtx();
    let selection = 0;
    ui.ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) =>
        [options[0], options[0], "Inspect activity", "Back", undefined][
          selection++
        ],
    );

    const dashboard = showAgentsDashboard(runtime, ui.ctx as never);
    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalled());

    expect(runtime.listenerCount("subagent-1")).toBe(1);
    expect(ui.terminalInputListenerCount).toBe(1);
    expect(ui.component?.render(80).join("\n")).toContain("[Assistant]");
    expect(ui.component?.render(80).join("\n")).toContain("first");

    running.health = {
      ...running.health,
      turns: 2,
      tokensTotal: 30,
      estimatedCost: 1.27,
      contextUsage: { tokens: 20, contextWindow: 100, percent: 20 },
      peakContextTokens: 20,
      lastAssistantText: "second",
    };
    runtime.emit("subagent-1");

    expect(ui.requestRender).toHaveBeenCalled();
    const recentRendered = ui.component?.render(80).join("\n") ?? "";
    expect(recentRendered).toContain("second");
    for (let index = 0; index < 20; index += 1) {
      ui.component?.handleInput?.("k");
    }
    const rendered = ui.component?.render(80).join("\n") ?? "";
    expect(rendered).not.toContain("Active tool");
    expect(rendered).toContain("Turns/context: 2/20");
    expect(rendered).toContain("Estimated API cost: $1.27");
    expect(rendered).toContain("Peak context: 20");
    expect(rendered).toContain("Cumulative tokens: 30");

    expect(ui.sendTerminalInput("\u001b")).toBe(true);
    await dashboard;
    expect(runtime.listenerCount("subagent-1")).toBe(0);
    expect(ui.terminalInputListenerCount).toBe(0);
    expect(selection).toBe(5);
  });

  it("cancels only the TUI summary completion when closed", async () => {
    const runtime = makeRuntime([snapshot({ id: "subagent-1" })]);
    let signal: AbortSignal | undefined;
    runtime.summarise = vi.fn(
      async (
        _id: string,
        _model: unknown,
        _auth: unknown,
        _deps: unknown,
        requestSignal: AbortSignal,
      ) => {
        signal = requestSignal;
        return new Promise(() => {});
      },
    ) as never;
    const ui = makeCtx();
    let selection = 0;
    ui.ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) =>
        [options[0], options[0], "Summarise activity", "Back", undefined][
          selection++
        ],
    );

    const dashboard = showAgentsDashboard(runtime, ui.ctx as never);
    await vi.waitFor(() => expect(runtime.summarise).toHaveBeenCalledOnce());

    ui.closeCustom();
    await dashboard;

    expect(signal?.aborted).toBe(true);
    expect(selection).toBe(5);
  });

  it("renders retained terminal inspection data when a live inspector completes", async () => {
    const running = snapshot({
      id: "subagent-1",
      status: "running",
      health: { lastAssistantText: "live" },
    });
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "live" }] },
    ];
    const runtime = makeRuntime([running], messages);
    const ui = makeCtx();
    let selection = 0;
    ui.ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) =>
        [options[0], options[0], "Inspect activity", "Back", undefined][
          selection++
        ],
    );

    const dashboard = showAgentsDashboard(runtime, ui.ctx as never);
    await vi.waitFor(() => expect(ui.component).toBeDefined());

    running.status = "completed";
    running.health = { resultPreview: "completed result" };
    messages.splice(0, 1, {
      role: "assistant",
      content: [{ type: "text", text: "retained tail" }],
    });
    runtime.emit("subagent-1");

    const rendered = ui.component?.render(80).join("\n") ?? "";
    expect(ui.requestRender).toHaveBeenCalled();
    expect(rendered).toContain("completed result");
    expect(rendered).toContain("retained tail");
    expect(rendered).toContain("Transcript: in-memory child");
    expect(rendered).toContain("esc/q: close");
    expect(rendered).not.toContain("s/x: stop");

    ui.closeCustom();
    await dashboard;
    expect(runtime.listenerCount("subagent-1")).toBe(0);
  });

  it("requires confirmation before stopping from the live inspector", async () => {
    const running = snapshot({ id: "subagent-1", status: "running" });
    const runtime = makeRuntime([running]);
    const ui = makeCtx();
    let selection = 0;
    ui.ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) =>
        [options[0], options[0], "Inspect activity", "Back", undefined][
          selection++
        ],
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
    let selection = 0;
    ui.ctx.ui.select = vi.fn(
      async (_title: string, options: string[]) =>
        [options[0], options[0], "Inspect activity", undefined][selection++],
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
