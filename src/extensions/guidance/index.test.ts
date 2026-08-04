import { describe, expect, it, vi } from "vitest";
import guidance from "./index.ts";

function handler() {
  const on = vi.fn();
  guidance({ on } as never);
  return on.mock.calls[0]?.[1] as (event: {
    systemPrompt: string;
    systemPromptOptions: { selectedTools?: string[] };
  }) => { systemPrompt: string } | undefined;
}

describe("Guidance extension", () => {
  it("appends one selected-tool section without rebuilding or accumulating prompts", () => {
    const beforeAgentStart = handler();
    const event = {
      systemPrompt: "Pi instructions\n\nUser context\n\nEarlier handler",
      systemPromptOptions: {
        selectedTools: ["bash_outcome", "context_recall"],
      },
    };

    const result = beforeAgentStart(event)!;
    expect(result.systemPrompt.startsWith(event.systemPrompt)).toBe(true);
    expect(result.systemPrompt.match(/## Pipkin guidance/g)).toHaveLength(1);
    expect(result.systemPrompt).toContain("bash_outcome:");
    expect(result.systemPrompt).not.toContain("start_process:");

    const next = beforeAgentStart({
      ...event,
      systemPrompt: event.systemPrompt,
    })!;
    expect(next.systemPrompt.match(/## Pipkin guidance/g)).toHaveLength(1);
  });

  it("does nothing when no Pipkin guidance applies", () => {
    expect(
      handler()({
        systemPrompt: "Pi instructions",
        systemPromptOptions: { selectedTools: ["read"] },
      }),
    ).toBeUndefined();
  });
});
