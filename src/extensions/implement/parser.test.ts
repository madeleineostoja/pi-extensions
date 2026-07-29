import { describe, expect, it } from "vitest";
import { parseCommand } from "./parser.js";

describe("parseCommand", () => {
  it("parses a plan execution", () => {
    expect(parseCommand("path/to/plan.md")).toEqual({
      kind: "execution",
      planPath: "path/to/plan.md",
    });
  });

  it("rejects continue and parses restart", () => {
    expect(parseCommand("continue plan.md run-1").kind).toBe("error");
    expect(parseCommand("restart plan.md run-1")).toEqual({
      kind: "execution",
      planPath: "plan.md",
      recovery: { kind: "start-over", runId: "run-1" },
    });
  });

  it("parses control subcommands", () => {
    expect(parseCommand("continue")).toEqual({
      kind: "execution",
      planPath: "continue",
    });
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
