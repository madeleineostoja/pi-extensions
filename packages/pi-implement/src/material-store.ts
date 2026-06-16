import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { ParsedPlan } from "./plan.js";

export const MAX_CORPUS_FILES = 50;
export const MAX_CORPUS_CHARS = 200_000;
export const MAX_PLAN_MATERIAL_CHARS = 100_000;

export type MaterialOrigin =
  | "entry-plan"
  | "plan-link"
  | "task-link"
  | "corpus-link"
  | "sibling-task";

export type MaterialTaskOrigin = {
  taskIndex: number;
  origin: MaterialOrigin;
};

export type MaterialFile = {
  absolutePath: string;
  displayPath: string;
  content: string;
  hash: string;
  lineCount: number;
  origins: MaterialOrigin[];
  taskOrigins: MaterialTaskOrigin[];
};

export type MaterialStore = {
  entryPath: string;
  planDir: string;
  repoRoot?: string;
  allowedRoots: string[];
  files: MaterialFile[];
  storeHash: string;
  validationErrors: string[];
};

export type BuildMaterialStoreArgs = {
  plan: ParsedPlan;
  planPath: string;
  repoRoot?: string;
};

const PLAN_REF_LINE_RE =
  /^[ \t]*(?:[-*][ \t]+)?Plan:\s*(?:`([^`]+)`|<([^>]+)>)\s*$/;
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]\n]*)\]\(([^)\n]+)\)/g;

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

export function buildMaterialStoreFromContent(
  planPath: string,
  content: string,
): MaterialStore {
  const planPathResolved = resolve(planPath);
  const planDir = dirname(planPathResolved);
  const allowedRoots = materialAllowedRoots(
    planPathResolved,
    planDir,
    undefined,
  );

  const filesByPath = new Map<string, MaterialFileBuilder>();
  const validationErrors: string[] = [];

  const addFile = (
    absolutePath: string,
    fileContent: string,
    origin: MaterialOrigin,
  ) => {
    const existing = filesByPath.get(absolutePath);
    if (existing) {
      if (!existing.origins.includes(origin)) {
        existing.origins.push(origin);
      }
      return;
    }
    filesByPath.set(absolutePath, {
      absolutePath,
      content: fileContent,
      origins: [origin],
      taskOrigins: [],
    });
  };

  addFile(planPathResolved, content, "entry-plan");

  for (const target of discoverInlineMarkdownLinks(content.split("\n"))) {
    const validation = validateCorpusTarget(
      planDir,
      target,
      allowedRoots,
      undefined,
    );
    if (typeof validation === "string") {
      validationErrors.push(validation);
      continue;
    }
    if (filesByPath.has(validation.absolutePath)) {
      continue;
    }
    addFile(validation.absolutePath, validation.content, "corpus-link");

    if (isInTasksDirectory(validation.absolutePath)) {
      const siblingPaths = discoverSiblingTasks(
        dirname(validation.absolutePath),
      );
      for (const siblingPath of siblingPaths) {
        if (filesByPath.has(siblingPath)) {
          continue;
        }
        try {
          const siblingContent = readFileSync(siblingPath, "utf-8");
          if (!siblingContent.trim()) {
            validationErrors.push(
              `empty or whitespace-only corpus file: ${siblingPath}`,
            );
            continue;
          }
          addFile(siblingPath, siblingContent, "sibling-task");
        } catch {
          validationErrors.push(
            `missing or unreadable corpus file: ${siblingPath}`,
          );
        }
      }
    }
  }

  const files = finalizeMaterialFiles(filesByPath, planDir);
  const storeHash = computeStoreHash(planPathResolved, files);

  return {
    entryPath: planPathResolved,
    planDir,
    allowedRoots,
    files,
    storeHash,
    validationErrors,
  };
}

export function buildMaterialStore(
  args: BuildMaterialStoreArgs,
): MaterialStore {
  const planPath = resolve(args.planPath);
  const planDir = dirname(planPath);
  const repoRoot = args.repoRoot ? resolve(args.repoRoot) : undefined;
  const allowedRoots = materialAllowedRoots(planPath, planDir, repoRoot);

  const filesByPath = new Map<string, MaterialFileBuilder>();
  const validationErrors: string[] = [];

  const addError = (message: string) => {
    validationErrors.push(message);
  };

  const addFile = (
    absolutePath: string,
    content: string,
    origin: MaterialOrigin,
    taskIndex?: number,
  ) => {
    const existing = filesByPath.get(absolutePath);
    if (existing) {
      if (!existing.origins.includes(origin)) {
        existing.origins.push(origin);
      }
      if (taskIndex !== undefined) {
        const hasTaskOrigin = existing.taskOrigins.some(
          (to) => to.taskIndex === taskIndex && to.origin === origin,
        );
        if (!hasTaskOrigin) {
          existing.taskOrigins.push({ taskIndex, origin });
        }
      }
      return;
    }
    filesByPath.set(absolutePath, {
      absolutePath,
      content,
      origins: [origin],
      taskOrigins: taskIndex !== undefined ? [{ taskIndex, origin }] : [],
    });
  };

  // Entry plan is always included.
  addFile(planPath, args.plan.content, "entry-plan");

  // Task-block material: Plan: links and inline markdown links.
  for (const task of args.plan.tasks) {
    const referencedPaths = new Set<string>();

    for (const line of task.blockLines) {
      const ref = extractPlanReference(line);
      if (ref) {
        const validation = validateMaterialTarget(
          planDir,
          ref.target,
          allowedRoots,
          repoRoot,
        );
        if (typeof validation === "string") {
          addError(`Task ${task.index}: ${validation}`);
          continue;
        }
        if (referencedPaths.has(validation.absolutePath)) {
          continue;
        }
        referencedPaths.add(validation.absolutePath);
        addFile(
          validation.absolutePath,
          validation.content,
          "plan-link",
          task.index,
        );
        continue;
      }

      if (looksLikeAttemptedPlanReference(line)) {
        addError(
          `Task ${task.index}: unsupported or malformed Plan: line: ${line.trim()}`,
        );
        continue;
      }
    }

    for (const target of discoverInlineMarkdownLinks(task.blockLines)) {
      const validation = validateMaterialTarget(
        planDir,
        target,
        allowedRoots,
        repoRoot,
      );
      if (typeof validation === "string") {
        addError(`Task ${task.index}: ${validation}`);
        continue;
      }
      if (referencedPaths.has(validation.absolutePath)) {
        continue;
      }
      referencedPaths.add(validation.absolutePath);
      addFile(
        validation.absolutePath,
        validation.content,
        "task-link",
        task.index,
      );
    }
  }

  // Entry-plan corpus links and sibling-task discovery.
  const corpusReferencedPaths = new Set<string>();
  for (const target of discoverInlineMarkdownLinks(
    args.plan.content.split("\n"),
  )) {
    const validation = validateCorpusTarget(
      planDir,
      target,
      allowedRoots,
      repoRoot,
    );
    if (typeof validation === "string") {
      addError(validation);
      continue;
    }
    if (corpusReferencedPaths.has(validation.absolutePath)) {
      continue;
    }
    corpusReferencedPaths.add(validation.absolutePath);
    addFile(validation.absolutePath, validation.content, "corpus-link");

    if (isInTasksDirectory(validation.absolutePath)) {
      const siblingPaths = discoverSiblingTasks(
        dirname(validation.absolutePath),
      );
      for (const siblingPath of siblingPaths) {
        if (filesByPath.has(siblingPath)) {
          continue;
        }
        try {
          const siblingContent = readFileSync(siblingPath, "utf-8");
          if (!siblingContent.trim()) {
            addError(`empty or whitespace-only corpus file: ${siblingPath}`);
            continue;
          }
          addFile(siblingPath, siblingContent, "sibling-task");
        } catch {
          addError(`missing or unreadable corpus file: ${siblingPath}`);
        }
      }
    }
  }

  const files = finalizeMaterialFiles(filesByPath, planDir);
  const storeHash = computeStoreHash(planPath, files);

  return {
    entryPath: planPath,
    planDir,
    repoRoot,
    allowedRoots,
    files,
    storeHash,
    validationErrors,
  };
}

export function resolveMaterialRefPath(
  refPath: string,
  store: MaterialStore,
): { ok: true; absolutePath: string } | { ok: false; reason: string } {
  if (looksLikeUrl(refPath)) {
    return { ok: false, reason: "URLs are not allowed for packet material" };
  }

  const path = stripFragment(refPath).trim();
  if (!path) {
    return { ok: false, reason: "path is empty" };
  }

  const candidates = isAbsolute(path)
    ? [resolve(path)]
    : [
        resolve(store.planDir, path),
        ...(store.repoRoot ? [resolve(store.repoRoot, path)] : []),
      ];

  for (const candidate of dedupe(candidates)) {
    if (!isWithinAnyAllowedRoot(candidate, store.allowedRoots)) {
      continue;
    }
    return { ok: true, absolutePath: candidate };
  }

  return {
    ok: false,
    reason: `path resolves outside allowed roots (${store.allowedRoots.join(", ")})`,
  };
}

export function validateMaterialStoreCurrent(store: MaterialStore): void {
  for (const file of store.files) {
    validateMaterialFileCurrent(file, store);
  }
}

export function findMaterialFile(
  store: MaterialStore,
  absolutePath: string,
): MaterialFile | undefined {
  return store.files.find(
    (file) => file.absolutePath === resolve(absolutePath),
  );
}

export function formatStoreBundleMaterial(
  store: MaterialStore,
  maxChars = MAX_PLAN_MATERIAL_CHARS,
): string {
  const materials = store.files.filter((file) =>
    file.origins.some((o) => o === "plan-link" || o === "task-link"),
  );

  if (materials.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const file of materials) {
    parts.push(`### ${file.displayPath}\n\n${file.content}`);
  }

  const result = parts.join("\n\n");
  checkPlanMaterialSize(result, maxChars);
  return result;
}

