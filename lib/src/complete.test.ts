import { describe, expect, it, vi } from "vitest";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  StopReason,
} from "@earendil-works/pi-ai";
import { completeText } from "./complete.js";

const model = { provider: "openrouter", id: "test-model" } as Model<Api>;
const context: Context = { messages: [] };

function message(
  stopReason: StopReason,
  content: AssistantMessage["content"] = [],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openrouter",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

describe("completeText", () => {
  it("joins multiple text blocks", async () => {
    const completeSimple = vi.fn().mockResolvedValue(
      message("stop", [
        { type: "text", text: "first" },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "second" },
      ]),
    );

    await expect(
      completeText(model, context, undefined, { completeSimple }),
    ).resolves.toEqual({ ok: true, text: "first\nsecond", stopReason: "stop" });
  });

  it("returns provider errors", async () => {
    const completeSimple = vi
      .fn()
      .mockResolvedValue(message("error", [], "provider failed"));

    await expect(
      completeText(model, context, undefined, { completeSimple }),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      message: "provider failed",
      text: "",
    });
  });

  it("returns aborted responses", async () => {
    const completeSimple = vi.fn().mockResolvedValue(message("aborted"));

    await expect(
      completeText(model, context, undefined, { completeSimple }),
    ).resolves.toEqual({ ok: false, reason: "aborted", text: "" });
  });

  it("maps thrown AbortError to aborted", async () => {
    const completeSimple = vi
      .fn()
      .mockRejectedValue(new DOMException("", "AbortError"));

    await expect(
      completeText(model, context, undefined, { completeSimple }),
    ).resolves.toEqual({ ok: false, reason: "aborted" });
  });

  it("distinguishes empty responses from length without text", async () => {
    const completeSimple = vi
      .fn()
      .mockResolvedValueOnce(message("stop"))
      .mockResolvedValueOnce(message("length"));

    await expect(
      completeText(model, context, undefined, { completeSimple }),
    ).resolves.toEqual({ ok: false, reason: "empty", text: "" });
    await expect(
      completeText(model, context, undefined, { completeSimple }),
    ).resolves.toEqual({ ok: false, reason: "length", text: "" });
  });

  it("treats length with usable text as success", async () => {
    const completeSimple = vi
      .fn()
      .mockResolvedValue(
        message("length", [{ type: "text", text: "partial" }]),
      );

    await expect(
      completeText(model, context, undefined, { completeSimple }),
    ).resolves.toEqual({ ok: true, text: "partial", stopReason: "length" });
  });
});
