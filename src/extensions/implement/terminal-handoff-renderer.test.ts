import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { renderTerminalHandoffEntry } from "./terminal-handoff-renderer.js";

beforeAll(() => initTheme(undefined, false));

const theme = {
  bg: (_color: string, text: string) => text,
  fg: (_color: string, text: string) => text,
};

function render(data: unknown, expanded = false): string | undefined {
  return renderTerminalHandoffEntry(
    { data } as never,
    { expanded },
    theme as never,
  )
    ?.render(100)
    .join("\n");
}

describe("terminal handoff entry renderer", () => {
  it("renders a human-friendly title and the complete Markdown report", () => {
    const output = render({
      phase: "incomplete",
      runId: "run-1",
      text: "## Run outcome\n\nThe run is incomplete.",
    });

    expect(output).toContain("Implement handoff · Incomplete");
    expect(output).toContain("Run outcome");
    expect(output).toContain("The run is incomplete.");
    expect(output).not.toContain("pipkin.implement.terminal-handoff");
    expect(
      render(
        {
          phase: "incomplete",
          runId: "run-1",
          text: "## Run outcome\n\nThe run is incomplete.",
        },
        true,
      ),
    ).toBe(output);
  });

  it("declines malformed durable entries", () => {
    expect(
      render({ phase: "completed", text: "Missing run ID" }),
    ).toBeUndefined();
  });
});