export function formatStoreCorpusMaterial(store: MaterialStore): string {
  if (store.files.length <= 1) {
    return "";
  }
  const parts: string[] = [];
  for (const file of store.files) {
    if (file.absolutePath === store.entryPath) {
      continue;
    }
    parts.push(`### ${file.displayPath}\n\n${file.content}`);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join("\n\n");
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

export function countMaterialChars(store: MaterialStore): number {
  return store.files.reduce((sum, file) => sum + file.content.length, 0);
}

function computeStoreHash(entryPath: string, files: MaterialFile[]): string {
  const hash = createHash("sha256");
  const entry = files.find((file) => file.absolutePath === entryPath);
  hash.update(entry?.hash ?? "");
  for (const file of files) {
    hash.update(file.hash);
  }
  return hash.digest("hex");
}

type MaterialFileBuilder = {
  absolutePath: string;
  content: string;
  origins: MaterialOrigin[];
  taskOrigins: MaterialTaskOrigin[];
};

function finalizeMaterialFiles(
  filesByPath: Map<string, MaterialFileBuilder>,
  planDir: string,
): MaterialFile[] {
  const builders = Array.from(filesByPath.values());

  const basenameCounts = new Map<string, number>();
  for (const builder of builders) {
    const name = basename(builder.absolutePath);
    basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
  }

  const files: MaterialFile[] = builders.map((builder) => {
    const name = basename(builder.absolutePath);
    const displayPath =
      basenameCounts.get(name)! > 1
        ? relative(planDir, builder.absolutePath)
        : name;
    return {
      absolutePath: builder.absolutePath,
      displayPath,
      content: builder.content,
      hash: hashContent(builder.content),
      lineCount: builder.content.split(/\r?\n/).length,
      origins: builder.origins,
      taskOrigins: builder.taskOrigins,
    };
  });

  return files;
}

function validateMaterialTarget(
  sourceDir: string,
  target: string,
  allowedRoots: string[],
  repoRoot?: string,
): { absolutePath: string; content: string } | string {
  if (looksLikeUrl(target)) {
    return `URL Plan: targets are not supported: ${target}`;
  }

  const targetPath = stripFragment(target).trim();
  if (!targetPath) {
    return `missing or unreadable Plan: target: ${target}`;
  }

  const resolution = resolveLocalMaterialTarget(
    targetPath,
    sourceDir,
    repoRoot,
    allowedRoots,
  );
  if (!resolution.ok) {
    switch (resolution.reason) {
      case "outside-root":
        return `Plan: target escapes allowed root: ${target}`;
      case "url":
        return `URL Plan: targets are not supported: ${target}`;
      default:
        return `missing or unreadable Plan: target: ${target}`;
    }
  }

  const absolutePath = resolution.absolutePath;

  try {
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      return `Plan: target is a directory: ${target}`;
    }
  } catch {
    return `missing or unreadable Plan: target: ${target}`;
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

function validateCorpusTarget(
  sourceDir: string,
  target: string,
  allowedRoots: string[],
  repoRoot?: string,
): { absolutePath: string; content: string } | string {
  if (looksLikeUrl(target)) {
    return `URL corpus link target: ${target}`;
  }

  const targetPath = stripFragment(target).trim();
  if (!targetPath) {
    return `missing or unreadable corpus link target: ${target}`;
  }

  if (!targetPath.toLowerCase().endsWith(".md")) {
    return `non-markdown corpus link target: ${target}`;
  }

  const resolution = resolveLocalMaterialTarget(
    targetPath,
    sourceDir,
    repoRoot,
    allowedRoots,
  );
  if (!resolution.ok) {
    switch (resolution.reason) {
      case "outside-root":
        return `corpus link target escapes allowed root: ${target}`;
      case "url":
        return `URL corpus link target: ${target}`;
      default:
        return `missing or unreadable corpus link target: ${target}`;
    }
  }

  const absolutePath = resolution.absolutePath;

  try {
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      return `corpus link target is a directory: ${target}`;
    }
  } catch {
    return `missing or unreadable corpus link target: ${target}`;
  }

  let content: string;
  try {
    content = readFileSync(absolutePath, "utf-8");
  } catch {
    return `missing or unreadable corpus link target: ${target}`;
  }

  if (!content.trim()) {
    return `empty or whitespace-only corpus link target: ${target}`;
  }

  return { absolutePath, content };
}

type LocalMaterialResolution =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: "url" | "empty" | "outside-root" | "missing" };

function resolveLocalMaterialTarget(
  targetPath: string,
  sourceDir: string,
  repoRoot: string | undefined,
  allowedRoots: string[],
): LocalMaterialResolution {
  if (looksLikeUrl(targetPath)) {
    return { ok: false, reason: "url" };
  }

  const cleanPath = stripFragment(targetPath).trim();
  if (!cleanPath) {
    return { ok: false, reason: "empty" };
  }

  const candidates = isAbsolute(cleanPath)
    ? [resolve(cleanPath)]
    : [
        resolve(sourceDir, cleanPath),
        ...(repoRoot && repoRoot !== sourceDir
          ? [resolve(repoRoot, cleanPath)]
          : []),
      ];

  const seen = new Set<string>();
  let foundOutsideRoot = false;

  for (const candidate of candidates) {
    const key = resolve(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (!existsSync(key)) {
      continue;
    }

    if (!isWithinAnyAllowedRoot(key, allowedRoots)) {
      foundOutsideRoot = true;
      continue;
    }

    return { ok: true, absolutePath: key };
  }

  const anyInsideRoot = candidates.some((candidate) =>
    isWithinAnyAllowedRoot(candidate, allowedRoots),
  );

  if (!anyInsideRoot || foundOutsideRoot) {
    return { ok: false, reason: "outside-root" };
  }

  return { ok: false, reason: "missing" };
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
    while ((match = MARKDOWN_LINK_RE.exec(searchable)) !== null) {
      const label = match[1] ?? "";
      const target = (match[2] ?? "").trim();
      if (!target || looksLikeScheme(target) || target.startsWith("#")) {
        continue;
      }
      const targetPath = stripFragment(target).trim();
      if (!targetPath || !targetPath.toLowerCase().endsWith(".md")) {
        continue;
      }
      if (isPlaceholderMarkdownExample(label, target)) {
        continue;
      }
      targets.push(target);
    }
  }

  return targets;
}

function isPlaceholderMarkdownExample(label: string, target: string): boolean {
  const targetPath = stripFragment(target).trim().toLowerCase();
  const targetName = basename(targetPath);
  return (
    /^example(?:[-_][\w-]+)?$/i.test(label.trim()) &&
    /^(?:placeholder|example)(?:[-_][\w-]+)?\.md$/i.test(targetName)
  );
}

function isInTasksDirectory(absolutePath: string): boolean {
  return basename(dirname(absolutePath)) === "tasks";
}

function discoverSiblingTasks(taskDir: string): string[] {
  try {
    return readdirSync(taskDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
      .map((d) => join(taskDir, d.name));
  } catch {
    return [];
  }
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

function materialAllowedRoots(
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

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
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
      ? hashContent(normalizePlanCheckboxes(current))
      : hashContent(current);
  const frozenHash =
    resolve(file.absolutePath) === store.entryPath
      ? hashContent(normalizePlanCheckboxes(file.content))
      : file.hash;
  if (currentHash !== frozenHash) {
    throw new Error(
      `Phase 1 material changed after inventory creation: ${file.absolutePath} hash ${currentHash} does not match frozen hash ${frozenHash}`,
    );
  }
}

function normalizePlanCheckboxes(text: string): string {
  return text.replace(/^(\s*[-*+]\s+\[)[ xX](\]\s+)/gm, "$1 $2");
}
