import { beforeEach, describe, expect, it, vi } from "vitest";

const executeSandboxBash = vi.hoisted(() => vi.fn());
vi.mock("#sandbox/bash", () => ({ executeSandboxBash }));

import { normalizeLabel, registerBashOutcomeTool } from "./bash-outcome.ts";

function outcome(activeTools = ["bash", "bash_outcome"]) {
  let definition: any;
  const events = {};
  registerBashOutcomeTool({
    events,
    getActiveTools: () => activeTools,
    registerTool: (tool: unknown) => (definition = tool),
  } as any);
  return { definition, events };
}

describe("bash_outcome", () => {
  beforeEach(() => executeSandboxBash.mockReset());

  it("presents outcome as an exit-status tool without discouraging output-driven Bash", () => {
    const { definition } = outcome();

    expect(definition.description).toContain(
      "when exit status alone answers the current question",
    );
    expect(definition.description).toContain("immediately recallable");
    expect(definition.description).toContain(
      "successful command with no output returns only concise status",
    );
    expect(definition.promptSnippet).toBeUndefined();
    expect(definition.promptGuidelines).toBeUndefined();
  });

  it("retains the ordinary Bash result and returns only concise success", async () => {
    const ordinary = {
      content: [{ type: "text", text: "(no output)" }],
      details: { truncation: { truncated: false } },
    };
    executeSandboxBash.mockResolvedValueOnce(ordinary);
    const { definition, events } = outcome();
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const ctx = { cwd: "/workspace" };

    const result = await definition.execute(
      "call-123",
      { command: "true", timeout: 7 },
      signal,
      onUpdate,
      ctx,
    );

    expect(executeSandboxBash).toHaveBeenCalledWith(events, {
      toolCallId: "call-123",
      params: { command: "true", timeout: 7 },
      signal,
      onUpdate,
      ctx,
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Bash command succeeded (no output).",
        },
      ],
      details: {
        retainedResult: {
          type: "pipkin.context.retained-result",
          version: 1,
          result: ordinary,
        },
      },
    });
  });

  it("keeps recall guidance for successful commands with output", async () => {
    const ordinary = {
      content: [{ type: "text", text: "tests passed" }],
      details: { truncation: { truncated: false } },
    };
    executeSandboxBash.mockResolvedValueOnce(ordinary);
    const { definition } = outcome();

    const result = await definition.execute("call-456", {
      command: "npm test",
      label: "Tests",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Tests succeeded.\nThe Bash result is retained; call context_recall("call-456") to inspect this result rather than repeat the operation.',
        },
      ],
      details: {
        retainedResult: {
          type: "pipkin.context.retained-result",
          version: 1,
          result: ordinary,
        },
      },
    });
  });

  it("normalizes labels before delegation and rejects invalid labels without execution", async () => {
    expect(normalizeLabel("\u001b[31m  Build\t suite  \u001b[0m")).toBe(
      "Build suite",
    );
    expect(normalizeLabel("🙂".repeat(80))).toHaveLength(160);
    expect(() => normalizeLabel("\u001b[31m\t\u001b[0m")).toThrow("1–80");
    expect(() => normalizeLabel("x".repeat(81))).toThrow("1–80");

    const { definition } = outcome();
    await expect(
      definition.execute("call", { command: "true", label: "\u001b[31m" }),
    ).rejects.toThrow("1–80");
    expect(executeSandboxBash).not.toHaveBeenCalled();
  });

  it("renders bounded command calls and retained output only when expanded", async () => {
    const { definition } = outcome();
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const call = definition.renderCall(
      {
        command: ["printf first", "\u001b[31msecond\u001b[0m"].join("\n"),
        label: "ignored",
      },
      theme,
      {},
    );
    expect(call.render(20).every((line: string) => line.length <= 20)).toBe(
      true,
    );
    expect(
      call.render(120).join("\n").replaceAll("\\n", " ").replace(/\s+/g, " "),
    ).toContain("printf first second");
    expect(call.render(120).join("\n")).not.toContain("ignored");

    const result = {
      content: [
        {
          type: "text" as const,
          text: 'Build succeeded.\nThe Bash result is retained; call context_recall("call") to inspect this result rather than repeat the operation.',
        },
      ],
      details: {
        retainedResult: {
          type: "pipkin.context.retained-result" as const,
          version: 1 as const,
          result: {
            content: [{ type: "text" as const, text: "ordinary output" }],
          },
        },
      },
    };
    const collapsed = definition
      .renderResult(result, { expanded: false, isPartial: false }, theme, {
        isError: false,
      })
      .render(120)
      .join("\n");
    const expanded = definition
      .renderResult(result, { expanded: true, isPartial: false }, theme, {
        isError: false,
      })
      .render(120)
      .join("\n");

    expect(collapsed.trimEnd()).toBe("Build succeeded.");
    expect(collapsed).not.toContain("ordinary output");
    expect(expanded.match(/ordinary output/g)).toHaveLength(1);

    const noOutput = {
      content: [
        { type: "text" as const, text: "Build succeeded (no output)." },
      ],
      details: {
        retainedResult: {
          type: "pipkin.context.retained-result" as const,
          version: 1 as const,
          result: {
            content: [{ type: "text" as const, text: "(no output)" }],
          },
        },
      },
    };
    expect(
      definition
        .renderResult(noOutput, { expanded: true, isPartial: false }, theme, {
          isError: false,
        })
        .render(120)
        .join("\n"),
    ).toContain("(no output)");
    expect(
      definition
        .renderResult(
          { ...result, details: { retainedResult: { version: 1 } } },
          { expanded: true, isPartial: false },
          theme,
          { isError: false },
        )
        .render(120)
        .join("\n"),
    ).not.toContain("retainedResult");
  });

  it("keeps live output collapsed and uses status colors only for errors", () => {
    const { definition } = outcome();
    const colors: string[] = [];
    const theme = {
      fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      },
    };
    const partial = {
      content: [{ type: "text" as const, text: "first\nsecond" }],
    };

    const collapsedPartial = definition
      .renderResult(partial, { expanded: false, isPartial: true }, theme, {
        isError: false,
      })
      .render(120)
      .join("\n");
    expect(collapsedPartial.trimEnd()).toBe("Running…");
    expect(collapsedPartial).not.toContain("first");
    expect(colors).toEqual(["muted"]);

    colors.length = 0;
    const expandedPartial = definition
      .renderResult(partial, { expanded: true, isPartial: true }, theme, {
        isError: false,
      })
      .render(120)
      .join("\n");
    expect(
      expandedPartial.split("\n").map((line: string) => line.trimEnd()),
    ).toEqual(["first", "second"]);
    expect(colors).toEqual(["toolOutput"]);

    colors.length = 0;
    const success = definition
      .renderResult(
        { content: [{ type: "text", text: "Build succeeded." }] },
        { expanded: false, isPartial: false },
        theme,
        { isError: false },
      )
      .render(120)
      .join("\n");
    expect(success.trimEnd()).toBe("Build succeeded.");
    expect(colors).toEqual(["toolOutput"]);

    colors.length = 0;
    const failure = definition
      .renderResult(
        { content: [{ type: "text", text: "Command failed" }] },
        { expanded: false, isPartial: false },
        theme,
        { isError: true },
      )
      .render(120)
      .join("\n");
    expect(failure.trimEnd()).toBe("Command failed");
    expect(colors).toEqual(["error"]);
  });

  it("rejects inactive Bash and propagates Sandbox failures unchanged", async () => {
    const inactive = outcome(["bash_outcome"]);
    await expect(
      inactive.definition.execute("call", { command: "true" }),
    ).rejects.toThrow("bash is inactive");
    expect(executeSandboxBash).not.toHaveBeenCalled();

    const failure = new Error("timeout:1");
    executeSandboxBash.mockRejectedValueOnce(failure);
    const active = outcome();
    await expect(
      active.definition.execute("call", { command: "sleep 1" }),
    ).rejects.toBe(failure);
  });
});
