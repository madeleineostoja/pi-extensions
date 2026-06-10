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

  it("parses status subcommand", () => {
    expect(parseCommand("status")).toEqual({
      kind: "subcommand",
      name: "status",
    });
  });

  it("parses stop subcommand", () => {
    expect(parseCommand("stop")).toEqual({
      kind: "subcommand",
      name: "stop",
    });
  });

  it("parses cleanup subcommand", () => {
    expect(parseCommand("cleanup")).toEqual({
      kind: "subcommand",
      name: "cleanup",
    });
  });

  it("parses config subcommand", () => {
    expect(parseCommand("config")).toEqual({
      kind: "subcommand",
      name: "config",
    });
  });

  it("parses view subcommand", () => {
    expect(parseCommand("view")).toEqual({
      kind: "subcommand",
      name: "view",
    });
  });

  it("treats bare 'agents' as plan path", () => {
    expect(parseCommand("agents")).toEqual({
      kind: "execution",
      mode: { kind: "auto", planPath: "agents" },
    });
  });

  it("parses inspect subcommand", () => {
    expect(parseCommand("inspect")).toEqual({
      kind: "subcommand",
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
    expect(usage()).toContain("/implement <plan.md>");
    expect(usage()).toContain("status");
    expect(usage()).toContain("stop");
    expect(usage()).toContain("cleanup");
    expect(usage()).toContain("config");
    expect(usage()).toContain("view");
    expect(usage()).toContain("inspect");
  });
});
