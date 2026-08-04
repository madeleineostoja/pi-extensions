import { describe, expect, it } from "vitest";
import {
  chronologicalInspectionRecords,
  projectFinalInspectionRecord,
  projectMessages,
  renderPublicProgress,
  truncateUtf8,
} from "./inspection.js";

describe("truncateUtf8", () => {
  it("bounds large multibyte text without splitting a character", () => {
    const truncated = truncateUtf8("é".repeat(25_000), 2048);

    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(2048);
    expect(truncated).toMatch(/…$/);
    expect(truncated).not.toContain("�");
  });

  it("returns text that already fits unchanged", () => {
    expect(truncateUtf8("unchanged", 2048)).toBe("unchanged");
  });
});

describe("public progress projection", () => {
  const inspection = (
    records: unknown[],
    overrides: Record<string, unknown> = {},
  ) =>
    ({
      snapshot: {},
      messages: [],
      activity: [],
      records,
      omittedMessages: 0,
      omittedActivity: 0,
      compactedHistory: false,
      ...overrides,
    }) as never;

  it("projects only recent assistant text and safe activity statuses", () => {
    const progress = renderPublicProgress(
      inspection([
        { kind: "message", role: "user", text: "private task prompt" },
        {
          kind: "message",
          role: "assistant",
          text: "I inspected the code.\u001b",
        },
        {
          kind: "tool",
          toolCallId: "call-secret",
          toolName: "bash",
          status: "interrupted",
          arguments: { command: "secret command" },
          result: "raw secret output",
          error: "secret error",
        },
        { kind: "steering", status: "delivered", text: "private steer" },
        { kind: "compaction", status: "completed", reason: "threshold" },
        { kind: "retry", status: "scheduled" },
      ]),
    );

    expect(progress).toContain("BOUNDED POINT-IN-TIME PROGRESS");
    expect(progress).toContain("potentially incomplete");
    expect(progress).toContain("untrusted child-generated content");
    expect(progress).toContain("assistant: I inspected the code.");
    expect(progress).toContain("bash: interrupted");
    expect(progress).toContain("compaction: completed (threshold)");
    expect(progress).toContain("retry: scheduled");
    expect(progress).not.toContain("private task prompt");
    expect(progress).not.toContain("secret command");
    expect(progress).not.toContain("raw secret output");
    expect(progress).not.toContain("secret error");
    expect(progress).not.toContain("call-secret");
    expect(progress).not.toContain("private steer");
  });

  it("keeps the newest records and discloses bounded UTF-8 truncation", () => {
    const progress = renderPublicProgress(
      inspection(
        [
          ...Array.from({ length: 14 }, (_, index) => ({
            kind: "tool" as const,
            toolCallId: `call-${index}`,
            toolName: `tool-${index}`,
            status: "completed" as const,
          })),
          {
            kind: "message" as const,
            role: "assistant" as const,
            text: "é".repeat(2_000),
          },
        ],
        { omittedMessages: 1 },
      ),
    );

    expect(progress).toContain("Older eligible progress was omitted");
    expect(progress).toContain("Assistant text was truncated");
    expect(progress).toContain("tool-13: completed");
    expect(progress).not.toContain("tool-0: completed");
    expect(progress).not.toContain("�");
    expect(
      Buffer.byteLength(progress.match(/^assistant: .*$/m)?.[0] ?? ""),
    ).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(progress)).toBeLessThanOrEqual(8 * 1024);
  });

  it("reports when no eligible progress is available", () => {
    expect(renderPublicProgress(inspection([]))).toContain(
      "No inspectable progress yet.",
    );
  });
});

