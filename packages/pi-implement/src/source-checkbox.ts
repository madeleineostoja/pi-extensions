import { readFileSync, writeFileSync } from "node:fs";

export type SourceCheckboxRef = {
  path: string;
  lineNumber: number;
  lineText: string;
};

export function tryMarkSourceCheckboxDone(
  ref: SourceCheckboxRef,
): { ok: true } | { ok: false; reason: string } {
  return tryMarkSourceCheckbox(ref, "x");
}

export function tryMarkSourceCheckboxUndone(
  ref: SourceCheckboxRef,
): { ok: true } | { ok: false; reason: string } {
  return tryMarkSourceCheckbox(ref, " ");
}

export function normalizeCheckboxMarker(line: string): string {
  return line.replace(/^(\s*[-*]\s+)\[[ xX]\]/, "$1[ ]");
}

function tryMarkSourceCheckbox(
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

    const targetLine = lines[index];
    if (!/^\s*[-*]\s+\[[ xX]\]/.test(targetLine)) {
      return {
        ok: false,
        reason: `Source checkbox line in ${ref.path} does not contain a checkbox marker.`,
      };
    }

    lines[index] = targetLine.replace(/\[([ xX])\]/, `[${marker}]`);
    writeFileSync(ref.path, lines.join(lineEnding), "utf-8");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
