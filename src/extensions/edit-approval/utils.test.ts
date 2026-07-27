import { describe, it, expect } from "vitest";
import {
  parseReadonlyArgs,
  formatSteer,
  extractToolPath,
  formatModalTitle,
  formatSteerTitle,
} from "./utils";

describe("parseReadonlyArgs", () => {
  it("parses toggle, explicit modes, and aliases", () => {
    expect(parseReadonlyArgs("")).toEqual({ kind: "toggle" });
    expect(parseReadonlyArgs("   ")).toEqual({ kind: "toggle" });
    expect(parseReadonlyArgs("on")).toEqual({ kind: "set", value: true });
    expect(parseReadonlyArgs("OFF")).toEqual({ kind: "set", value: false });
    expect(parseReadonlyArgs("enable")).toEqual({ kind: "set", value: true });
    expect(parseReadonlyArgs("TRUE")).toEqual({ kind: "set", value: true });
    expect(parseReadonlyArgs("false")).toEqual({ kind: "set", value: false });
  });

  it("rejects unknown or multi-token arguments", () => {
    expect(parseReadonlyArgs(" status ")).toEqual({ kind: "invalid" });
    expect(parseReadonlyArgs("garbage")).toEqual({ kind: "invalid" });
    expect(parseReadonlyArgs("on off")).toEqual({ kind: "invalid" });
    expect(parseReadonlyArgs("toString")).toEqual({ kind: "invalid" });
  });
});

describe("tool path and modal labels", () => {
  it("extracts only non-empty string path values", () => {
    expect(extractToolPath({ path: "src/foo.ts" })).toBe("src/foo.ts");
    expect(extractToolPath({ content: "hello" })).toBeUndefined();
    expect(extractToolPath({ path: "" })).toBeUndefined();
    expect(extractToolPath(null)).toBeUndefined();
    expect(extractToolPath("string")).toBeUndefined();
  });

  it("includes paths in user-facing modal titles when present", () => {
    expect(formatModalTitle("edit", "src/foo.ts")).toBe(
      "Readonly: edit src/foo.ts — apply?",
    );
    expect(formatModalTitle("edit", undefined)).toBe("Readonly: edit — apply?");
    expect(formatSteerTitle("src/foo.ts")).toBe("Steer the agent — src/foo.ts");
    expect(formatSteerTitle(undefined)).toBe("Steer the agent");
  });
});

describe("formatSteer", () => {
  it("uses the declined-without-feedback guidance when feedback is empty", () => {
    const guidance =
      "Edit not applied. User declined without feedback. Ask for clarification before retrying.";

    expect(formatSteer("")).toBe(guidance);
    expect(formatSteer("   ")).toBe(guidance);
  });

  it("wraps trimmed feedback while preserving the message body", () => {
    const result = formatSteer("  line one\nline two  ");

    expect(result).toContain("User intercepted the proposed change");
    expect(result).toContain("line one\nline two");
    expect(result).toContain("Incorporate this feedback before retrying.");
  });
});
