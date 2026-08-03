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
  command: "echo done",
  cwd: "/work",
};

describe("process tools", () => {
  it("defaults to output and retains only non-failed outcome snapshots", async () => {
    const calls: unknown[][] = [];
    const tools = toolsFor({
      async result(...args: unknown[]) {
        calls.push(args);
        return {
          snapshot,
          waitOutcome: "terminal",
          output: "done",
          selector: { type: "tail", sourceLines: 1 },
        };
      },
      async stop() {
        return { snapshot, output: "done", selector: { type: "tail" } };
      },
    });
    const get = tools.get("get_process_result")!;
    const stop = tools.get("stop_process")!;

    const output = await get.execute("output-call", {
      id: "process-1",
      wait: false,
    });
    expect(output.details).toMatchObject({ resultMode: "output" });
    expect(calls[0]?.at(-1)).toEqual({ tailLines: undefined, find: undefined });

    const outcome = await get.execute("outcome-call", {
      id: "process-1",
      wait: true,
      resultMode: "outcome",
    });
    expect(outcome.content[0].text).toContain('context_recall("outcome-call")');
    expect(outcome.details.retainedResult.result.content[0].text).toContain(
      "Output:\ndone",
    );

    const stopped = await stop.execute("stop-call", {
      id: "process-1",
      resultMode: "outcome",
    });
    expect(stopped.details.retainedResult).toBeDefined();
    expect(get.parameters.additionalProperties).toBe(false);
    expect(stop.parameters.additionalProperties).toBe(false);
  });

  it("keeps failed outcome output visible through Pi's default result shell", async () => {
    const failedSnapshot = { ...snapshot, status: "failed" };
    const tools = toolsFor({
      async result() {
        return {
          snapshot: failedSnapshot,
          waitOutcome: "terminal",
          output: "failure output",
          selector: { type: "tail", sourceLines: 1 },
        };
      },
      async stop() {
        return {
          snapshot: failedSnapshot,
          output: "failure output",
          selector: { type: "tail" },
        };
      },
    });
    const get = tools.get("get_process_result")!;
    const failed = await get.execute("failed-call", {
      id: "process-1",
      wait: true,
      resultMode: "outcome",
    });
    expect(failed.details.retainedResult).toBeUndefined();
    expect(failed.content[0].text).toContain("failure output");

    expect(get.renderResult).toBeUndefined();
    expect(tools.get("stop_process")!.renderResult).toBeUndefined();
  });
});
