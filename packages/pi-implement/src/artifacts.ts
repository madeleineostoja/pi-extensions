import type { ParsedPlan } from "./plan.js";
import { buildPlanBundleManifest } from "./manifest.js";

export function resolvePlanArtifacts(
  sourcePlanPath: string,
  plan: ParsedPlan,
): string[] {
  const manifest = buildPlanBundleManifest(sourcePlanPath, plan);
  if (manifest.validationErrors.length > 0) {
    throw new Error(
      `Plan bundle validation failed:\n${manifest.validationErrors.join("\n")}`,
    );
  }
  return manifest.allArtifactPaths;
}
