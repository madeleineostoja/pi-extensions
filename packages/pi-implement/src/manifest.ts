import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
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

const PLAN_REF_LINE_RE =
  /^[ \t]*(?:[-*][ \t]+)?Plan:\s*(?:`([^`]+)`|<([^>]+)>)\s*$/;
const INLINE_MARKDOWN_LINK_RE = /(?<!!)\[[^\]\n]*\]\(([^()\s]+)\)/g;

export function isPlanLinkageLine(line: string): boolean {
  return /^[ \t]*(?:[-*][ \t]+)?Plan:/.test(line);
}

function looksLikeAttemptedPlanReference(line: string): boolean {
  return /^[ \t]*(?:[-*][ \t]+)?Plan:\s*[`<>]/.test(line);
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

function looksLikeScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function stripFragment(target: string): string {
  return target.split("#", 1)[0] ?? "";
}

function nearestGitRoot(sourceDir: string): string | undefined {
  let current = resolve(sourceDir);

  for (;;) {
    try {
      const root = execFileSync(
        "git",
        ["-C", current, "rev-parse", "--show-toplevel"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (root) {
        return resolve(root);
      }
    } catch {}

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isInsideRoot(root: string, absolutePath: string): boolean {
  const rel = relative(root, absolutePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validatePlanTarget(
  sourceDir: string,
  target: string,
  allowedRoot: string,
): { absolutePath: string; content: string } | string {
  if (looksLikeUrl(target)) {
    return `URL Plan: targets are not supported: ${target}`;
  }

  const targetPath = stripFragment(target).trim();
  if (!targetPath) {
    return `missing or unreadable Plan: target: ${target}`;
  }

  const absolutePath = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(join(sourceDir, targetPath));

  let realAbsolutePath: string;
  try {
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      return `Plan: target is a directory: ${target}`;
    }
    realAbsolutePath = realpathSync(absolutePath);
  } catch {
    return `missing or unreadable Plan: target: ${target}`;
  }

  if (!isInsideRoot(realpathSync(allowedRoot), realAbsolutePath)) {
    return `Plan: target escapes allowed root: ${target}`;
  }

  if (!targetPath.toLowerCase().endsWith(".md")) {
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

function discoverInlineMarkdownLinks(lines: string[]): string[] {
  const targets: string[] = [];
  let fenced: { marker: "`" | "~"; length: number } | undefined;

  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const markerText = fence[1] ?? "";
      const marker = markerText[0] as "`" | "~";
      if (fenced) {
        if (fenced.marker === marker && markerText.length >= fenced.length) {
          fenced = undefined;
        }
      } else {
        fenced = { marker, length: markerText.length };
      }
      continue;
    }

    if (fenced) {
      continue;
    }

    const searchable = stripInlineCodeSpans(line);
    let match: RegExpExecArray | null;
    while ((match = INLINE_MARKDOWN_LINK_RE.exec(searchable)) !== null) {
      const target = (match[1] ?? "").trim();
      if (!target || looksLikeScheme(target) || target.startsWith("#")) {
        continue;
      }
      const targetPath = stripFragment(target).trim();
      if (!targetPath || !targetPath.toLowerCase().endsWith(".md")) {
        continue;
      }
      targets.push(target);
    }
  }

  return targets;
}

function stripInlineCodeSpans(line: string): string {
  let result = "";
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      result += line[i];
      i++;
      continue;
    }

    let tickCount = 1;
    while (line[i + tickCount] === "`") {
      tickCount++;
    }
    const closing = line.indexOf("`".repeat(tickCount), i + tickCount);
    if (closing === -1) {
      result += " ".repeat(tickCount);
      i += tickCount;
      continue;
    }
    result += " ".repeat(closing + tickCount - i);
    i = closing + tickCount;
  }
  return result;
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

export class PlanMaterialSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanMaterialSizeError";
  }
}

export function checkPlanMaterialSize(content: string, maxChars: number): void {
  if (content.length > maxChars) {
    throw new PlanMaterialSizeError(
      `Plan material exceeds maximum size of ${maxChars} characters (${content.length} characters). Reduce plan size or increase the limit.`,
    );
  }
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

function formatSizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function buildPlanBundleManifest(
  sourcePlanPath: string,
  plan: ParsedPlan,
): PlanBundleManifest {
  const sourceDir = dirname(sourcePlanPath);
  const allowedRoot = nearestGitRoot(sourceDir) ?? sourceDir;
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
    const referencedPaths = new Set<string>();
    const addMaterialRef = (
      target: string,
      origin: ReferencedMaterialOrigin,
    ) => {
      const validation = validatePlanTarget(sourceDir, target, allowedRoot);
      if (typeof validation === "string") {
        manifest.validationErrors.push(`Task ${task.index}: ${validation}`);
        return;
      }
      if (referencedPaths.has(validation.absolutePath)) {
        return;
      }
      referencedPaths.add(validation.absolutePath);

      entry.referencedMaterials.push({
        absolutePath: validation.absolutePath,
        displayLabel: basename(validation.absolutePath),
        content: validation.content,
        origin,
      });

      if (!manifest.allArtifactPaths.includes(validation.absolutePath)) {
        manifest.allArtifactPaths.push(validation.absolutePath);
      }
    };

    for (const line of task.blockLines) {
      const ref = extractPlanReference(line);
      if (ref) {
        hasLinkage = true;
        addMaterialRef(ref.target, "plan-link");
        continue;
      }

      if (looksLikeAttemptedPlanReference(line)) {
        hasLinkage = true;
        manifest.validationErrors.push(
          `Task ${task.index}: unsupported or malformed Plan: line: ${line.trim()}`,
        );
        continue;
      }

      // Natural-language Plan: notes are ignored
    }

    for (const target of discoverInlineMarkdownLinks(task.blockLines)) {
      addMaterialRef(target, "task-link");
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
