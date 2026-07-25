import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ParsedPlan } from "./plan.js";

export const MAX_CORPUS_FILES = 50;
export const MAX_CORPUS_CHARS = 200_000;

export type MaterialFile = {
  absolutePath: string;
  displayPath: string;
  content: string;
  hash: string;
  lineCount: number;
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

const MARKDOWN_LINK_RE = /(?<!!)\[[^\]\n]*\]\(([^)\n]+)\)/g;

export function buildMaterialStore(
  args: BuildMaterialStoreArgs,
): MaterialStore {
  const entryPath = resolve(args.planPath);
  const planDir = dirname(entryPath);
  const repoRoot = args.repoRoot ? resolve(args.repoRoot) : undefined;
  const allowedRoots = materialAllowedRoots(entryPath, planDir, repoRoot);
  const files = new Map<string, string>([[entryPath, args.plan.content]]);
  const validationErrors: string[] = [];
  const visited = new Set<string>();

  const visit = (path: string, content: string) => {
    if (visited.has(path)) {
      return;
    }
    visited.add(path);
    for (const target of discoverInlineMarkdownLinks(content.split("\n"))) {
      const resolved = validateCorpusTarget(
        dirname(path),
        target,
        allowedRoots,
        repoRoot,
      );
      if (typeof resolved === "string") {
        validationErrors.push(resolved);
        continue;
      }
      if (!files.has(resolved.absolutePath)) {
        files.set(resolved.absolutePath, resolved.content);
      }
      visit(resolved.absolutePath, resolved.content);
    }
  };

  visit(entryPath, args.plan.content);
  const finalized = finalizeFiles(files, planDir);
  return {
    entryPath,
    planDir,
    ...(repoRoot ? { repoRoot } : {}),
    allowedRoots,
    files: finalized,
    storeHash: computeStoreHash(entryPath, finalized),
    validationErrors,
  };
}

export function countMaterialChars(store: MaterialStore): number {
  return store.files.reduce((sum, file) => sum + file.content.length, 0);
}

function finalizeFiles(
  files: Map<string, string>,
  planDir: string,
): MaterialFile[] {
  const basenameCounts = new Map<string, number>();
  for (const path of files.keys()) {
    const name = basename(path);
    basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
  }
  return [...files.entries()].map(([absolutePath, content]) => ({
    absolutePath,
    displayPath:
      basenameCounts.get(basename(absolutePath))! > 1
        ? relative(planDir, absolutePath)
        : basename(absolutePath),
    content,
    hash: hashContent(content),
    lineCount: content.split(/\r?\n/).length,
  }));
}

function computeStoreHash(entryPath: string, files: MaterialFile[]): string {
  const hash = createHash("sha256");
  hash.update(entryPath);
  for (const file of files) {
    hash.update(file.absolutePath);
    hash.update(file.hash);
  }
  return hash.digest("hex");
}

function validateCorpusTarget(
  sourceDir: string,
  target: string,
  allowedRoots: string[],
  repoRoot?: string,
): { absolutePath: string; content: string } | string {
  const targetPath = stripFragment(target).trim();
  if (!targetPath || looksLikeUrl(targetPath)) {
    return `missing or unreadable corpus link target: ${target}`;
  }
  if (!targetPath.toLowerCase().endsWith(".md")) {
    return `non-markdown corpus link target: ${target}`;
  }
  const candidates = isAbsolute(targetPath)
    ? [resolve(targetPath)]
    : [
        resolve(sourceDir, targetPath),
        ...(repoRoot && repoRoot !== sourceDir
          ? [resolve(repoRoot, targetPath)]
          : []),
      ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) {
    return `missing or unreadable corpus link target: ${target}`;
  }
  if (!isWithinAnyAllowedRoot(candidate, allowedRoots)) {
    return `corpus link target escapes allowed root: ${target}`;
  }
  try {
    if (statSync(candidate).isDirectory()) {
      return `corpus link target is a directory: ${target}`;
    }
    const content = readFileSync(candidate, "utf-8");
    return content.trim()
      ? { absolutePath: resolve(candidate), content }
      : `empty or whitespace-only corpus file: ${target}`;
  } catch {
    return `missing or unreadable corpus link target: ${target}`;
  }
}

function discoverInlineMarkdownLinks(lines: string[]): string[] {
  const targets: string[] = [];
  let fenced: { marker: "`" | "~"; length: number } | undefined;
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const markerText = fence[1] ?? "";
      const marker = markerText[0] as "`" | "~";
      if (fenced?.marker === marker && markerText.length >= fenced.length) {
        fenced = undefined;
      } else if (!fenced) {
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
      const target = (match[1] ?? "").trim();
      if (
        target &&
        !target.startsWith("#") &&
        !looksLikeScheme(target) &&
        stripFragment(target).toLowerCase().endsWith(".md")
      ) {
        targets.push(target);
      }
    }
  }
  return targets;
}

function materialAllowedRoots(
  planPath: string,
  planDir: string,
  repoRoot: string | undefined,
): string[] {
  const roots = repoRoot ? [realpathIfPossible(repoRoot)] : [];
  if (!repoRoot || !isInsideRoot(repoRoot, planPath)) {
    roots.push(realpathIfPossible(planDir));
  }
  return [...new Set(roots.map((root) => resolve(root)))];
}

function isWithinAnyAllowedRoot(path: string, roots: string[]): boolean {
  const canonical = canonicalPathForRootCheck(path);
  return roots.some((root) => isInsideRoot(root, canonical));
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
    return resolve(realpathSync(dirname(path)), basename(path));
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

function stripInlineCodeSpans(line: string): string {
  return line.replace(/`[^`]*`/g, "");
}

function stripFragment(target: string): string {
  return target.split("#", 1)[0] ?? "";
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function looksLikeScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
