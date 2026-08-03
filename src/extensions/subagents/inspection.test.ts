import { describe, expect, it } from "vitest";
import {
  chronologicalInspectionRecords,
  projectFinalInspectionRecord,
  projectMessages,
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
