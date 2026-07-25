import { describe, expect, it } from "vitest";
import {
  parseConfig,
  resolveEffectiveRoles,
  resolveWorkerConcurrency,
} from "./config.js";

describe("VNext configuration", () => {
  it("keeps only VNext roles and bounded worker concurrency", () => {
    const result = parseConfig(
      JSON.stringify({
        workerConcurrency: 99,
        planner: { type: "Explore" },
        recovery: { model: "provider/model" },
      }),
    );
    expect(result.config.workerConcurrency).toBe(8);
    expect(result.config.recovery).toEqual({ model: "provider/model" });
    expect(resolveWorkerConcurrency(result.config)).toBe(8);
  });

  it("rejects removed legacy configuration", () => {
    const result = parseConfig(
      JSON.stringify({
        maxParallel: 2,
        verifyCommand: "npm test",
        selfHeal: { type: "legacy" },
      }),
    );
    expect(result.config).toEqual({});
    expect(result.warning).toContain("maxParallel is unsupported in VNext");
    expect(result.warning).toContain("verifyCommand is unsupported in VNext");
  });

  it("uses recovery configuration for the internal recovery compatibility role", () => {
    const parsed = parseConfig(
      JSON.stringify({ recovery: { type: "recover" } }),
    );
    const roles = resolveEffectiveRoles(parsed.config, {} as never);
    expect(roles.ok && roles.roles.recovery?.type).toBe("recover");
    expect(roles.ok && roles.roles.selfHeal.type).toBe("recover");
  });
});
