import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  normalizeCheckboxMarker,
  type SourceCheckboxRef,
} from "./source-checkbox.js";

export type CheckboxProjectionIntent = {
  id: string;
  canonicalPath: string;
  expectedOldContent: string;
  expectedOldHash: string;
  expectedNewContent: string;
  expectedNewHash: string;
  taskIds: string[];
};

export type ProjectionOutcome =
  | { kind: "written"; protectedHash: string }
  | { kind: "already_written"; protectedHash: string }
  | { kind: "safety_paused"; reason: string };

export function createCheckboxProjectionIntent(args: {
  id: string;
  checkoutRoot: string;
  taskIds: string[];
  checkboxes: SourceCheckboxRef[];
}): CheckboxProjectionIntent {
  if (
    args.taskIds.length === 0 ||
    args.taskIds.length !== args.checkboxes.length
  ) {
    throw new Error("Projection must bind each affected task to one checkbox.");
  }
  const canonicalPath = canonicalSourcePath(
    args.checkoutRoot,
    args.checkboxes[0]!.path,
  );
  if (
    args.checkboxes.some(
      (checkbox) =>
        canonicalSourcePath(args.checkoutRoot, checkbox.path) !== canonicalPath,
    )
  ) {
    throw new Error("A projection intent can modify only one source artifact.");
  }
  const oldContent = readFileSync(canonicalPath, "utf-8");
  const newContent = applyCheckboxes(oldContent, args.checkboxes);
  return {
    id: args.id,
    canonicalPath,
    expectedOldContent: oldContent,
    expectedOldHash: hash(oldContent),
    expectedNewContent: newContent,
    expectedNewHash: hash(newContent),
    taskIds: [...args.taskIds],
  };
}

export function resumeCheckboxProjection(
  checkoutRoot: string,
  intent: CheckboxProjectionIntent,
): ProjectionOutcome {
  let path: string;
  let current: string;
  try {
    path = canonicalSourcePath(checkoutRoot, intent.canonicalPath);
    if (path !== intent.canonicalPath) {
      return {
        kind: "safety_paused",
        reason: "Projection source path no longer has its canonical identity.",
      };
    }
    current = readFileSync(path, "utf-8");
  } catch (error) {
    return { kind: "safety_paused", reason: message(error) };
  }
  const currentHash = hash(current);
  if (
    currentHash === intent.expectedNewHash &&
    current === intent.expectedNewContent
  ) {
    return { kind: "already_written", protectedHash: currentHash };
  }
  if (
    currentHash !== intent.expectedOldHash ||
    current !== intent.expectedOldContent
  ) {
    return {
      kind: "safety_paused",
      reason: "Projection source content matches neither durable intent side.",
    };
  }
  try {
    atomicReplace(path, intent.expectedNewContent);
    const written = readFileSync(path, "utf-8");
    if (written !== intent.expectedNewContent) {
      throw new Error("Atomic projection write could not be verified.");
    }
    return { kind: "written", protectedHash: hash(written) };
  } catch (error) {
    return { kind: "safety_paused", reason: message(error) };
  }
}

function applyCheckboxes(
  content: string,
  checkboxes: SourceCheckboxRef[],
): string {
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  const seen = new Set<number>();
  for (const checkbox of checkboxes) {
    const index = checkbox.lineNumber - 1;
    if (seen.has(index) || index < 0 || index >= lines.length) {
      throw new Error(
        "Projection checkbox anchor is duplicated or out of range.",
      );
    }
    seen.add(index);
    const line = lines[index]!;
    if (
      normalizeCheckboxMarker(line.replace(/\r?\n$/, "")) !==
        normalizeCheckboxMarker(checkbox.lineText) ||
      !/^[-*]\s+\[[ xX]\]/.test(line)
    ) {
      throw new Error(
        "Projection checkbox anchor no longer matches its top-level source line.",
      );
    }
    lines[index] = line.replace(/\[([ xX])\]/, "[x]");
  }
  return lines.join("");
}

function canonicalSourcePath(checkoutRoot: string, path: string): string {
  const root = resolve(checkoutRoot);
  const destination = resolve(path);
  const inside = relative(root, destination);
  if (!inside || inside.startsWith("..")) {
    throw new Error("Projection source is outside the invoking checkout.");
  }
  let current = root;
  for (const component of inside.split("/")) {
    current = resolve(current, component);
    if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
      throw new Error("Projection source path is missing or symlinked.");
    }
  }
  return destination;
}

function atomicReplace(path: string, content: string): void {
  const temporary = `${path}.tmp.${randomBytes(12).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
