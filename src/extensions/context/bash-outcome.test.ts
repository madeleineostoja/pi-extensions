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
          text: 'Bash command succeeded.\nThe Bash result is retained; call context_recall("call-123") to inspect it.',
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
