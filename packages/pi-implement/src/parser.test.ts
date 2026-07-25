import { describe, expect, it } from "vitest";
import { parseCommand, usage } from "./parser.js";

describe("parseCommand", () => {
  it("parses a VNext plan execution", () => {
    expect(parseCommand("path/to/plan.md")).toEqual({
      kind: "execution",
      planPath: "path/to/plan.md",
    });
  });

  it("parses explicit VNext resume only", () => {
    expect(parseCommand("plan.md --resume run-1")).toEqual({
      kind: "execution",
      planPath: "plan.md",
      recovery: { kind: "resume", runId: "run-1" },
    });
    expect(parseCommand("plan.md --start-over run-1")).toEqual({
      kind: "error",
      message: usage(),
    });
  });

  it("parses VNext stop control", () => {
    expect(parseCommand(":stop")).toEqual({ kind: "control", name: "stop" });
  });
});
