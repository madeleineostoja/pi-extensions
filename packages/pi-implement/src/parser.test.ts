import { describe, expect, it } from "vitest";
import { parseCommand } from "./parser.js";

describe("parseCommand", () => {
  it("parses a VNext plan execution", () => {
    expect(parseCommand("path/to/plan.md")).toEqual({
      kind: "execution",
      planPath: "path/to/plan.md",
    });
  });

  it("parses explicit VNext resume and start-over", () => {
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

  it("parses VNext controls with their optional run identity", () => {
    expect(parseCommand(":stop")).toEqual({ kind: "control", name: "stop" });
    expect(parseCommand(":inspect run-1")).toEqual({
      kind: "control",
      name: "inspect",
      runId: "run-1",
    });
  });
});
