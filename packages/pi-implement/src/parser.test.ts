import { describe, expect, it } from "vitest";
import { parseCommand, usage } from "./parser.js";

describe("parseCommand", () => {
  it("parses auto mode with single plan path", () => {
    const result = parseCommand("path/to/plan.md");
    expect(result).toEqual({
      kind: "execution",
      mode: { kind: "auto", planPath: "path/to/plan.md", forceSerial: false },
    });
  });

  it("treats operational words as plan paths", () => {
    expect(parseCommand("status")).toEqual({
      kind: "execution",
      mode: { kind: "auto", planPath: "status", forceSerial: false },
    });
    expect(parseCommand("cleanup")).toEqual({
      kind: "execution",
      mode: { kind: "auto", planPath: "cleanup", forceSerial: false },
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
      mode: { kind: "auto", planPath: "agents", forceSerial: false },
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
