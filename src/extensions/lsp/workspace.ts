import { realpathSync, existsSync, statSync, readFileSync } from "node:fs";
import {
  dirname,
  extname,
  join,
  parse,
  resolve,
  relative,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export type ServerKind = "typescript" | "svelte" | "ruby";
const extensions: Record<ServerKind, Set<string>> = {
  typescript: new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
  ]),
  svelte: new Set([".svelte"]),
  ruby: new Set([".rb", ".rake"]),
};

export function canonicalPath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function isWithin(root: string, target: string): boolean {
  const diff = relative(canonicalPath(root), canonicalPath(target));
  return (
    diff === "" ||
    (!diff.startsWith(`..${sep}`) &&
      diff !== ".." &&
      !diff.includes(`${sep}..${sep}`) &&
      !parse(diff).root)
  );
}

export function assertWorkspaceFile(workspace: string, file: string): string {
  const resolved = canonicalPath(file);
  if (!isWithin(workspace, resolved)) {
    throw new Error(`LSP target is outside workspace: ${file}`);
  }
  return resolved;
}

export function workspaceFileFromUri(
  workspace: string,
  uri: string,
): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") {
      return undefined;
    }
    return assertWorkspaceFile(workspace, fileURLToPath(parsed));
  } catch {
    return undefined;
  }
}

export function serverForFile(file: string): ServerKind | undefined {
  const extension = extname(file).toLowerCase();
  return (Object.keys(extensions) as ServerKind[]).find((kind) =>
    extensions[kind].has(extension),
  );
}

export function nearestWorkspaceRoot(
  kind: ServerKind,
  file: string,
  workspace: string,
): string {
  const target = assertWorkspaceFile(workspace, file);
  const boundary = canonicalPath(workspace);
  let current = statSync(target).isDirectory() ? target : dirname(target);
  let fallback: string | undefined;
  while (isWithin(boundary, current)) {
    if (existsSync(join(current, ".git"))) {
      fallback ??= current;
    }
    if (matchesRoot(kind, current)) {
      return current;
    }
    if (current === boundary) {
      break;
    }
    current = dirname(current);
  }
  return fallback ?? boundary;
}

function matchesRoot(kind: ServerKind, dir: string): boolean {
  if (kind === "typescript") {
    return (
      existsSync(join(dir, "tsconfig.json")) ||
      existsSync(join(dir, "jsconfig.json")) ||
      relevantPackage(dir, "typescript")
    );
  }
  if (kind === "svelte") {
    return (
      [
        "svelte.config.js",
        "svelte.config.mjs",
        "svelte.config.cjs",
        "svelte.config.ts",
      ].some((name) => existsSync(join(dir, name))) ||
      relevantPackage(dir, "svelte")
    );
  }
  return (
    existsSync(join(dir, "Gemfile")) ||
    existsSync(join(dir, ".ruby-version")) ||
    existsSync(join(dir, ".ruby-gemset"))
  );
}

function relevantPackage(dir: string, dependency: string): boolean {
  const file = join(dir, "package.json");
  if (!existsSync(file)) {
    return false;
  }
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    return ["dependencies", "devDependencies", "peerDependencies"].some(
      (key) => dependency in (pkg[key] ?? {}),
    );
  } catch {
    return false;
  }
}
