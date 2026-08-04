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
const tab = "\t";
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
    type: "Worker",
    description: "first agent",
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
  readonly scope: string;
  items: RuntimeSnapshot[];
  inspectionFactory: (value: RuntimeSnapshot) => RuntimeInspection;
  listeners = new Set<() => void>();
  unsubscribe = vi.fn();
  steer = vi.fn(async () => undefined);
  stop = vi.fn();
  summarise = vi.fn(
    async (
      _id: string,
      _model: unknown,
      _auth: unknown,
      _deps: unknown,
      _signal?: AbortSignal,
    ) => ({ ok: true as const, text: "summary" }),
  );

  constructor(
    scope: string,
    items: RuntimeSnapshot[],
    inspectionFactory: (
      value: RuntimeSnapshot,
    ) => RuntimeInspection = inspectionFor,
  ) {
    this.scope = scope;
    this.items = items;
    this.inspectionFactory = inspectionFactory;
  }

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture(
  runtimes: FakeRuntime[],
  options: {
    input?: () => Promise<string | undefined>;
    confirm?: () => Promise<boolean>;
    auth?: () => Promise<
      | { ok: true; apiKey: string; headers: {}; env: {} }
      | { ok: false; error: string }
    >;
  } = {},
) {
  let themeMark = "\x1b[31m";
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => `${themeMark}${text}\x1b[0m`,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
  const requestRender = vi.fn();
  const done = vi.fn();
  const notify = vi.fn();
  const input = vi.fn(options.input ?? (async () => undefined));
  const confirm = vi.fn(options.confirm ?? (async () => false));
  const getApiKeyAndHeaders = vi.fn(
    options.auth ??
      (async () => ({
        ok: true as const,
        apiKey: "key",
        headers: {},
        env: {},
      })),
  );
  const ctx = {
    model: { id: "model", provider: "provider", input: ["text"] },
    modelRegistry: { getApiKeyAndHeaders },
    ui: { notify, input, confirm },
  } as unknown as ExtensionCommandContext;
  const surface = new AgentsSurface(
    runtimes as unknown as SubagentRuntime[],
    ctx,
    { requestRender } as never,
    theme,
    done,
  );
  return {
    surface,
    requestRender,
    done,
    notify,
    input,
    confirm,
    setThemeMark: (value: string) => {
      themeMark = value;
    },
  };
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
      .find((line) => line.includes("→")) ?? ""
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentsSurface roster", () => {
  it("labels retained-only rosters truthfully and preserves generic depth with each descendant's status", () => {
    const retained = new FakeRuntime("retained", [
      snapshot({
        id: "done",
        key: "retained:done",
        status: "completed",
        description: "retained only",
      }),
    ]);
    const retainedSurface = fixture([retained]).surface;

    expect(plain(rendered(retainedSurface))).toContain("Retained · ✓ Worker");
    expect(plain(rendered(retainedSurface))).not.toContain("Active · ✓ Worker");

    const parent = snapshot({
      id: "parent",
      key: "tree:parent",
      description: "parent",
    });
    const child = snapshot({
      id: "child",
      key: "tree:child",
      status: "completed",
      owner: { kind: "nested", parentId: "parent", tool: "explore" },
      description: "settled child",
    });
    const grandchild = snapshot({
      id: "grandchild",
      key: "tree:grandchild",
      owner: { kind: "nested", parentId: "child", tool: "explore" },
      description: "active grandchild",
    });
    const unrelated = snapshot({
      id: "other",
      key: "tree:other",
      description: "unrelated",
    });
    const treeSurface = fixture([
      new FakeRuntime("tree", [parent, unrelated, child, grandchild]),
    ]).surface;
    const text = plain(rendered(treeSurface));

    expect(text.indexOf("parent")).toBeLessThan(text.indexOf("settled child"));
    expect(text.indexOf("settled child")).toBeLessThan(
      text.indexOf("active grand"),
    );
    expect(text.indexOf("active grand")).toBeLessThan(
      text.indexOf("unrelated"),
    );
    expect(text).toContain("  ↳ ✓ Worker · settled child");
    expect(text).toContain("    ↳ ● Worker · active grand");
    expect(text).not.toContain("Retained ·   ↳ ✓ Worker");
  });

  it("keeps stable roster values and falls back to the nearest old position on roster and inspector loss", () => {
    const runtime = new FakeRuntime("runtime", [
      snapshot({ id: "a", key: "runtime:a", description: "first" }),
      snapshot({ id: "b", key: "runtime:b", description: "second" }),
      snapshot({ id: "c", key: "runtime:c", description: "third" }),
    ]);
    const rosterFixture = fixture([runtime]);
    rosterFixture.surface.handleInput(down);
    runtime.items = runtime.items.filter((item) => item.id !== "b");
    runtime.emit();

    expect(selectedLine(rosterFixture.surface)).toContain("● Worker · third");
    expect(rosterFixture.notify).toHaveBeenCalledTimes(1);

    const inspectorRuntime = new FakeRuntime("runtime", [
      snapshot({ id: "a", key: "runtime:a", description: "first" }),
      snapshot({ id: "b", key: "runtime:b", description: "second" }),
      snapshot({ id: "c", key: "runtime:c", description: "third" }),
    ]);
    const inspectorFixture = fixture([inspectorRuntime]);
    inspectorFixture.surface.handleInput(down);
    inspectorFixture.surface.handleInput(enter);
    inspectorRuntime.items = inspectorRuntime.items.filter(
      (item) => item.id !== "b",
    );
    inspectorRuntime.emit();

    const text = plain(rendered(inspectorFixture.surface));
    expect(text).toContain("Agents");
    expect(selectedLine(inspectorFixture.surface)).toContain(
      "● Worker · third",
    );
    expect(inspectorFixture.notify).toHaveBeenCalledTimes(1);
  });

  it("renders every exhaustive Implement role without grouping workers", () => {
    const runtime = new FakeRuntime(
      "implement",
      (["planner", "implementer", "reviewer"] as const).map((role) =>
        snapshot({
          id: role,
          key: `implement:${role}`,
          owner: { kind: "pipkin:implement", runId: "run", role },
          description: `${role} assignment`,
          rosterVisibility: "hide",
        }),
      ),
    );

    const text = rendered(fixture([runtime]).surface);
    expect(text).toContain("Implement: Planner");
    expect(text).toContain("Implement: Implementer");
    expect(text).toContain("Implement: Reviewer");
  });
});

