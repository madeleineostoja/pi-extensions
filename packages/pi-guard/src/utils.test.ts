import { describe, it, expect } from "vitest";
import { parseGuardArgs, formatBlockReason } from "./utils";

describe("parseGuardArgs", () => {
  it("parses toggle, explicit modes, and aliases", () => {
    expect(parseGuardArgs("")).toEqual({ kind: "toggle" });
    expect(parseGuardArgs("   ")).toEqual({ kind: "toggle" });
    expect(parseGuardArgs("on")).toEqual({ kind: "set", value: true });
    expect(parseGuardArgs("OFF")).toEqual({ kind: "set", value: false });
    expect(parseGuardArgs("enable")).toEqual({ kind: "set", value: true });
    expect(parseGuardArgs("disable")).toEqual({ kind: "set", value: false });
  });

  it("rejects unknown or multi-token arguments", () => {
    expect(parseGuardArgs("garbage")).toEqual({ kind: "invalid" });
    expect(parseGuardArgs("on off")).toEqual({ kind: "invalid" });
    expect(parseGuardArgs("toString")).toEqual({ kind: "invalid" });
  });
});

describe("formatBlockReason", () => {
  it("uses the generic blocked reason when no feedback is provided", () => {
    const generic =
      "Command blocked by user. Do not retry the same command without addressing the user's concern or asking for clarification.";

    expect(formatBlockReason("")).toBe(generic);
    expect(formatBlockReason("   ")).toBe(generic);
  });

  it("wraps trimmed user feedback in the retry guidance", () => {
    const result = formatBlockReason("  do not delete that file   ");

    expect(result).toContain("Command blocked by user. User feedback:");
    expect(result).toContain("do not delete that file");
    expect(result).toContain("Address this before retrying.");
  });
});
