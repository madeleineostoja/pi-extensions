import { describe, it, expect } from "vitest";
import { parseGuardArgs, formatBlockReason } from "./utils";

describe("parseGuardArgs", () => {
  it("returns toggle for empty string", () => {
    expect(parseGuardArgs("")).toEqual({ kind: "toggle" });
  });

  it("returns toggle for whitespace-only string", () => {
    expect(parseGuardArgs("   ")).toEqual({ kind: "toggle" });
  });

  it('returns set true for "on"', () => {
    expect(parseGuardArgs("on")).toEqual({ kind: "set", value: true });
  });

  it('returns set false for "OFF" (case-insensitive)', () => {
    expect(parseGuardArgs("OFF")).toEqual({ kind: "set", value: false });
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

  it('returns invalid for "toString" (prototype key, not a valid alias)', () => {
    expect(parseGuardArgs("toString")).toEqual({ kind: "invalid" });
  });
});

describe("formatBlockReason", () => {
  it("returns generic blocked reason for empty string", () => {
    expect(formatBlockReason("")).toBe(
      "Command blocked by user. Do not retry the same command without addressing the user's concern or asking for clarification.",
    );
  });

  it("returns generic blocked reason for whitespace-only string", () => {
    expect(formatBlockReason("   ")).toBe(
      "Command blocked by user. Do not retry the same command without addressing the user's concern or asking for clarification.",
    );
  });

  it("returns wrapped template containing the message verbatim", () => {
    const result = formatBlockReason("do not delete that file");
    expect(result).toBe(
      "Command blocked by user. User feedback:\n\ndo not delete that file\n\nAddress this before retrying.",
    );
  });

  it("trims edge whitespace but preserves the message body", () => {
    const result = formatBlockReason("  trailing spaces   ");
    expect(result).toBe(
      "Command blocked by user. User feedback:\n\ntrailing spaces\n\nAddress this before retrying.",
    );
  });
});
