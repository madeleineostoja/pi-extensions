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

  it("parses serial mode", () => {
    const result = parseCommand("--serial path/to/plan.md");
    expect(result).toEqual({
      kind: "execution",
      mode: { kind: "serial", planPath: "path/to/plan.md" },
    });
  });

  it("parses parallel mode with concurrency", () => {
    const result = parseCommand("--parallel 5 path/to/plan.md");
    expect(result).toEqual({
      kind: "execution",
      mode: { kind: "parallel", concurrency: 5, planPath: "path/to/plan.md" },
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

  it("parses agents subcommand", () => {
    expect(parseCommand("agents")).toEqual({
      kind: "subcommand",
      name: "agents",
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

  it("rejects --serial without plan path", () => {
    const result = parseCommand("--serial");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "Usage",
    );
  });

  it("rejects --serial with extra tokens", () => {
    const result = parseCommand("--serial plan.md extra");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "Usage",
    );
  });

  it("rejects --parallel without concurrency", () => {
    const result = parseCommand("--parallel");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "Usage",
    );
  });

  it("rejects --parallel with non-integer concurrency", () => {
    const result = parseCommand("--parallel 3.5 plan.md");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "positive integer",
    );
  });

  it("rejects --parallel with zero concurrency", () => {
    const result = parseCommand("--parallel 0 plan.md");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "positive integer",
    );
  });

  it("rejects --parallel with negative concurrency", () => {
    const result = parseCommand("--parallel -1 plan.md");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain(
      "positive integer",
    );
  });

  it("rejects --parallel with space-containing plan path", () => {
    const result = parseCommand("--parallel 2 path to plan.md");
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
    expect(usage()).toContain("--serial");
    expect(usage()).toContain("--parallel");
    expect(usage()).toContain("status");
    expect(usage()).toContain("stop");
    expect(usage()).toContain("cleanup");
    expect(usage()).toContain("config");
    expect(usage()).toContain("agents");
  });
});
