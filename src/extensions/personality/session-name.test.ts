import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateSessionName } from "./session-name.js";

const completeTextMock = vi.hoisted(() => vi.fn());

vi.mock("#lib/complete", async () => {
  const actual =
    await vi.importActual<typeof import("#lib/complete")>("#lib/complete");
  return { ...actual, completeText: completeTextMock };
});

const options = {
  utility: { model: "test/utility", thinking: "minimal" },
  utilityIssue: undefined,
  configPath: "/agent/pipkin/config.json",
} as const;

function context(): ExtensionContext {
  return {
    modelRegistry: {
      find: vi.fn(() => ({ provider: "test", id: "utility" })),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "test-key",
        headers: {},
      })),
    },
  } as unknown as ExtensionContext;
}

describe("session-name capability", () => {
  beforeEach(() => {
    completeTextMock.mockReset();
  });

  it("creates an Implement title from root-plan context", async () => {
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "Implement managed processes",
      stopReason: "stop",
    });

    const result = await generateSessionName(
      context(),
      options,
      {
        kind: "implement",
        planExcerpt: "# Managed processes\n\n- [ ] Start managed workers",
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      outcome: "success",
      title: "Implement managed processes",
    });
    const request = completeTextMock.mock.calls[0][1] as {
      systemPrompt: string;
      messages: { content: { text: string }[] }[];
    };
    expect(request.systemPrompt).toContain("active Pipkin Implement run");
    expect(request.messages[0]!.content[0]!.text).toContain(
      "# Managed processes",
    );
  });

  it("falls back when Implement generation cannot provide a prefixed title", async () => {
    completeTextMock.mockResolvedValue({
      ok: true,
      text: "Managed processes",
      stopReason: "stop",
    });

    const result = await generateSessionName(
      context(),
      options,
      { kind: "implement", planExcerpt: "# Managed processes" },
      new AbortController().signal,
    );

    expect(result).toEqual({ outcome: "success", title: "Implement run" });
  });

  it("falls back when the utility model is unavailable", async () => {
    const result = await generateSessionName(
      context(),
      { ...options, utility: undefined, utilityIssue: "is unavailable" },
      { kind: "implement", planExcerpt: "# Managed processes" },
      new AbortController().signal,
    );

    expect(result).toEqual({ outcome: "success", title: "Implement run" });
    expect(completeTextMock).not.toHaveBeenCalled();
  });
});
