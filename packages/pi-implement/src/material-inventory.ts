import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  renderSourceMaterialPacket,
  type RenderedSourceMaterialPacket,
  type SourceMaterialRef,
} from "./execution-plan.js";
import type { PlanBundleManifest } from "./manifest.js";
import type { ParsedPlan } from "./plan.js";
import type { PlanCorpus } from "./corpus.js";

export const MAX_TASK_RENDERED_MATERIAL_CHARS = 100_000;

export type Phase1FrozenMaterial = {
  absolutePath: string;
  displayLabel: string;
  content: string;
  hash: string;
};

export type Phase1MaterialInventory = {
  planPath: string;
  planDir: string;
  repoRoot?: string;
  allowedRoots: string[];
  materials: Phase1FrozenMaterial[];
};

export type BuildPhase1MaterialInventoryArgs = {
  plan: ParsedPlan;
  planPath: string;
  manifest?: PlanBundleManifest;
  corpus?: PlanCorpus;
  repoRoot?: string;
};

export type RenderPhase1TaskMaterialArgs = {
  inventory: Phase1MaterialInventory;
  refs: SourceMaterialRef[] | undefined;
  maxChars?: number;
};

export function buildPhase1MaterialInventory(
  args: BuildPhase1MaterialInventoryArgs,
): Phase1MaterialInventory {
  const planPath = resolve(args.planPath);
  const planDir = dirname(planPath);
  const repoRoot = args.repoRoot ? resolve(args.repoRoot) : undefined;
  const allowedRoots = phase1AllowedRoots(planPath, planDir, repoRoot);
  const byAbsolutePath = new Map<string, Phase1FrozenMaterial>();

  const addMaterial = (material: Omit<Phase1FrozenMaterial, "hash">) => {
    const absolutePath = resolve(material.absolutePath);
    const existing = byAbsolutePath.get(absolutePath);
    const hash = hashText(material.content);
    if (existing) {
      return;
    }
    byAbsolutePath.set(absolutePath, {
      ...material,
      absolutePath,
      hash,
    });
  };

  addMaterial({
    absolutePath: planPath,
    displayLabel: "Selected Task Source Anchor",
    content: args.plan.content,
  });

  for (const task of args.manifest?.tasks ?? []) {
    for (const material of task.referencedMaterials) {
      addMaterial({
        absolutePath: material.absolutePath,
        displayLabel: material.displayLabel,
        content: material.content,
      });
    }
  }

  for (const file of args.corpus?.files ?? []) {
    addMaterial({
      absolutePath: file.absolutePath,
      displayLabel: file.displayPath,
      content: file.content,
    });
  }

  return {
    planPath,
    planDir,
    repoRoot,
    allowedRoots,
    materials: Array.from(byAbsolutePath.values()),
  };
}

export function renderPhase1TaskMaterial(
  args: RenderPhase1TaskMaterialArgs,
): RenderedSourceMaterialPacket | undefined {
  const refs = deterministicPhase1Refs(args.refs);
  if (refs.length === 0) {
    return undefined;
  }

  const inventoryByPath = new Map(
    args.inventory.materials.map((material) => [
      material.absolutePath,
      material,
    ]),
  );

  validateFrozenRefs(args.inventory, inventoryByPath, refs);

  const packet = renderSourceMaterialPacket(refs, {
    resolvePath: (ref) => resolvePhase1MaterialRefPath(ref, args.inventory),
    readFileContent: ({ absolutePath }) => {
      const material = inventoryByPath.get(absolutePath);
      if (!material) {
        throw new Error("path is not in the frozen Phase 1 material inventory");
      }
      return material.content;
    },
  });

  if (!packet) {
    return undefined;
  }

  validateRenderedMaterialSize(
    packet,
    args.maxChars ?? MAX_TASK_RENDERED_MATERIAL_CHARS,
  );
  return packet;
}

export function validatePhase1MaterialInventoryCurrent(
  inventory: Phase1MaterialInventory,
): void {
  for (const material of inventory.materials) {
    validateFrozenMaterialCurrent(material, inventory);
  }
}

function deterministicPhase1Refs(
  refs: SourceMaterialRef[] | undefined,
): SourceMaterialRef[] {
  return (refs ?? []).filter(
    (ref) => ref.origin === "task-anchor" || ref.origin === "task-link",
  );
}

