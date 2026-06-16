import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlanCorpus } from "./corpus.js";
import {
  renderSourceMaterialPacket,
  type RenderedSourceMaterialPacket,
  type SourceMaterialRef,
} from "./execution-plan.js";
import type { PlanBundleManifest } from "./manifest.js";
import type { ParsedPlan } from "./plan.js";
import {
  buildMaterialStore,
  findMaterialFile,
  resolveMaterialRefPath,
  validateMaterialStoreCurrent,
  type MaterialFile,
  type MaterialStore,
} from "./material-store.js";

const hashText = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

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
  store?: MaterialStore;
};

export type RenderPhase1TaskMaterialArgs = {
  inventory: Phase1MaterialInventory;
  refs: SourceMaterialRef[] | undefined;
  maxChars?: number;
};

export function buildPhase1MaterialInventory(
  args: BuildPhase1MaterialInventoryArgs,
): Phase1MaterialInventory {
  const store =
    args.store ??
    buildMaterialStore({
      plan: args.plan,
      planPath: args.planPath,
      repoRoot: args.repoRoot,
    });

  return {
    planPath: store.entryPath,
    planDir: store.planDir,
    repoRoot: store.repoRoot,
    allowedRoots: store.allowedRoots,
    materials: store.files.map((file) => ({
      absolutePath: file.absolutePath,
      displayLabel:
        file.absolutePath === store.entryPath
          ? "Selected Task Source Anchor"
          : file.displayPath,
      content: file.content,
      hash: file.hash,
    })),
  };
}

export function buildMaterialStoreFromInventory(
  inventory: Phase1MaterialInventory,
): MaterialStore {
  return {
    entryPath: inventory.planPath,
    planDir: inventory.planDir,
    repoRoot: inventory.repoRoot,
    allowedRoots: inventory.allowedRoots,
    files: inventory.materials.map((material) => ({
      absolutePath: material.absolutePath,
      displayPath: material.displayLabel,
      content: material.content,
      hash: material.hash,
      lineCount: material.content.split(/\r?\n/).length,
      origins:
        material.absolutePath === inventory.planPath
          ? ["entry-plan" as const]
          : ["task-link" as const],
      taskOrigins: [],
    })),
    storeHash: "",
    validationErrors: [],
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

  const store = buildMaterialStoreFromInventory(args.inventory);
  validateFrozenRefs(store, inventoryByPath, refs);

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
  validateMaterialStoreCurrent(buildMaterialStoreFromInventory(inventory));
}

function deterministicPhase1Refs(
  refs: SourceMaterialRef[] | undefined,
): SourceMaterialRef[] {
  return (refs ?? []).filter(
    (ref) => ref.origin === "task-anchor" || ref.origin === "task-link",
  );
}

function validateFrozenRefs(
  store: MaterialStore,
  inventoryByPath: Map<string, Phase1FrozenMaterial>,
  refs: SourceMaterialRef[],
): void {
  for (const ref of refs) {
    const resolution = resolveMaterialRefPath(ref.path, store);
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

    const file = findMaterialFile(store, resolution.absolutePath);
    if (!file) {
      throw new Error(
        `Invalid deterministic source material ref (${ref.origin} ${ref.path}): path is not in the frozen Phase 1 material inventory`,
      );
    }
    validateMaterialFileCurrent(file, store);
  }
}

export function resolvePhase1MaterialRefPath(
  ref: SourceMaterialRef,
  inventory: Phase1MaterialInventory,
): { ok: true; absolutePath: string } | { ok: false; reason: string } {
  const store = buildMaterialStoreFromInventory(inventory);
  return resolveMaterialRefPath(ref.path, store);
}

function validateMaterialFileCurrent(
  file: MaterialFile,
  store: MaterialStore,
): void {
  if (!existsSync(file.absolutePath)) {
    throw new Error(
      `Phase 1 material changed after inventory creation: missing ${file.absolutePath}`,
    );
  }
  const current = readFileSync(file.absolutePath, "utf-8");
  const currentHash =
    resolve(file.absolutePath) === store.entryPath
      ? hashText(normalizePlanCheckboxes(current))
      : hashText(current);
  const frozenHash =
    resolve(file.absolutePath) === store.entryPath
      ? hashText(normalizePlanCheckboxes(file.content))
      : file.hash;
  if (currentHash !== frozenHash) {
    throw new Error(
      `Phase 1 material changed after inventory creation: ${file.absolutePath} hash ${currentHash} does not match frozen hash ${frozenHash}`,
    );
  }
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

function normalizePlanCheckboxes(text: string): string {
  return text.replace(/^(\s*[-*+]\s+\[)[ xX](\]\s+)/gm, "$1 $2");
}
