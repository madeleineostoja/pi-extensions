import { describe, expect, it } from "vitest";
import { parseCommand } from "./parser.js";

describe("parseCommand", () => {
  it("parses a plan execution", () => {
    expect(parseCommand("path/to/plan.md")).toEqual({
      kind: "execution",
      planPath: "path/to/plan.md",
    });
  });

  it("parses explicit resume and start-over", () => {
    expect(parseCommand("plan.md --resume run-1")).toEqual({
      kind: "execution",
      planPath: "plan.md",
      recovery: { kind: "resume", runId: "run-1" },
    });
    expect(parseCommand("plan.md --start-over run-1")).toEqual({
      kind: "execution",
      planPath: "plan.md",
      recovery: { kind: "start-over", runId: "run-1" },
    });
  });

  it("parses controls with their optional run identity", () => {
    expect(parseCommand(":stop")).toEqual({ kind: "control", name: "stop" });
    expect(parseCommand(":inspect run-1")).toEqual({
      kind: "control",
      name: "inspect",
      runId: "run-1",
    });
    expect(parseCommand(":abandon run-1")).toEqual({
      kind: "control",
      name: "abandon",
      runId: "run-1",
    });
  });
});
