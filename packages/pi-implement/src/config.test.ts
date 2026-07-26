import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("pi-implement config", () => {
  it("accepts max thinking for managed roles", () => {
    expect(
      parseConfig(JSON.stringify({ reviewer: { thinking: "max" } })),
    ).toEqual({
      config: { reviewer: { thinking: "max" } },
    });
  });
});
