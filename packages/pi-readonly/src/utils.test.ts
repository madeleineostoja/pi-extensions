import { describe, it, expect } from "vitest";
import {
  parseReadonlyArgs,
  formatSteer,
  extractToolPath,
  formatModalTitle,
  formatSteerTitle,
} from "./utils";

describe("parseReadonlyArgs", () => {
  it("returns toggle for empty string", () => {
    expect(parseReadonlyArgs("")).toEqual({ kind: "toggle" });
  });

  it("returns toggle for whitespace-only string", () => {
    expect(parseReadonlyArgs("   ")).toEqual({ kind: "toggle" });
  });

  it('returns set true for "on"', () => {
    expect(parseReadonlyArgs("on")).toEqual({ kind: "set", value: true });
  });

  it('returns set false for "OFF" (case-insensitive)', () => {
    expect(parseReadonlyArgs("OFF")).toEqual({ kind: "set", value: false });
  });

  it('returns invalid for "status" (no longer recognized)', () => {
    expect(parseReadonlyArgs(" status ")).toEqual({ kind: "invalid" });
  });

  it('returns invalid for unknown arg "garbage"', () => {
    expect(parseReadonlyArgs("garbage")).toEqual({ kind: "invalid" });
  });

  it('returns invalid for "on off" (extra tokens)', () => {
    expect(parseReadonlyArgs("on off")).toEqual({ kind: "invalid" });
  });

  it('returns set true for "enable"', () => {
    expect(parseReadonlyArgs("enable")).toEqual({ kind: "set", value: true });
  });

  it('returns set false for "disable"', () => {
    expect(parseReadonlyArgs("disable")).toEqual({ kind: "set", value: false });
  });

  it('returns set false for "DISABLE" (case-insensitive)', () => {
    expect(parseReadonlyArgs("DISABLE")).toEqual({ kind: "set", value: false });
  });

  it('returns set true for "true"', () => {
    expect(parseReadonlyArgs("true")).toEqual({ kind: "set", value: true });
  });

  it('returns set false for "false"', () => {
    expect(parseReadonlyArgs("false")).toEqual({ kind: "set", value: false });
  });

  it('returns set true for "ENABLE" (case-insensitive)', () => {
    expect(parseReadonlyArgs("ENABLE")).toEqual({ kind: "set", value: true });
  });

  it('returns set true for "TRUE" (case-insensitive)', () => {
    expect(parseReadonlyArgs("TRUE")).toEqual({ kind: "set", value: true });
  });

  it('returns invalid for "toString" (prototype key, not a valid alias)', () => {
    expect(parseReadonlyArgs("toString")).toEqual({ kind: "invalid" });
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
    expect(formatModalTitle("edit", "src/foo.ts")).toBe(
      "Readonly: edit src/foo.ts — apply?",
    );
  });

  it("falls back to tool name only when path is undefined", () => {
    expect(formatModalTitle("edit", undefined)).toBe("Readonly: edit — apply?");
  });

  it("works with a different tool name", () => {
    expect(formatModalTitle("write", "lib/bar.ts")).toBe(
      "Readonly: write lib/bar.ts — apply?",
    );
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
  it("returns declined-without-feedback template for empty string", () => {
    expect(formatSteer("")).toBe(
      "Edit not applied. User declined without feedback. Ask for clarification before retrying.",
    );
  });

  it("returns declined-without-feedback template for whitespace-only string", () => {
    expect(formatSteer("   ")).toBe(
      "Edit not applied. User declined without feedback. Ask for clarification before retrying.",
    );
  });

  it("returns wrapped template containing the message verbatim", () => {
    const result = formatSteer("use a class not a function");
    expect(result).toBe(
      "Edit not applied. User intercepted the proposed change and provided this feedback:\n\nuse a class not a function\n\nTake this into account. Incorporate this feedback before retrying.",
    );
  });

  it("preserves multi-line messages verbatim inside the template", () => {
    const result = formatSteer("line one\nline two");
    expect(result).toBe(
      "Edit not applied. User intercepted the proposed change and provided this feedback:\n\nline one\nline two\n\nTake this into account. Incorporate this feedback before retrying.",
    );
  });

  it("trims edge whitespace but preserves the message body", () => {
    const result = formatSteer("  trailing spaces   ");
    expect(result).toBe(
      "Edit not applied. User intercepted the proposed change and provided this feedback:\n\ntrailing spaces\n\nTake this into account. Incorporate this feedback before retrying.",
    );
  });
});