describe("AgentsSurface inspector state", () => {
  it("updates live content while preserving action values and chooses the nearest action when membership disappears", () => {
    let transcript = "initial output";
    const runtime = new FakeRuntime("runtime", [snapshot()], (current) =>
      inspectionFor(current, {
        records: [{ kind: "message", role: "assistant", text: transcript }],
      }),
    );
    const { surface } = fixture([runtime]);
    surface.handleInput(enter);
    surface.handleInput(down);
    transcript = "streamed output";
    runtime.items = [
      snapshot({
        health: { turns: 2 },
        timestamps: {
          queuedAt: "2024-01-01T00:00:00.000Z",
          startedAt: "2024-01-01T00:00:01.000Z",
          updatedAt: "2024-01-01T00:00:02.000Z",
        },
      }),
    ];
    runtime.emit();

    expect(selectedLine(surface)).toContain("Summarise activity");
    expect(rendered(surface)).toContain("streamed output");

    surface.handleInput(down);
    surface.handleInput(down);
    runtime.items = [
      snapshot({
        status: "completed",
        canSteer: false,
        timestamps: {
          queuedAt: "2024-01-01T00:00:00.000Z",
          startedAt: "2024-01-01T00:00:01.000Z",
          completedAt: "2024-01-01T00:00:03.000Z",
          updatedAt: "2024-01-01T00:00:03.000Z",
        },
      }),
    ];
    runtime.emit();

    expect(selectedLine(surface)).toContain("Back");
  });

  it("guards guidance and stop dialogs by inspector generation even after re-entering the same agent", async () => {
    const guidance = deferred<string | undefined>();
    const confirmation = deferred<boolean>();
    const runtime = new FakeRuntime("runtime", [snapshot()]);
    const { surface } = fixture([runtime], {
      input: () => guidance.promise,
      confirm: () => confirmation.promise,
    });

    surface.handleInput(enter);
    surface.handleInput(down);
    surface.handleInput(down);
    surface.handleInput(enter);
    await flush();
    surface.handleInput(escape);
    surface.handleInput(enter);
    guidance.resolve("new direction");
    await flush();
    expect(runtime.steer).not.toHaveBeenCalled();

    surface.handleInput(down);
    surface.handleInput(down);
    surface.handleInput(down);
    surface.handleInput(enter);
    await flush();
    surface.handleInput(escape);
    surface.handleInput(enter);
    confirmation.resolve(true);
    await flush();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("renders summary success and bounded authentication failure", async () => {
    const successRuntime = new FakeRuntime("runtime", [snapshot()]);
    successRuntime.summarise.mockResolvedValue({
      ok: true,
      text: "focused summary",
    });
    const success = fixture([successRuntime]);
    success.surface.handleInput(enter);
    success.surface.handleInput(down);
    success.surface.handleInput(enter);
    await flush();
    expect(plain(rendered(success.surface))).toContain(
      "Summary: focused summary",
    );

    const failedRuntime = new FakeRuntime("runtime", [snapshot()]);
    const failed = fixture([failedRuntime], {
      auth: async () => ({ ok: false, error: "credentials unavailable" }),
    });
    failed.surface.handleInput(enter);
    failed.surface.handleInput(down);
    failed.surface.handleInput(enter);
    await flush();
    expect(plain(rendered(failed.surface))).toContain(
      "Summary: credentials unavailable",
    );
    expect(failedRuntime.summarise).not.toHaveBeenCalled();
  });

  it("warns rather than redirecting guidance when eligibility changes during its dialog", async () => {
    const guidance = deferred<string | undefined>();
    const runtime = new FakeRuntime("runtime", [snapshot()]);
    const { surface, notify } = fixture([runtime], {
      input: () => guidance.promise,
    });
    surface.handleInput(enter);
    surface.handleInput(down);
    surface.handleInput(down);
    surface.handleInput(enter);
    await flush();
    runtime.items = [
      snapshot({
        status: "completed",
        canSteer: false,
        timestamps: {
          queuedAt: "2024-01-01T00:00:00.000Z",
          completedAt: "2024-01-01T00:00:03.000Z",
          updatedAt: "2024-01-01T00:00:03.000Z",
        },
      }),
    ];
    runtime.emit();
    guidance.resolve("late guidance");
    await flush();

    expect(runtime.steer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Guidance was not delivered; agent state changed.",
      "warning",
    );
    expect(plain(rendered(surface))).toContain("Agent inspector");
  });

  it("does not apply summary completion or request renders after navigation", async () => {
    const summary = deferred<{ ok: true; text: string }>();
    const runtime = new FakeRuntime("runtime", [snapshot()]);
    runtime.summarise.mockImplementation(async () => summary.promise);
    const { surface, requestRender } = fixture([runtime]);

    surface.handleInput(enter);
    surface.handleInput(down);
    surface.handleInput(enter);
    await flush();
    expect(rendered(surface)).toContain("Summary: loading…");
    surface.handleInput(escape);
    const rendersAfterBack = requestRender.mock.calls.length;
    summary.resolve({ ok: true, text: "stale summary" });
    await flush();

    expect(rendered(surface)).not.toContain("stale summary");
    expect(requestRender).toHaveBeenCalledTimes(rendersAfterBack);
  });
});

describe("AgentsSurface retained transcript", () => {
  it("renders chronological native and neutral records, keeps final distinct, and expands the same visible tool key", () => {
    const current = snapshot({ status: "completed", canSteer: false });
    const records: RuntimeInspection["records"] = [
      {
        kind: "message",
        role: "user",
        text: "begin transcript",
        timestamp: "2024-01-01T00:00:01.000Z",
      },
      {
        kind: "message",
        role: "assistant",
        text: "**assistant step**",
        timestamp: "2024-01-01T00:00:02.000Z",
      },
      {
        kind: "tool",
        toolCallId: "read-1",
        toolName: "read",
        status: "completed",
        arguments: { path: "src/a.ts", offset: 2, limit: 3 },
        result: "EXPANDED READ OUTPUT",
        timestamp: "2024-01-01T00:00:03.000Z",
      },
      {
        kind: "tool",
        toolCallId: "grep-1",
        toolName: "grep",
        status: "completed",
        arguments: { pattern: "needle", path: "src" },
        result: "src/a.ts:1: needle",
        timestamp: "2024-01-01T00:00:04.000Z",
      },
      {
        kind: "tool",
        toolCallId: "find-1",
        toolName: "find",
        status: "completed",
        arguments: { pattern: "*.ts", path: "src" },
        result: "src/a.ts",
        timestamp: "2024-01-01T00:00:05.000Z",
      },
      {
        kind: "tool",
        toolCallId: "bash-1",
        toolName: "bash",
        status: "completed",
        arguments: { command: "npm test", timeout: 30 },
        result: "tests passed",
        timestamp: "2024-01-01T00:00:06.000Z",
      },
      {
        kind: "tool",
        toolCallId: "edit-1",
        toolName: "edit",
        status: "completed",
        arguments: { path: "src/a.ts" },
        timestamp: "2024-01-01T00:00:07.000Z",
      },
      {
        kind: "tool",
        toolCallId: "custom-1",
        toolName: "custom",
        status: "failed",
        error: "custom failure",
        timestamp: "2024-01-01T00:00:08.000Z",
      },
      {
        kind: "steering",
        status: "delivered",
        text: "focus tests",
        timestamp: "2024-01-01T00:00:09.000Z",
      },
      {
        kind: "message",
        role: "final",
        text: "done distinctly",
        timestamp: "2024-01-01T00:00:10.000Z",
      },
    ];
    const runtime = new FakeRuntime("runtime", [current], (value) =>
      inspectionFor(value, {
        records,
        activity: records.filter(
          (record): record is RuntimeInspection["activity"][number] =>
            record.kind !== "message",
        ),
        omittedMessages: 1,
        compactedHistory: true,
      }),
    );
    const { surface, requestRender } = fixture([runtime]);
    surface.handleInput(enter);

    const collapsed = plain(rendered(surface, 140));
    expect(collapsed).toContain("begin transcript");
    expect(collapsed).toContain("assistant step");
    expect(collapsed).toContain("read");
    expect(collapsed).toContain("src/a.ts");
    expect(collapsed).toContain("grep");
    expect(collapsed).toContain("needle");
    expect(collapsed).toContain("find");
    expect(collapsed).toContain("*.ts");
    expect(collapsed).toContain("npm test");
    expect(collapsed).not.toContain("EXPANDED READ OUTPUT");
    expect(collapsed.indexOf("begin transcript")).toBeLessThan(
      collapsed.indexOf("assistant step"),
    );
    expect(collapsed.indexOf("assistant step")).toBeLessThan(
      collapsed.indexOf("read"),
    );
    const beforeRepeatedRender = requestRender.mock.calls.length;
    surface.render(140);
    surface.render(100);
    expect(requestRender).toHaveBeenCalledTimes(beforeRepeatedRender);

    surface.handleInput(tab);
    surface.handleInput("e");
    expect(plain(rendered(surface, 140))).toContain("EXPANDED READ OUTPUT");
    runtime.emit();
    expect(plain(rendered(surface, 140))).toContain("EXPANDED READ OUTPUT");
    surface.handleInput("e");
    expect(plain(rendered(surface, 140))).not.toContain("EXPANDED READ OUTPUT");

    for (let index = 0; index < 12; index += 1) {
      surface.handleInput(down);
    }
    const lower = plain(rendered(surface, 140));
    expect(lower).toContain("Tool edit: completed · body omitted");
    expect(lower).toContain("Tool custom: failed · native replay unavailable");
    expect(lower).toContain("Guidance delivered: focus tests");
    expect(lower).toContain("Final: done distinctly");
    expect(lower).toContain("Retention: 1 records omitted · compacted history");
    expect(lower.indexOf("Guidance delivered")).toBeLessThan(
      lower.indexOf("Final: done distinctly"),
    );
  });

  it("keeps all lines width-safe and re-evaluates themed content after invalidation", () => {
    const runtime = new FakeRuntime("runtime", [snapshot()]);
    const { surface, requestRender, setThemeMark } = fixture([runtime]);

    expect(plain(rendered(surface))).toContain("Active · ● Worker · first age");
    for (const width of [1, 8, 24, 60]) {
      expect(
        surface.render(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
    const rendersBeforeInvalidation = requestRender.mock.calls.length;
    setThemeMark("\x1b[32m");
    surface.invalidate();
    expect(rendered(surface)).toContain("\x1b[32m");
    expect(requestRender).toHaveBeenCalledTimes(rendersBeforeInvalidation);
  });

  it("disposes subscriptions, pending summaries, and completion exactly once", async () => {
    const summary = deferred<{ ok: true; text: string }>();
    let summarySignal: AbortSignal | undefined;
    const runtime = new FakeRuntime("runtime", [snapshot()]);
    runtime.summarise.mockImplementation(
      async (_id, _model, _auth, _deps, signal) => {
        summarySignal = signal;
        return summary.promise;
      },
    );
    const { surface, done, requestRender } = fixture([runtime]);
    surface.handleInput(enter);
    surface.handleInput(down);
    surface.handleInput(enter);
    await flush();

    surface.dispose();
    surface.dispose();
    expect(summarySignal?.aborted).toBe(true);
    expect(runtime.unsubscribe).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    const renderCount = requestRender.mock.calls.length;
    runtime.emit();
    summary.resolve({ ok: true, text: "late" });
    await flush();
    expect(requestRender).toHaveBeenCalledTimes(renderCount);
  });
});
