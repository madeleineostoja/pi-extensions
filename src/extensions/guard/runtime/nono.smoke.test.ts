import { expect, it } from "vitest";
import { getNonoHealth, getNonoTarget, managedNonoPath } from "./nono.js";

it.runIf(getNonoTarget() !== null)(
  "classifies the managed macOS confinement probe as healthy",
  async () => {
    await expect(getNonoHealth()).resolves.toEqual({
      kind: "healthy",
      path: managedNonoPath(),
    });
  },
);
