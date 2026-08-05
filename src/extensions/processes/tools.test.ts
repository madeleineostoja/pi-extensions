import { describe, expect, it } from "vitest";
import { registerProcessTools } from "./tools.js";

type Tool = {
  name: string;
  parameters: { additionalProperties?: boolean };
  execute: (...args: any[]) => Promise<any>;
  renderResult?: (...args: any[]) => { render: (width: number) => string[] };
};

function toolsFor(runtime: Record<string, unknown>): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  registerProcessTools(
    {
      registerTool(tool: Tool) {
        tools.set(tool.name, tool);
      },
    } as never,
    () => runtime as never,
  );
  return tools;
}

const snapshot = {
  id: "process-1",
  status: "completed",
  description: "Run the focused tests",
  command: "echo done",
  cwd: "/work",
  pid: 42,
  exitCode: 0,
  signal: null,
  startedAt: "2026-03-09T10:00:00.000Z",
  endedAt: "2026-03-09T10:00:01.000Z",
  retainedBytes: 5,
  droppedBytes: 0,
  outputComplete: true,
} as const;

const theme = { fg: (_color: string, text: string) => text } as never;

describe("process tools", () => {
  it("returns readable status and selected output while retaining normalized details", async () => {
    const calls: unknown[][] = [];
    const tools = toolsFor({
      async start() {
        return snapshot;
      },
      async result(...args: unknown[]) {
        calls.push(args);
        return {
          snapshot,
          waitOutcome: "terminal",
          output: "done",
          selector: { type: "tail", requestedLines: 80, sourceLines: 1 },
        };
      },
      async stop() {
        return {
          snapshot,
          output: "done",
          selector: { type: "tail", requestedLines: 80, sourceLines: 1 },
        };
      },
    });
    const start = tools.get("start_process")!;
    const get = tools.get("get_process_result")!;

    const started = await start.execute(
      "start-call",
      {
        command: "echo done",
        description: "Run the focused tests",
      },
      undefined,
      undefined,
      { cwd: "/work" },
    );
    expect(started.content[0].text).toBe(
      "Started managed process process-1 (pid 42).",
    );
    expect(started.details).toMatchObject({
      snapshot: { id: "process-1", command: "echo done" },
      resultMode: "output",
    });

    const output = await get.execute("output-call", {
      id: "process-1",
      wait: false,
    });
    expect(output.content[0].text).toContain(
      "Managed process process-1 completed.",
    );
    expect(output.content[0].text).toContain(
      "The process reached terminal settlement.",
    );
    expect(output.content[0].text).toContain(
      "Showing the newest 80 output lines",
    );
    expect(output.content[0].text).toContain("Output:\n\ndone");
    expect(output.content[0].text).not.toContain('"command": "echo done"');
    expect(output.details).toMatchObject({
      snapshot: { id: "process-1", status: "completed" },
      selector: { type: "tail", sourceLines: 1 },
      resultMode: "output",
    });
    expect(calls[0]?.at(-1)).toEqual({ tailLines: undefined, find: undefined });

    expect(get.parameters.additionalProperties).toBe(false);
    expect(tools.get("stop_process")!.parameters.additionalProperties).toBe(
      false,
    );
  });

  it("retains non-failed outcomes, keeps failed output visible, and renders semantic summaries", async () => {
    const tools = toolsFor({
      async result() {
        return {
          snapshot,
          waitOutcome: "terminal",
          output: "done",
          selector: { type: "find", sourceLines: 1, totalMatches: 1 },
        };
      },
      async stop() {
        return {
          snapshot: { ...snapshot, status: "failed" },
          output: "failure output",
          selector: { type: "tail", requestedLines: 80, sourceLines: 1 },
        };
      },
    });
    const get = tools.get("get_process_result")!;
    const stop = tools.get("stop_process")!;

    const outcome = await get.execute("outcome-call", {
      id: "process-1",
      wait: true,
      resultMode: "outcome",
    });
    expect(outcome.content[0].text).toContain('context_recall("outcome-call")');
    expect(outcome.details.retainedResult.result.content[0].text).toContain(
      "Output:\n\ndone",
    );

    const failed = await stop.execute("failed-call", {
      id: "process-1",
      resultMode: "outcome",
    });
    expect(failed.details.retainedResult).toBeUndefined();
    expect(failed.content[0].text).toContain("failure output");

    const render = get.renderResult!;
    const summary = (details: unknown) =>
      render(
        {
          content: [{ type: "text", text: "complete result" }],
          details,
        },
        { expanded: false, isPartial: false },
        theme,
        {},
      )
        .render(120)
        .map((line: string) => line.trimEnd())
        .join("\n");
    expect(
      summary({
        snapshot: { ...snapshot, status: "running" },
        waitOutcome: "ready",
        selector: { type: "tail", requestedLines: 20, sourceLines: 100 },
      }),
    ).toContain("The requested readiness literal was observed.");
    expect(
      summary({
        snapshot: { ...snapshot, status: "running" },
        waitOutcome: "timed_out",
      }),
    ).toContain("The wait timed out; the process is still running.");
    expect(
      summary({
        snapshot,
        selector: { type: "find", sourceLines: 100, totalMatches: 0 },
      }),
    ).toContain("No retained output matched");
    expect(
      summary({
        snapshot,
        selector: {
          type: "find",
          sourceLines: 100,
          totalMatches: 3,
          selectedMatchAnchors: 2,
          find: "needle",
        },
      }),
    ).toContain("Showing 2 selected matches from 3 retained output matches");
    expect(
      summary({
        retainedResult: {
          type: "pipkin.context.retained-result",
          version: 1,
          result: {
            content: [{ type: "text", text: "complete result" }],
            details: { snapshot, waitOutcome: "terminal" },
          },
        },
      }),
    ).toContain("The process reached terminal settlement.");
    expect(tools.get("start_process")!.renderResult).toBeTypeOf("function");
    expect(tools.get("stop_process")!.renderResult).toBeTypeOf("function");
  });
});
