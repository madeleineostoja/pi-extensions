import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type SourceCheckboxRef = {
  path: string;
  lineNumber: number;
  lineText: string;
};

export type SourceRef = {
  path: string;
  quote?: string;
};

export type SourceCheckboxSearchHints = {
  title?: string;
  taskId?: string;
  sourceRefs?: SourceRef[];
  fallbackPath?: string;
  allowedPaths?: string[];
};

export function tryMarkSourceCheckboxDone(
  ref: SourceCheckboxRef | undefined,
  hints: SourceCheckboxSearchHints = {},
): { ok: true } | { ok: false; reason: string } {
  return tryMarkSourceCheckbox(ref, "x", hints);
}

export function tryMarkSourceCheckboxUndone(
  ref: SourceCheckboxRef | undefined,
  hints: SourceCheckboxSearchHints = {},
): { ok: true } | { ok: false; reason: string } {
  return tryMarkSourceCheckbox(ref, " ", hints);
}

export function normalizeCheckboxMarker(line: string): string {
  return line.replace(/^(\s*[-*]\s+)\[[ xX]\]/, "$1[ ]");
}

function tryMarkSourceCheckbox(
  ref: SourceCheckboxRef | undefined,
  marker: "x" | " ",
  hints: SourceCheckboxSearchHints,
): { ok: true } | { ok: false; reason: string } {
  const exact = ref
    ? pathIsAllowed(ref.path, hints.allowedPaths)
      ? tryExactSourceCheckbox(ref, marker)
      : {
          ok: false as const,
          reason: `Source checkbox path is not an allowed plan artifact: ${ref.path}`,
        }
    : undefined;
  if (exact?.ok) {
    return exact;
  }

  const fuzzy = tryFuzzySourceCheckbox(ref, marker, hints);
  if (fuzzy.ok) {
    return fuzzy;
  }

  return (
    exact ?? {
      ok: false,
      reason: fuzzy.reason,
    }
  );
}

function tryExactSourceCheckbox(
  ref: SourceCheckboxRef,
  marker: "x" | " ",
): { ok: true } | { ok: false; reason: string } {
  try {
    const content = readFileSync(ref.path, "utf-8");
    const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.split(/\r?\n/);

    const index = ref.lineNumber - 1;
    if (index < 0 || index >= lines.length) {
      return {
        ok: false,
        reason: `Stale source checkbox: line ${ref.lineNumber} in ${ref.path} is out of range.`,
      };
    }

    if (
      normalizeCheckboxMarker(lines[index]) !==
      normalizeCheckboxMarker(ref.lineText)
    ) {
      return {
        ok: false,
        reason: `Stale source checkbox: line ${ref.lineNumber} in ${ref.path} no longer matches recorded text.`,
      };
    }

    if (!isCheckboxLine(lines[index])) {
      return {
        ok: false,
        reason: `Source checkbox line in ${ref.path} does not contain a checkbox marker.`,
      };
    }

    lines[index] = lines[index].replace(/\[([ xX])\]/, `[${marker}]`);
    writeFileSync(ref.path, lines.join(lineEnding), "utf-8");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function tryFuzzySourceCheckbox(
  ref: SourceCheckboxRef | undefined,
  marker: "x" | " ",
  hints: SourceCheckboxSearchHints,
): { ok: true } | { ok: false; reason: string } {
  const candidates = candidateSearchRefs(ref, hints);
  const matches: Array<{ path: string; lineIndex: number }> = [];
  const warnings: string[] = [];

  for (const candidate of candidates) {
    try {
      const content = readFileSync(candidate.path, "utf-8");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!isCheckboxLine(lines[i])) {
          continue;
        }
        if (lineMatchesHints(lines[i], candidate.needles)) {
          matches.push({ path: candidate.path, lineIndex: i });
        }
      }
    } catch (err) {
      warnings.push(
        `${candidate.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const unique = dedupeMatches(matches);
  if (unique.length !== 1) {
    const reason =
      unique.length === 0
        ? "No unique source checkbox matched task source refs/title."
        : `Multiple source checkboxes matched task source refs/title (${unique.length}).`;
    return {
      ok: false,
      reason: warnings.length > 0 ? `${reason} ${warnings.join("; ")}` : reason,
    };
  }

  const match = unique[0];
  const content = readFileSync(match.path, "utf-8");
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  lines[match.lineIndex] = lines[match.lineIndex].replace(
    /\[([ xX])\]/,
    `[${marker}]`,
  );
  writeFileSync(match.path, lines.join(lineEnding), "utf-8");
  return { ok: true };
}

function candidateSearchRefs(
  ref: SourceCheckboxRef | undefined,
  hints: SourceCheckboxSearchHints,
): Array<{ path: string; needles: string[] }> {
  const byPath = new Map<string, Set<string>>();
  const add = (
    path: string | undefined,
    needles: Array<string | undefined>,
  ) => {
    if (!path || !pathIsAllowed(path, hints.allowedPaths)) {
      return;
    }
    const normalizedPath = normalizePath(path);
    const set = byPath.get(normalizedPath) ?? new Set<string>();
    for (const needle of needles) {
      const normalized = normalizeNeedle(needle);
      if (normalized) {
        set.add(normalized);
      }
    }
    byPath.set(normalizedPath, set);
  };

  add(ref?.path, [ref?.lineText, hints.title, hints.taskId]);
  add(hints.fallbackPath, [hints.title, hints.taskId]);
  for (const sourceRef of hints.sourceRefs ?? []) {
    add(sourceRef.path, [sourceRef.quote, hints.title, hints.taskId]);
  }

  return [...byPath.entries()].map(([path, needles]) => ({
    path,
    needles: [...needles],
  }));
}

function lineMatchesHints(line: string, needles: string[]): boolean {
  const normalizedLine = normalizeNeedle(line);
  return (
    normalizedLine !== undefined &&
    needles.some((needle) => normalizedLine.includes(needle))
  );
}

function normalizeNeedle(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/^\s*[-*]\s+\[[ xX]\]\s*/, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized && normalized.length >= 3 ? normalized : undefined;
}

function isCheckboxLine(line: string): boolean {
  return /^\s*[-*]\s+\[[ xX]\]/.test(line);
}

function pathIsAllowed(
  path: string,
  allowedPaths: string[] | undefined,
): boolean {
  if (!allowedPaths || allowedPaths.length === 0) {
    return true;
  }
  const normalized = normalizePath(path);
  return allowedPaths.some(
    (allowedPath) => normalizePath(allowedPath) === normalized,
  );
}

function normalizePath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(path);
}

function dedupeMatches(
  matches: Array<{ path: string; lineIndex: number }>,
): Array<{ path: string; lineIndex: number }> {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.path}:${match.lineIndex}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
