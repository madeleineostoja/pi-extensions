import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  decodeRetainedResult,
  hasRetainedResult,
  retainResult,
} from "./retained-result.ts";

const managerKey = Symbol.for("pipkin:context:retained-result");

describe("retained result", () => {
  it("encodes and decodes the exact ordinary result with the standard recall instruction", () => {
    const ordinary = {
      content: [
        { type: "text" as const, text: "bounded output" },
        { type: "image" as const, data: "abc", mimeType: "image/png" },
      ],
      details: { truncation: { truncated: true }, nested: [1, "two"] },
    };

    const retained = retainResult(ordinary, "Build succeeded.", "call-123");

    expect(retained.content).toEqual([
      {
        type: "text",
        text: 'Build succeeded.\nThe Bash result is retained; call context_recall("call-123") to inspect this result rather than repeat the operation.',
      },
    ]);
    expect(decodeRetainedResult(retained.details)).toEqual(ordinary);
    expect(hasRetainedResult(retained.details)).toBe(true);
  });

  it("uses a source-owned label without changing Bash defaults", () => {
    const retained = retainResult(
      { content: [{ type: "text", text: "process output" }] },
      "Managed process process-1 is completed.",
      "process-call",
      { label: "managed process" },
    );

    expect(retained.content[0]?.text).toBe(
      'Managed process process-1 is completed.\nThe managed process result is retained; call context_recall("process-call") to inspect this result rather than repeat the operation.',
    );
  });

  it("rejects oversized text, image, and combined retained payloads", () => {
    const oversizedText = "x".repeat(DEFAULT_MAX_BYTES + 1);
    const oversizedImage = "x".repeat(DEFAULT_MAX_BYTES + 1);
    expect(() =>
      retainResult(
        { content: [{ type: "text", text: oversizedText }] },
        "Bash command succeeded.",
        "call",
      ),
    ).toThrow("Invalid retained result");
    const nearLimit = retainResult(
      {
        content: [{ type: "text", text: "x".repeat(DEFAULT_MAX_BYTES) }],
        details: { exitCode: 0, metadata: "bounded" },
      },
      "Bash command succeeded.",
      "call",
    );
    expect(decodeRetainedResult(nearLimit.details)).toEqual({
      content: [{ type: "text", text: "x".repeat(DEFAULT_MAX_BYTES) }],
      details: { exitCode: 0, metadata: "bounded" },
    });
    expect(
      decodeRetainedResult({
        retainedResult: {
          type: "pipkin.context.retained-result",
          version: 1,
          result: {
            content: [
              { type: "image", data: oversizedImage, mimeType: "image/png" },
            ],
          },
        },
      }),
    ).toBeUndefined();
    expect(
      decodeRetainedResult({
        retainedResult: {
          type: "pipkin.context.retained-result",
          version: 1,
          result: {
            content: [
              { type: "text", text: "x".repeat(DEFAULT_MAX_BYTES / 2) },
              { type: "text", text: "x".repeat(DEFAULT_MAX_BYTES / 2 + 1) },
            ],
          },
        },
      }),
    ).toBeUndefined();
  });

  it("rejects malformed versions and non-JSON or oversized source details without state", () => {
    const before = (globalThis as Record<symbol, unknown>)[managerKey];
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(
      decodeRetainedResult({
        retainedResult: {
          type: "pipkin.context.retained-result",
          version: 2,
          result: { content: [{ type: "text", text: "ignored" }] },
        },
      }),
    ).toBeUndefined();
    expect(
      decodeRetainedResult({ retainedResult: { version: 1 } }),
    ).toBeUndefined();
    expect(() =>
      retainResult(
        { content: [{ type: "text", text: "output" }], details: cyclic },
        "Bash command succeeded.",
        "call",
      ),
    ).toThrow("Invalid retained result");
    expect(() =>
      retainResult(
        {
          content: [{ type: "text", text: "output" }],
          details: { output: "x".repeat(DEFAULT_MAX_BYTES) },
        },
        "Bash command succeeded.",
        "call",
      ),
    ).toThrow("Invalid retained result");
    expect((globalThis as Record<symbol, unknown>)[managerKey]).toBe(before);
  });
});
