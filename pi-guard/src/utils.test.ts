import { describe, it, expect } from "vitest";
import { parseGuardArgs, parseGuardTools, formatSteer, extractToolPath, formatModalTitle, formatSteerTitle } from "./utils";

describe("parseGuardTools", () => {
  it("returns default set and usedDefault=false when value is undefined", () => {
    const result = parseGuardTools(undefined);
    expect(result.tools).toEqual(new Set(["edit", "write"]));
    expect(result.usedDefault).toBe(false);
  });

  it('returns default set and usedDefault=true for empty string ""', () => {
    const result = parseGuardTools("");
    expect(result.tools).toEqual(new Set(["edit", "write"]));
    expect(result.usedDefault).toBe(true);
  });

  it('parses "edit" into a single-item set', () => {
    const result = parseGuardTools("edit");
    expect(result.tools).toEqual(new Set(["edit"]));
    expect(result.usedDefault).toBe(false);
  });

  it('parses "edit,write" into both tools', () => {
    const result = parseGuardTools("edit,write");
    expect(result.tools).toEqual(new Set(["edit", "write"]));
    expect(result.usedDefault).toBe(false);
  });

  it('parses "edit, write" (whitespace around tokens)', () => {
    const result = parseGuardTools("edit, write");
    expect(result.tools).toEqual(new Set(["edit", "write"]));
    expect(result.usedDefault).toBe(false);
  });

  it('parses "edit,,write" (empty tokens are ignored)', () => {
    const result = parseGuardTools("edit,,write");
    expect(result.tools).toEqual(new Set(["edit", "write"]));
    expect(result.usedDefault).toBe(false);
  });

  it('parses "edit,write,custom-edit" into all three tools', () => {
    const result = parseGuardTools("edit,write,custom-edit");
    expect(result.tools).toEqual(new Set(["edit", "write", "custom-edit"]));
    expect(result.usedDefault).toBe(false);
  });

  it('parses ",," (only empty tokens) as default fallback', () => {
    const result = parseGuardTools(",,");
    expect(result.tools).toEqual(new Set(["edit", "write"]));
    expect(result.usedDefault).toBe(true);
  });
});

describe("parseGuardArgs", () => {
  it('returns toggle for empty string', () => {
    expect(parseGuardArgs("")).toEqual({ kind: "toggle" });
  });

  it('returns toggle for whitespace-only string', () => {
    expect(parseGuardArgs("   ")).toEqual({ kind: "toggle" });
  });

  it('returns set true for "on"', () => {
    expect(parseGuardArgs("on")).toEqual({ kind: "set", value: true });
  });

  it('returns set false for "OFF" (case-insensitive)', () => {
    expect(parseGuardArgs("OFF")).toEqual({ kind: "set", value: false });
  });

  it('returns status for " status " (with surrounding whitespace)', () => {
    expect(parseGuardArgs(" status ")).toEqual({ kind: "status" });
  });

  it('returns invalid for unknown arg "garbage"', () => {
    expect(parseGuardArgs("garbage")).toEqual({ kind: "invalid" });
  });

  it('returns invalid for "on off" (extra tokens)', () => {
    expect(parseGuardArgs("on off")).toEqual({ kind: "invalid" });
  });

  it('returns set true for "enable"', () => {
    expect(parseGuardArgs("enable")).toEqual({ kind: "set", value: true });
  });

  it('returns set false for "disable"', () => {
    expect(parseGuardArgs("disable")).toEqual({ kind: "set", value: false });
  });

  it('returns set false for "DISABLE" (case-insensitive)', () => {
    expect(parseGuardArgs("DISABLE")).toEqual({ kind: "set", value: false });
  });

  it('returns set true for "true"', () => {
    expect(parseGuardArgs("true")).toEqual({ kind: "set", value: true });
  });

  it('returns set false for "false"', () => {
    expect(parseGuardArgs("false")).toEqual({ kind: "set", value: false });
  });

  it('returns set true for "ENABLE" (case-insensitive)', () => {
    expect(parseGuardArgs("ENABLE")).toEqual({ kind: "set", value: true });
  });

  it('returns set true for "TRUE" (case-insensitive)', () => {
    expect(parseGuardArgs("TRUE")).toEqual({ kind: "set", value: true });
  });

  it('returns invalid for "toString" (prototype key, not a valid alias)', () => {
    expect(parseGuardArgs("toString")).toEqual({ kind: "invalid" });
  });
});

describe("extractToolPath", () => {
  it("returns the path string when present", () => {
    expect(extractToolPath({ path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  it("returns undefined when path field is absent", () => {
    expect(extractToolPath({ content: "hello" })).toBeUndefined();
  });

  it("returns undefined for an empty path string", () => {
    expect(extractToolPath({ path: "" })).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(extractToolPath(null)).toBeUndefined();
  });

  it("returns undefined for a primitive", () => {
    expect(extractToolPath("string")).toBeUndefined();
  });
});

describe("formatModalTitle", () => {
  it("includes tool name and path when path is present", () => {
    expect(formatModalTitle("edit", "src/foo.ts")).toBe("Guard: edit src/foo.ts — apply?");
  });

  it("falls back to tool name only when path is undefined", () => {
    expect(formatModalTitle("edit", undefined)).toBe("Guard: edit — apply?");
  });

  it("works with a different tool name", () => {
    expect(formatModalTitle("write", "lib/bar.ts")).toBe("Guard: write lib/bar.ts — apply?");
  });
});

describe("formatSteerTitle", () => {
  it("includes path when present", () => {
    expect(formatSteerTitle("src/foo.ts")).toBe("Steer the agent — src/foo.ts");
  });

  it("falls back to generic title when path is undefined", () => {
    expect(formatSteerTitle(undefined)).toBe("Steer the agent");
  });
});

describe("formatSteer", () => {
  it('returns declined-without-feedback template for empty string', () => {
    expect(formatSteer("")).toBe(
      "Edit not applied. User declined without feedback. Ask for clarification before retrying."
    );
  });

  it('returns declined-without-feedback template for whitespace-only string', () => {
    expect(formatSteer("   ")).toBe(
      "Edit not applied. User declined without feedback. Ask for clarification before retrying."
    );
  });

  it('returns wrapped template containing the message verbatim', () => {
    const result = formatSteer("use a class not a function");
    expect(result).toBe(
      "Edit not applied. User intercepted the proposed change and provided this feedback:\n\nuse a class not a function\n\nTake this into account. Incorporate this feedback before retrying."
    );
  });

  it('preserves multi-line messages verbatim inside the template', () => {
    const result = formatSteer("line one\nline two");
    expect(result).toBe(
      "Edit not applied. User intercepted the proposed change and provided this feedback:\n\nline one\nline two\n\nTake this into account. Incorporate this feedback before retrying."
    );
  });

  it('trims edge whitespace but preserves the message body', () => {
    const result = formatSteer("  trailing spaces   ");
    expect(result).toBe(
      "Edit not applied. User intercepted the proposed change and provided this feedback:\n\ntrailing spaces\n\nTake this into account. Incorporate this feedback before retrying."
    );
  });
});
