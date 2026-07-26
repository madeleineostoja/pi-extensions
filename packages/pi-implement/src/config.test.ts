import { describe, expect, it } from "vitest";
import { resolveEffectiveRoles } from "./config.js";

describe("pi-implement role configuration", () => {
  it("uses the dedicated role defaults", () => {
    expect(resolveEffectiveRoles({}).roles).toMatchObject({
      planner: { type: "pi-implement:planner" },
      implementer: { type: "pi-implement:implementer" },
      reviewer: { type: "Review" },
      recovery: { type: "pi-implement:recovery" },
    });
  });
});
