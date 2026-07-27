import { describe, expect, it } from "vitest";
import { truncateUtf8 } from "./inspection.js";

describe("truncateUtf8", () => {
  it("bounds large multibyte text without splitting a character", () => {
    const truncated = truncateUtf8("é".repeat(25_000), 2048);

    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(2048);
    expect(truncated).toMatch(/…$/);
    expect(truncated).not.toContain("�");
  });

  it("returns text that already fits unchanged", () => {
    expect(truncateUtf8("unchanged", 2048)).toBe("unchanged");
  });
});
