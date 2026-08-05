import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentsSurface } from "./agents-surface.js";
import type {
  RuntimeInspection,
  RuntimeSnapshot,
  SubagentRuntime,
} from "./runtime.js";

const down = "\x1b[B";
const enter = "\r";
const escape = "\x1b";
const end = "\x1b[F";
const ansiPattern = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

beforeAll(() => initTheme("dark", false));

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    id: "agent-1",
    key: "runtime:agent-1",
    status: "running",
    owner: "public-tool",
    type: "Explore",
    description: "trace renderer ownership",
    cwd: "/repo",
    extensionBinding: "bound",
    canSteer: true,
    rosterVisibility: "show",
    timestamps: {
      queuedAt: "2024-01-01T00:00:00.000Z",
      startedAt: "2024-01-01T00:00:01.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
    },
    ...overrides,
  };
}

function inspectionFor(
  value: RuntimeSnapshot,
  overrides: Partial<RuntimeInspection> = {},
): RuntimeInspection {
  return {
    snapshot: value,
    messages: [],
    activity: [],
    records: [],
    omittedMessages: 0,
    omittedActivity: 0,
    compactedHistory: false,
    ...overrides,
  };
}

class FakeRuntime {
  listeners = new Set<() => void>();
  unsubscribe = vi.fn();
  steer = vi.fn(async () => undefined);
  stop = vi.fn();

  constructor(
    readonly scope: string,
    public items: RuntimeSnapshot[],
    public inspectionFactory: (
      value: RuntimeSnapshot,
    ) => RuntimeInspection = inspectionFor,
  ) {}

  snapshots(): RuntimeSnapshot[] {
    return this.items;
  }

  snapshot(id: string): RuntimeSnapshot | undefined {
    return this.items.find((item) => item.id === id);
  }

  inspect(id: string): RuntimeInspection | undefined {
    const current = this.snapshot(id);
    return current ? this.inspectionFactory(current) : undefined;
  }

  subscribeSnapshots(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribe();
      this.listeners.delete(listener);
    };
  }

  emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function fixture(
  runtimes: FakeRuntime[],
  confirm: () => Promise<boolean> = async () => false,
) {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
  const requestRender = vi.fn();
  const done = vi.fn();
  const notify = vi.fn();
  const ctx = { ui: { notify, confirm } } as unknown as ExtensionCommandContext;
  const surface = new AgentsSurface(
    runtimes as unknown as SubagentRuntime[],
    ctx,
    { requestRender, terminal: { rows: 40 } } as never,
    theme,
    done,
  );
  return { surface, requestRender, done, notify };
}

function rendered(surface: AgentsSurface, width = 120): string {
  return surface.render(width).join("\n");
}

function plain(value: string): string {
  return value.replace(ansiPattern, "");
}

function selectedLine(surface: AgentsSurface): string {
  return (
    plain(rendered(surface))
      .split("\n")
      .find((line) => line.includes("›")) ?? ""
  );
}

