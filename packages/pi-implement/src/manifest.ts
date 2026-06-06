import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { ParsedPlan, PlanTask } from "./plan.js";

export const MAX_PLAN_MATERIAL_CHARS = 100_000;

export type ReferencedMaterial = {
  absolutePath: string;
  displayLabel: string;
  content: string;
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

const PLAN_REF_LINE_RE =
  /^[ \t]*(?:[-*][ \t]+)?Plan:\s*(?:`([^`]+)`|<([^>]+)>)\s*$/;

export function isPlanLinkageLine(line: string): boolean {
  return /^[ \t]*(?:[-*][ \t]+)?Plan:/.test(line);
}

export function extractPlanReference(
  line: string,
): { target: string } | undefined {
  const match = PLAN_REF_LINE_RE.exec(line);
  if (!match) {
    return undefined;
  }
  const target = (match[1] ?? match[2] ?? "").trim();
  if (!target) {
    return undefined;
  }
  return { target };
}

export function computeTaskFingerprint(task: PlanTask): string {
  const hash = createHash("sha256");
  hash.update(task.text);
  for (const line of task.blockLines) {
    hash.update("\n");
    hash.update(line);
  }
  return hash.digest("hex");
}

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  }
}

function validatePlanTarget(
  sourceDir: string,
  target: string,
): { absolutePath: string; content: string } | string {
  if (looksLikeUrl(target)) {
    return `URL Plan: targets are not supported: ${target}`;
  }

  const absolutePath = isAbsolute(target)
    ? resolve(target)
    : resolve(join(sourceDir, target));

  try {
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      return `Plan: target is a directory: ${target}`;
    }
  } catch {
    return `missing or unreadable Plan: target: ${target}`;
  }

  if (!target.toLowerCase().endsWith(".md")) {
    return `non-markdown Plan: target: ${target}`;
  }

  let content: string;
  try {
    content = readFileSync(absolutePath, "utf-8");
  } catch {
    return `missing or unreadable Plan: target: ${target}`;
  }

  if (!content.trim()) {
    return `empty or whitespace-only Plan: target: ${target}`;
  }

  return { absolutePath, content };
}

export function buildPlanBundleManifest(
  sourcePlanPath: string,
  plan: ParsedPlan,
): PlanBundleManifest {
  const sourceDir = dirname(sourcePlanPath);
  const manifest: PlanBundleManifest = {
    sourcePlanPath: resolve(sourcePlanPath),
    tasks: [],
    allArtifactPaths: [resolve(sourcePlanPath)],
    isIndexStyle: false,
    validationErrors: [],
  };

  for (const task of plan.tasks) {
    const entry: TaskManifestEntry = {
      planIndex: task.index,
      fingerprint: computeTaskFingerprint(task),
      referencedMaterials: [],
    };

    let hasLinkage = false;

    for (const line of task.blockLines) {
      if (!isPlanLinkageLine(line)) {
        continue;
      }
      hasLinkage = true;

      const ref = extractPlanReference(line);
      if (!ref) {
        manifest.validationErrors.push(
          `Task ${task.index}: unsupported or malformed Plan: line: ${line.trim()}`,
        );
        continue;
      }

      const validation = validatePlanTarget(sourceDir, ref.target);
      if (typeof validation === "string") {
        manifest.validationErrors.push(`Task ${task.index}: ${validation}`);
        continue;
      }

      entry.referencedMaterials.push({
        absolutePath: validation.absolutePath,
        displayLabel: basename(validation.absolutePath),
        content: validation.content,
      });

      if (!manifest.allArtifactPaths.includes(validation.absolutePath)) {
        manifest.allArtifactPaths.push(validation.absolutePath);
      }
    }

    if (hasLinkage) {
      manifest.isIndexStyle = true;
    }

    manifest.tasks.push(entry);
  }

  for (const entry of manifest.tasks) {
    const counts = new Map<string, number>();
    for (const mat of entry.referencedMaterials) {
      counts.set(mat.displayLabel, (counts.get(mat.displayLabel) ?? 0) + 1);
    }
    for (const mat of entry.referencedMaterials) {
      if (counts.get(mat.displayLabel)! > 1) {
        mat.displayLabel = relative(
          dirname(manifest.sourcePlanPath),
          mat.absolutePath,
        );
      }
    }
  }

  return manifest;
}
