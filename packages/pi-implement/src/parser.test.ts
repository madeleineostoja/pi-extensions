import { describe, expect, it } from "vitest";
import { parseCommand } from "./parser.js";

describe("parseCommand", () => {
  it("parses a plan execution", () => {
    expect(parseCommand("path/to/plan.md")).toEqual({
      kind: "execution",
      planPath: "path/to/plan.md",
    });
  });

  it("parses resume and restart", () => {
    expect(parseCommand("resume plan.md run-1")).toEqual({
      kind: "execution",
      planPath: "plan.md",
      recovery: { kind: "resume", runId: "run-1" },
    });
    expect(parseCommand("restart plan.md run-1")).toEqual({
      kind: "execution",
      planPath: "plan.md",
      recovery: { kind: "start-over", runId: "run-1" },
    });
  });

  it("parses control subcommands", () => {
    expect(parseCommand("stop")).toEqual({ kind: "control", name: "stop" });
    expect(parseCommand("inspect run-1")).toEqual({
      kind: "control",
      name: "inspect",
      runId: "run-1",
    });
    expect(parseCommand("cleanup run-1")).toEqual({
      kind: "control",
      name: "cleanup",
      runId: "run-1",
    });
  });

  it("rejects removed command syntax", () => {
    expect(parseCommand("run plan.md").kind).toBe("error");
    expect(parseCommand(":status").kind).toBe("error");
    expect(parseCommand("abandon run-1").kind).toBe("error");
  });
});
