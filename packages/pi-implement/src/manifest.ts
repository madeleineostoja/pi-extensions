import { createHash } from "node:crypto";
import type { ParsedPlan, PlanTask } from "./plan.js";
import {
  buildMaterialStore,
  checkPlanMaterialSize,
  extractPlanReference,
  isPlanLinkageLine,
  MAX_PLAN_MATERIAL_CHARS,
  PlanMaterialSizeError,
  type MaterialStore,
} from "./material-store.js";

export {
  MAX_PLAN_MATERIAL_CHARS,
  PlanMaterialSizeError,
  checkPlanMaterialSize,
};
export { extractPlanReference, isPlanLinkageLine };

export type ReferencedMaterialOrigin = "plan-link" | "task-link";

export type ReferencedMaterial = {
  absolutePath: string;
  displayLabel: string;
  content: string;
  origin: ReferencedMaterialOrigin;
};

export type TaskManifestEntry = {
  planIndex: number;
  fingerprint: string;
  referencedMaterials: ReferencedMaterial[];
};

export type PlanBundleManifest = {
  sourcePlanPath: string;
  tasks: TaskManifestEntry[];
  allArtifactPaths: string[];
  isIndexStyle: boolean;
  validationErrors: string[];
};

export function computeTaskFingerprint(task: PlanTask): string {
  const hash = createHash("sha256");
  hash.update(task.text);
  for (const line of task.blockLines) {
    hash.update("\n");
    hash.update(line);
  }
  return hash.digest("hex");
}

export function formatReferencedMaterial(
  materials: ReferencedMaterial[],
  maxChars = MAX_PLAN_MATERIAL_CHARS,
): string {
  if (materials.length === 0) {
    return "";
  }

  const intro =
    "The following raw plan material is included to help implement the selected task. It may contain context, decisions, acceptance criteria, or requirements used by multiple tasks.\n\nImplement only the selected task above. Do not implement unrelated requirements merely because they appear in referenced material.";

  const parts: string[] = [intro];

  for (const mat of materials) {
    parts.push(`\n### ${mat.displayLabel}\n\n${mat.content}`);
  }

  const result = parts.join("\n");
  checkPlanMaterialSize(result, maxChars);
  return result;
}

export function formatBundleMaterial(
  manifest: PlanBundleManifest,
  maxChars = MAX_PLAN_MATERIAL_CHARS,
): string {
  const seen = new Set<string>();
  const materials: ReferencedMaterial[] = [];

  for (const task of manifest.tasks) {
    for (const mat of task.referencedMaterials) {
      if (!seen.has(mat.absolutePath)) {
        seen.add(mat.absolutePath);
        materials.push(mat);
      }
    }
  }

  if (materials.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const mat of materials) {
    parts.push(`### ${mat.displayLabel}\n\n${mat.content}`);
  }

  const result = parts.join("\n\n");
  checkPlanMaterialSize(result, maxChars);
  return result;
}

export function validatePlanMaterialSizes(
  manifest: PlanBundleManifest,
  maxChars = MAX_PLAN_MATERIAL_CHARS,
): string[] {
  const errors: string[] = [];

  try {
    formatBundleMaterial(manifest, maxChars);
  } catch (err) {
    errors.push(`bundle referenced plan material: ${formatSizeError(err)}`);
  }

  for (const task of manifest.tasks) {
    try {
      formatReferencedMaterial(task.referencedMaterials, maxChars);
    } catch (err) {
      errors.push(
        `task ${task.planIndex} referenced plan material: ${formatSizeError(err)}`,
      );
    }
  }

  return errors;
}

export function buildPlanBundleManifest(
  sourcePlanPath: string,
  plan: ParsedPlan,
): PlanBundleManifest {
  const store = buildMaterialStore({ plan, planPath: sourcePlanPath });
  return manifestFromStore(store, plan);
}

export function manifestFromStore(
  store: MaterialStore,
  plan: ParsedPlan,
): PlanBundleManifest {
  const sourcePlanPath = store.entryPath;
  const taskErrorsByIndex = new Map<number, string[]>();
  for (const error of store.validationErrors) {
    const taskMatch = /^Task (\d+): (.*)$/.exec(error);
    if (!taskMatch) {
      continue;
    }
    const index = Number(taskMatch[1]);
    const message = taskMatch[2] ?? "";
    const list = taskErrorsByIndex.get(index) ?? [];
    list.push(message);
    taskErrorsByIndex.set(index, list);
  }

  const tasks: TaskManifestEntry[] = [];
  let isIndexStyle = false;

  for (const task of plan.tasks) {
    const entry: TaskManifestEntry = {
      planIndex: task.index,
      fingerprint: computeTaskFingerprint(task),
      referencedMaterials: [],
    };

    const referencedPaths = new Set<string>();

    for (const file of store.files) {
      const taskOrigin = file.taskOrigins.find(
        (to) => to.taskIndex === task.index,
      );
      if (!taskOrigin) {
        continue;
      }
      if (referencedPaths.has(file.absolutePath)) {
        continue;
      }
      referencedPaths.add(file.absolutePath);

      const origin: ReferencedMaterialOrigin =
        taskOrigin.origin === "plan-link" ? "plan-link" : "task-link";

      entry.referencedMaterials.push({
        absolutePath: file.absolutePath,
        displayLabel: file.displayPath,
        content: file.content,
        origin,
      });
    }

    if (entry.referencedMaterials.length > 0) {
      isIndexStyle = true;
    }

    tasks.push(entry);
  }

  const validationErrors: string[] = [];
  for (const task of plan.tasks) {
    const errors = taskErrorsByIndex.get(task.index) ?? [];
    for (const error of errors) {
      validationErrors.push(`Task ${task.index}: ${error}`);
    }
  }

  const allArtifactPaths = [
    sourcePlanPath,
    ...store.files
      .filter(
        (file) =>
          file.absolutePath !== sourcePlanPath &&
          (file.origins.includes("plan-link") ||
            file.origins.includes("task-link")),
      )
      .map((file) => file.absolutePath),
  ];

  return {
    sourcePlanPath,
    tasks,
    allArtifactPaths: dedupe(allArtifactPaths),
    isIndexStyle,
    validationErrors,
  };
}

function formatSizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