describe("inspection projection", () => {
  it("projects bounded structured managed results as final records", () => {
    const record = projectFinalInspectionRecord(
      { summary: `done\u001b${"x".repeat(3_000)}` },
      "2024-01-01T00:00:00.000Z",
    );

    expect(record).toMatchObject({
      kind: "message",
      role: "final",
      timestamp: "2024-01-01T00:00:00.000Z",
    });
    expect(record?.kind === "message" ? record.text : "").not.toContain(
      "\u001b",
    );
    expect(
      Buffer.byteLength(record?.kind === "message" ? record.text : ""),
    ).toBeLessThanOrEqual(2048);
  });

  it("retains only structured sanitized arguments needed for historical rendering", () => {
    const projected = projectMessages([
      {
        role: "assistant",
        timestamp: Date.parse("2024-01-01T00:00:00.000Z"),
        content: [
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: { path: "src/a.ts", offset: 2, limit: 3, secret: "no" },
          },
          {
            type: "toolCall",
            id: "grep-1",
            name: "grep",
            arguments: {
              pattern: "needle",
              path: "src",
              glob: "*.ts",
              ignoreCase: true,
              literal: false,
              context: 2,
              limit: 20,
              secret: "no",
            },
          },
          {
            type: "toolCall",
            id: "find-1",
            name: "find",
            arguments: { pattern: "*.test.ts", path: "src", limit: 10 },
          },
          {
            type: "toolCall",
            id: "bash-1",
            name: "bash",
            arguments: { command: "npm test", timeout: 30, env: "secret" },
          },
          {
            type: "toolCall",
            id: "edit-1",
            name: "edit",
            arguments: {
              path: "src/a.ts",
              edits: [{ oldText: "secret old", newText: "secret new" }],
            },
          },
          {
            type: "toolCall",
            id: "custom-1",
            name: "custom",
            arguments: { question: "private prompt" },
          },
        ],
      },
      {
        role: "toolResult",
        timestamp: Date.parse("2024-01-01T00:00:01.000Z"),
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
      },
      {
        role: "toolResult",
        timestamp: Date.parse("2024-01-01T00:00:02.000Z"),
        toolCallId: "edit-1",
        toolName: "edit",
        content: [{ type: "text", text: "sensitive diff" }],
        isError: false,
      },
    ]);

    expect(projected.activity).toEqual([
      expect.objectContaining({
        toolCallId: "read-1",
        status: "completed",
        arguments: { path: "src/a.ts", offset: 2, limit: 3 },
        result: "file contents",
      }),
      expect.objectContaining({
        toolCallId: "grep-1",
        arguments: {
          pattern: "needle",
          path: "src",
          glob: "*.ts",
          ignoreCase: true,
          literal: false,
          context: 2,
          limit: 20,
        },
      }),
      expect.objectContaining({
        toolCallId: "find-1",
        arguments: { pattern: "*.test.ts", path: "src", limit: 10 },
      }),
      expect.objectContaining({
        toolCallId: "bash-1",
        arguments: { command: "npm test", timeout: 30 },
      }),
      expect.objectContaining({
        toolCallId: "edit-1",
        status: "completed",
        arguments: { path: "src/a.ts" },
      }),
      expect.objectContaining({
        toolCallId: "custom-1",
      }),
    ]);
    expect(
      projected.activity.find(
        (item) => item.kind === "tool" && item.toolCallId === "custom-1",
      ),
    ).not.toHaveProperty("arguments");
    expect(JSON.stringify(projected)).not.toContain("secret old");
    expect(JSON.stringify(projected)).not.toContain("secret new");
    expect(JSON.stringify(projected)).not.toContain("sensitive diff");
    expect(JSON.stringify(projected)).not.toContain("private prompt");
  });

  it("keeps chronological order stable and final messages distinct", () => {
    const records = chronologicalInspectionRecords(
      [
        {
          role: "final",
          text: "finished",
          timestamp: "2024-01-01T00:00:04.000Z",
        },
        {
          role: "user",
          text: "start",
          timestamp: "2024-01-01T00:00:01.000Z",
        },
        {
          role: "assistant",
          text: "working",
          timestamp: "2024-01-01T00:00:02.000Z",
        },
      ],
      [
        {
          kind: "tool",
          toolCallId: "tool-1",
          toolName: "read",
          status: "completed",
          arguments: { path: "src/a.ts" },
          result: "contents",
          timestamp: "2024-01-01T00:00:03.000Z",
        },
      ],
    );

    expect(records.map((record) => record.kind)).toEqual([
      "message",
      "message",
      "tool",
      "message",
    ]);
    expect(records.at(-1)).toMatchObject({
      kind: "message",
      role: "final",
      text: "finished",
    });
  });
});