describe("AgentsSurface roster and landing", () => {
  it("renders headerless groups with aligned nested rows, right durations, and no hidden Implement workers", () => {
    const runtime = new FakeRuntime("runtime", [
      snapshot({ id: "parent", key: "runtime:parent", description: "parent" }),
      snapshot({
        id: "child",
        key: "runtime:child",
        owner: { kind: "nested", parentId: "parent", tool: "explore" },
        description: "child",
      }),
      snapshot({
        id: "hidden",
        key: "runtime:hidden",
        owner: { kind: "pipkin:implement", runId: "run", role: "implementer" },
        rosterVisibility: "hide",
        description: "hidden worker",
      }),
      snapshot({
        id: "done",
        key: "runtime:done",
        status: "completed",
        canSteer: false,
        description: "retained",
      }),
    ]);
    const text = plain(rendered(fixture([runtime]).surface, 100));

    expect(text).toContain("Active");
    expect(text).toContain("Retained");
    expect(text).not.toContain("Active ·");
    expect(text).not.toContain("hidden worker");
    const parent = text.split("\n").find((line) => line.includes("parent"))!;
    const child = text.split("\n").find((line) => line.includes("child"))!;
    expect(parent.indexOf("Explore")).toBe(child.indexOf("Explore"));
    expect(parent).toMatch(/\d/);
    expect(child).toMatch(/\d/);
  });

  it("keeps a stable roster selection and falls back safely when the selected record disappears", () => {
    const runtime = new FakeRuntime("runtime", [
      snapshot({ id: "a", key: "runtime:a", description: "first" }),
      snapshot({ id: "b", key: "runtime:b", description: "second" }),
      snapshot({ id: "c", key: "runtime:c", description: "third" }),
    ]);
    const { surface, notify } = fixture([runtime]);
    surface.handleInput(down);
    runtime.items = runtime.items.filter((item) => item.id !== "b");
    runtime.emit();

    expect(selectedLine(surface)).toContain("third");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("uses only approved landing facts and actions", () => {
    const current = snapshot({
      health: {
        contextUsage: { tokens: 82_000, contextWindow: 100_000, percent: 82 },
        estimatedCost: 0.04,
      },
    });
    const runtime = new FakeRuntime("runtime", [current], (value) =>
      inspectionFor(value, { omittedActivity: 1 }),
    );
    const { surface } = fixture([runtime]);
    surface.handleInput(enter);
    const text = plain(rendered(surface));

    expect(text).toMatch(/running · .+ · 82k context · \$0\.04/);
    expect(text).toContain("View activity");
    expect(text).toContain("Stop agent");
    expect(text).toContain("Back");
    expect(text).not.toMatch(/Details|Summaris|Model:|Tab:/);
    expect(text).not.toContain("Earlier activity is retained");
  });
});

describe("AgentsSurface activity and result", () => {
  it("renders lightweight chronological activity, keeps final result separate, and scrolls it", () => {
    const fullResult = `# Complete result\n\n- delivered\n\n\`\`\`ts\nconst complete = true;\n\`\`\`\n\n${"complete ".repeat(600)}`;
    const current = snapshot({ status: "completed", canSteer: false });
    const records: RuntimeInspection["records"] = [
      {
        kind: "message",
        role: "assistant",
        text: "I am tracing the renderer.",
      },
      {
        kind: "tool",
        toolCallId: "read",
        toolName: "read",
        status: "completed",
        arguments: { path: "src/a.ts", offset: 2, limit: 3 },
      },
      {
        kind: "tool",
        toolCallId: "bash",
        toolName: "bash",
        status: "failed",
        arguments: { command: "npm test" },
        error: "test failed",
      },
      {
        kind: "steering",
        status: "delivered",
        text: "focus the test",
        timestamp: "2024-01-01T00:00:00.500Z",
      },
      {
        kind: "retry",
        status: "scheduled",
        error: "rate limited",
        timestamp: "2024-01-01T00:00:01.000Z",
      },
      {
        kind: "compaction",
        status: "completed",
        reason: "threshold",
        timestamp: "2024-01-01T00:00:02.000Z",
      },
      { kind: "message", role: "final", text: fullResult },
    ];
    const runtime = new FakeRuntime("runtime", [current], (value) =>
      inspectionFor(value, {
        records,
        activity: records.filter(
          (record): record is RuntimeInspection["activity"][number] =>
            record.kind !== "message",
        ),
      }),
    );
    const { surface } = fixture([runtime]);
    surface.handleInput(enter);
    surface.handleInput(enter);
    const activity = plain(rendered(surface));

    expect(activity).toContain("I am tracing the renderer.");
    expect(activity).toContain("read  src/a.ts · lines 2–3 · completed");
    expect(activity).toContain("test failed");
    expect(activity).toContain("> focus the test");
    expect(activity).toContain("Retry scheduled");
    expect(activity).toContain("Compaction completed");
    expect(activity).not.toContain("Complete result");
    expect(activity).not.toContain("EXPANDED");

    surface.handleInput(escape);
    surface.handleInput(down);
    surface.handleInput(enter);
    expect(plain(rendered(surface))).toContain("Complete result");
    expect(plain(rendered(surface))).toContain("const complete = true;");
    surface.handleInput(end);
    expect(plain(rendered(surface))).toContain("complete complete");
  });

  it("scrolls Activity while keeping ordinary q input in guidance and Escape returns", () => {
    const current = snapshot();
    const records: RuntimeInspection["records"] = Array.from(
      { length: 30 },
      (_, index) => ({
        kind: "message" as const,
        role: "assistant" as const,
        text: `activity ${index}`,
      }),
    );
    const runtime = new FakeRuntime("runtime", [current], (value) =>
      inspectionFor(value, { records }),
    );
    const { surface } = fixture([runtime]);
    surface.handleInput(enter);
    surface.handleInput(enter);
    const beforeScroll = plain(rendered(surface));

    surface.handleInput(down);
    expect(plain(rendered(surface))).not.toBe(beforeScroll);
    surface.handleInput("q");
    expect(plain(rendered(surface))).toContain("Agent activity · Explore");
    expect(plain(rendered(surface))).toContain("q");

    surface.handleInput(escape);
    expect(plain(rendered(surface))).toContain("Agent · Explore");
  });

  it("keeps multiline tool summaries on one safe row", () => {
    const current = snapshot({ status: "completed", canSteer: false });
    const records: RuntimeInspection["records"] = [
      {
        kind: "tool",
        toolCallId: "bash",
        toolName: "bash",
        status: "failed",
        arguments: { command: "npm test\n-- --run [31mfocused" },
        error: "command failed\nwithout replaying output",
      },
    ];
    const runtime = new FakeRuntime("runtime", [current], (value) =>
      inspectionFor(value, {
        records,
        activity: records.filter(
          (record): record is RuntimeInspection["activity"][number] =>
            record.kind !== "message",
        ),
      }),
    );
    const { surface } = fixture([runtime]);
    surface.handleInput(enter);
    surface.handleInput(enter);
    const activity = rendered(surface, 46);
    const toolRow = activity.split("\n").find((line) => line.includes("bash"));

    expect(activity).toContain("npm test -- --run");
    expect(activity).not.toContain("npm test\n-- --run");
    expect(plain(activity)).not.toContain("");
    expect(toolRow).toContain("bash");
    expect(toolRow).toContain("· failed");
    expect(visibleWidth(toolRow ?? "")).toBeLessThanOrEqual(46);
    expect(
      activity.split("\n").filter((line) => line.includes("command failed")),
    ).toHaveLength(1);
  });

  it("edits and sends inline guidance only while the same agent remains steerable", async () => {
    const runtime = new FakeRuntime("runtime", [snapshot()]);
    const { surface, notify } = fixture([runtime]);
    surface.handleInput(enter);
    surface.handleInput(enter);
    rendered(surface);
    surface.handleInput("first direction");
    expect(plain(rendered(surface))).toContain("first direction");
    surface.handleInput("\x1b[13;2u");
    surface.handleInput("second line");
    surface.handleInput(enter);
    await Promise.resolve();
    expect(runtime.steer).toHaveBeenCalledWith(
      "agent-1",
      "first direction\nsecond line",
    );

    surface.handleInput("late direction");
    runtime.items = [snapshot({ status: "completed", canSteer: false })];
    runtime.emit();
    surface.handleInput(enter);
    await Promise.resolve();
    expect(runtime.steer).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("delivered"),
      "warning",
    );
  });

  it("keeps rendering width-safe and cleans subscriptions exactly once", () => {
    const runtime = new FakeRuntime("runtime", [snapshot()]);
    const { surface, done } = fixture([runtime]);
    for (const width of [1, 8, 24, 60]) {
      expect(
        surface.render(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
    surface.dispose();
    surface.dispose();
    expect(runtime.unsubscribe).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });
});
