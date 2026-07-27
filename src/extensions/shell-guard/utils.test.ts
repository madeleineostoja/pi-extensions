import { describe, it, expect } from "vitest";
import { formatBlockReason } from "./utils";

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