function validateFrozenRefs(
  inventory: Phase1MaterialInventory,
  inventoryByPath: Map<string, Phase1FrozenMaterial>,
  refs: SourceMaterialRef[],
): void {
  for (const ref of refs) {
    const resolution = resolvePhase1MaterialRefPath(ref, inventory);
    if (!resolution.ok) {
      throw new Error(
        `Invalid deterministic source material ref (${ref.origin} ${ref.path}): ${resolution.reason}`,
      );
    }

    const material = inventoryByPath.get(resolution.absolutePath);
    if (!material) {
      throw new Error(
        `Invalid deterministic source material ref (${ref.origin} ${ref.path}): path is not in the frozen Phase 1 material inventory`,
      );
    }

    validateFrozenMaterialCurrent(material, inventory);
  }
}

function validateFrozenMaterialCurrent(
  material: Phase1FrozenMaterial,
  inventory: Phase1MaterialInventory,
): void {
  if (!existsSync(material.absolutePath)) {
    throw new Error(
      `Phase 1 material changed after inventory creation: missing ${material.absolutePath}`,
    );
  }
  const current = readFileSync(material.absolutePath, "utf-8");
  const currentHash =
    resolve(material.absolutePath) === inventory.planPath
      ? hashText(normalizePlanCheckboxes(current))
      : hashText(current);
  const frozenHash =
    resolve(material.absolutePath) === inventory.planPath
      ? hashText(normalizePlanCheckboxes(material.content))
      : material.hash;
  if (currentHash !== frozenHash) {
    throw new Error(
      `Phase 1 material changed after inventory creation: ${material.absolutePath} hash ${currentHash} does not match frozen hash ${frozenHash}`,
    );
  }
}

export function resolvePhase1MaterialRefPath(
  ref: SourceMaterialRef,
  inventory: Phase1MaterialInventory,
): { ok: true; absolutePath: string } | { ok: false; reason: string } {
  if (looksLikeUrl(ref.path)) {
    return { ok: false, reason: "URLs are not allowed for packet material" };
  }

  const path = stripFragment(ref.path).trim();
  if (!path) {
    return { ok: false, reason: "path is empty" };
  }

  const candidates = isAbsolute(path)
    ? [resolve(path)]
    : [
        resolve(inventory.planDir, path),
        ...(inventory.repoRoot ? [resolve(inventory.repoRoot, path)] : []),
      ];

  for (const candidate of dedupe(candidates)) {
    if (!isWithinAnyAllowedRoot(candidate, inventory.allowedRoots)) {
      continue;
    }
    return { ok: true, absolutePath: candidate };
  }

  return {
    ok: false,
    reason: `path resolves outside allowed roots (${inventory.allowedRoots.join(", ")})`,
  };
}

function validateRenderedMaterialSize(
  packet: RenderedSourceMaterialPacket,
  maxChars: number,
): void {
  const total = packet.section.length;
  if (total <= maxChars) {
    return;
  }

  const largest = [...packet.resolvedRefs]
    .sort((a, b) => b.renderedCharCount - a.renderedCharCount)
    .slice(0, 5)
    .map((ref) => `${ref.displayLabel}: ${ref.renderedCharCount}`)
    .join("; ");

  throw new Error(
    `Rendered source material exceeds maximum size of ${maxChars} characters (${total} characters). Largest rendered refs: ${largest}`,
  );
}

function phase1AllowedRoots(
  planPath: string,
  planDir: string,
  repoRoot: string | undefined,
): string[] {
  const roots: string[] = [];
  if (repoRoot) {
    roots.push(realpathIfPossible(repoRoot));
  }
  if (!repoRoot || !isInsideRoot(repoRoot, planPath)) {
    roots.push(realpathIfPossible(planDir));
  }
  return dedupe(roots.map((root) => resolve(root)));
}

function isWithinAnyAllowedRoot(path: string, roots: string[]): boolean {
  const realPath = canonicalPathForRootCheck(path);
  return roots.some((root) => isInsideRoot(root, realPath));
}

function isInsideRoot(root: string, path: string): boolean {
  const rel = relative(realpathIfPossible(root), path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalPathForRootCheck(path: string): string {
  if (existsSync(path)) {
    return realpathSync(path);
  }
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return resolve(path);
  }
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function normalizePlanCheckboxes(text: string): string {
  return text.replace(/^(\s*[-*+]\s+\[)[ xX](\]\s+)/gm, "$1 $2");
}

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  }
}

function stripFragment(target: string): string {
  return target.split("#", 1)[0] ?? "";
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
