import { describe, expect, it } from "vitest";
import { renderEpochEntry } from "./epoch-renderer.ts";
import { type EpochData } from "./policy.ts";

const theme = {
  fg: (_color: string, text: string) => text,
};

function render(data: unknown, expanded = false): string | undefined {
  return renderEpochEntry({ data } as never, { expanded }, theme as never)
    ?.render(80)
    .map((line) => line.trimEnd())
    .join("\n");
}

function decision(
  reason: EpochData["decisions"][number]["reason"],
  estimatedTokensSaved?: number,
) {
  return {
    sourceToolCallId: `${reason}-${estimatedTokensSaved ?? "legacy"}`,
    reason,
    stub: `[tool result elided. Call context_recall("${reason}-${estimatedTokensSaved ?? "legacy"}") to retrieve.]`,
    ...(estimatedTokensSaved === undefined ? {} : { estimatedTokensSaved }),
  };
}

describe("Context epoch rendering", () => {
  it("renders a quiet collapsed savings milestone", () => {
    expect(
      render({
        kind: "warm",
        decisions: [
          decision("superseded-read", 9_000),
          decision("standard-stale", 9_200),
        ],
      }),
    ).toBe("context · pruned 2 results (~18k tokens)");
  });

  it("renders legacy epochs without fabricating a token total", () => {
    expect(
      render({
        kind: "tail",
        decisions: [decision("standard-stale")],
      }),
    ).toBe("context · pruned 1 result");
  });

  it("expands to a reason/count/savings breakdown", () => {
    expect(
      render(
        {
          kind: "known-cold",
          decisions: [
            decision("superseded-read", 9_000),
            decision("superseded-read", 8_000),
            decision("after-consumption-bash", 1_000),
          ],
        },
        true,
      ),
    ).toBe(
      [
        "context · pruned 3 results (~18k tokens)",
        "  superseded reads · 2 results · ~17k",
        "  consumed bash · 1 result · ~1k",
      ].join("\n"),
    );
  });

  it("hides internal epoch kinds and invalid data", () => {
    for (const kind of ["known-cold", "warm", "tail"] as const) {
      expect(
        render({
          kind,
          decisions: [decision("standard-stale", 1_000)],
        }),
      ).toBe("context · pruned 1 result (~1k tokens)");
    }
    expect(render({ kind: "tail", decisions: [] })).toBeUndefined();
  });
});
