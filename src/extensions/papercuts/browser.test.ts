import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPapercutSummary, registerPapercutsBrowser } from "./browser.js";
import { createPapercutStatusController } from "./status.js";

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-papercuts-browser-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

const observation = {
  key: "finding",
  title: "A finding",
  task: "An unrelated task",
  incident: "A detour",
  evidence: "Observed output",
  workarounds: ["Inspected scripts.", "Took the detour."],
  taskOutcome: "Continued safely.",
};

const nearLimitObservation = {
  ...observation,
  title: "t".repeat(120),
  task: "t".repeat(1_000),
  incident: "i".repeat(2_000),
  evidence: "e".repeat(2_000),
  workarounds: Array.from({ length: 5 }, () => "w".repeat(1_000)),
  taskOutcome: "o".repeat(1_000),
  guardrailCandidate: "g".repeat(1_000),
  suggestedDestination: "tooling" as const,
};

const record = {
  ...observation,
  status: "open" as const,
  occurrences: 2,
  firstSeenAt: "2025-01-01T00:00:00.000Z",
  lastSeenAt: "2025-01-01T00:00:00.000Z",
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const keybindings = {
  matches: (data: string, binding: string) =>
    data === "\r" && binding === "tui.select.confirm",
};

function browserHarness(selections: string[]) {
  initTheme("dark");
  let command:
    | { handler: (args: string, ctx: unknown) => Promise<void> }
    | undefined;
  const components: Array<{ render(width: number): string[] }> = [];
  const custom = vi.fn((factory) => {
    const done = vi.fn();
    const component = factory(
      { requestRender: vi.fn() },
      theme,
      keybindings,
      done,
    );
    components.push(component);
    component.handleInput("\r");
    return Promise.resolve(done.mock.calls[0]?.[0]);
  });
  const ui = {
    select: vi.fn(async () => selections.shift()),
    custom,
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
  const pi = {
    registerCommand: (_name: string, next: typeof command) => {
      command = next;
    },
  };
  return {
    pi,
    ui,
    renders: () => components.map((component) => component.render(48)),
    actionLabels: () =>
      components.map((component) => {
        const rendered = component.render(48);
        return ["Close Finding", "Back"].filter((label) =>
          rendered.some((line) => line.includes(label)),
        );
      }),
    command: () => command!,
  };
}

afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe("papercuts browser", () => {
  it("formats deterministic status then key summaries", () => {
    expect(
      formatPapercutSummary({
        version: 2,
        records: [
          { ...record, key: "z", status: "closed" },
          { ...record, key: "a" },
        ],
      }),
    ).toBe(
      "open (1)\nclosed (1)\n- open a: A finding (2)\n- closed z: A finding (2)",
    );
  });

  it("reports omitted records within the summary budget", () => {
    const summary = formatPapercutSummary({
      version: 2,
      records: Array.from({ length: 256 }, (_, index) => ({
        ...record,
        key: `finding-${index}`,
        title: "x".repeat(120),
      })),
    });
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(16_384);
    expect(summary).toMatch(/record.* omitted/);
  });

  it("shows complete near-limit open detail through a width-safe action panel and closes it", async () => {
    const root = repo();
    const status = createPapercutStatusController();
    const ctx = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      ui: undefined as never,
    };
    await (await status.storeFor(ctx as never)).record(nearLimitObservation);
    const harness = browserHarness([
      "Open (1)",
      `finding — ${nearLimitObservation.title}`,
      "Back",
      "Back",
    ]);
    ctx.ui = harness.ui as never;
    registerPapercutsBrowser(harness.pi as never, status);
    await status.sessionStart(ctx as never);
    await harness.command().handler("", ctx as never);

    const rendered = harness.renders()[0];
    const detail = rendered.join("\n");
    expect(detail).toContain("Title:");
    expect(detail).toContain("Key: finding");
    expect(detail).toContain("Assigned task:");
    expect(detail).toContain("Incident:");
    expect(detail).toContain("Evidence:");
    expect(detail).toContain("1.");
    expect(detail).toContain("5.");
    expect(detail).toContain("Task outcome:");
    expect(detail).toContain("Guardrail candidate:");
    expect(detail).toContain("Suggested destination: tooling");
    expect(detail).toContain("Occurrences: 1");
    expect(detail).toContain("First seen:");
    expect(detail).toContain("Last seen:");
    expect(harness.actionLabels()).toEqual([["Close Finding", "Back"]]);
    expect(
      rendered.findIndex((line) => line.includes("Close Finding")),
    ).toBeGreaterThan(
      rendered.findIndex((line) => line.includes("Last seen:")),
    );
    expect(detail).not.toMatch(
      /copy|clipboard|editor|work on|edit|delete|ignore|reopen/i,
    );
    expect(rendered.every((line) => visibleWidth(line) <= 48)).toBe(true);
    expect(
      (await (await status.storeFor(ctx as never)).load()).records[0],
    ).toMatchObject({
      status: "closed",
      occurrences: 1,
    });
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0300:papercuts",
      undefined,
    );
  });

  it("shows closed detail with Back as its only action", async () => {
    const root = repo();
    const status = createPapercutStatusController();
    const ctx = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      ui: undefined as never,
    };
    const store = await status.storeFor(ctx as never);
    await store.record(observation);
    await store.close("finding");
    const harness = browserHarness([
      "Closed (1)",
      "finding — A finding",
      "Back",
      "Back",
    ]);
    ctx.ui = harness.ui as never;
    registerPapercutsBrowser(harness.pi as never, status);
    await harness.command().handler("", ctx as never);

    const detail = harness.renders()[0].join("\n");
    expect(detail).toContain("Exercised workarounds:");
    expect(harness.actionLabels()).toEqual([["Back"]]);
    expect(detail).not.toContain("Close Finding");
    expect((await store.load()).records[0]).toMatchObject({
      status: "closed",
      occurrences: 1,
    });
  });
});
