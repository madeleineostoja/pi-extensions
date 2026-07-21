import { describe, expect, it } from "vitest";
import { parseCommand, usage } from "./parser.js";

describe("parseCommand", () => {
  it("parses auto mode with single plan path", () => {
    const result = parseCommand("path/to/plan.md");
    expect(result).toEqual({
      kind: "execution",
      mode: { kind: "auto", planPath: "path/to/plan.md" },
    });
  });

  it("treats operational words as plan paths", () => {
    expect(parseCommand("status")).toEqual({
      kind: "execution",
      mode: { kind: "auto", planPath: "status" },
    });
    expect(parseCommand("cleanup")).toEqual({
      kind: "execution",
      mode: { kind: "auto", planPath: "cleanup" },
    });
  });

  it("parses internal menu actions", () => {
    expect(parseCommand(":status")).toEqual({
      kind: "control",
      name: "status",
    });
    expect(parseCommand(":stop")).toEqual({
      kind: "control",
      name: "stop",
    });
    expect(parseCommand(":cleanup")).toEqual({
      kind: "control",
      name: "cleanup",
    });
    expect(parseCommand(":config")).toEqual({
      kind: "control",
      name: "config",
    });
    expect(parseCommand(":view")).toEqual({
      kind: "control",
      name: "view",
    });
  });

  it("treats bare 'agents' as plan path", () => {
    expect(parseCommand("agents")).toEqual({
      kind: "execution",
      mode: { kind: "auto", planPath: "agents" },
    });
  });

  it("parses internal inspect menu action", () => {
    expect(parseCommand(":inspect")).toEqual({
      kind: "control",
      name: "inspect",
    });
  });

  it("rejects empty input", () => {
    const result = parseCommand("");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "Usage",
    );
  });

  it("rejects plan path with spaces", () => {
    const result = parseCommand("path to plan.md");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "Usage",
    );
  });

  it("rejects extra positional tokens", () => {
    const result = parseCommand("plan.md extra");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "Usage",
    );
  });

  it("parses explicit retained-run recovery flags", () => {
    expect(parseCommand("plan.md --resume r20240115-120000")).toEqual({
      kind: "execution",
      mode: {
        kind: "auto",
        planPath: "plan.md",
        recovery: { kind: "resume", runId: "r20240115-120000" },
      },
    });
    expect(parseCommand("plan.md --start-over run-2")).toEqual({
      kind: "execution",
      mode: {
        kind: "auto",
        planPath: "plan.md",
        recovery: { kind: "start-over", runId: "run-2" },
      },
    });
  });

  it("rejects missing, duplicate, and conflicting recovery flags", () => {
    for (const input of [
      "plan.md --resume",
      "plan.md --start-over",
      "plan.md --resume one --start-over two",
      "plan.md --serial",
    ]) {
      expect(parseCommand(input).kind).toBe("error");
    }
  });

  it("rejects unknown flags", () => {
    const result = parseCommand("--unknown plan.md");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "Usage",
    );
  });

  it("includes usage text in error", () => {
    expect(usage()).toContain("/implement");
    expect(usage()).toContain("/implement <plan.md>");
  });
});
