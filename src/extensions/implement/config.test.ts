import { describe, expect, it } from "vitest";
import { parseConfig, resolveEffectiveRoles } from "./config.js";

describe("pi-implement config", () => {
  it("uses the dedicated role defaults", () => {
    expect(resolveEffectiveRoles({}).roles).toMatchObject({
      planner: { type: "pi-implement:planner" },
      implementer: { type: "pi-implement:implementer" },
      reviewer: { type: "Review" },
      recovery: { type: "pi-implement:recovery" },
    });
  });

  it("accepts max thinking for managed roles", () => {
    expect(
      parseConfig(JSON.stringify({ reviewer: { thinking: "max" } })),
    ).toEqual({
      config: { reviewer: { thinking: "max" } },
    });
  });
});
