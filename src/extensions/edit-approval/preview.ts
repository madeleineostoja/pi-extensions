import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";

export const DETAIL_LIMIT = 16_384;
const TRUNCATION = "\n… detail truncated at 16,384 characters";

type Edit = { oldText: string; newText: string };
type Projection = { before: string; after: string } | { reason: string };

function capped(detail: string): string {
  return detail.length <= DETAIL_LIMIT
    ? detail
    : detail.slice(0, DETAIL_LIMIT - TRUNCATION.length) + TRUNCATION;
}

function inputText(input: unknown): string {
  try {
    return capped(JSON.stringify(input, null, 2) ?? String(input));
  } catch {
    return capped(String(input));
  }
}

function pathFor(input: unknown, cwd: string): string | undefined {
  if (input && typeof input === "object") {
    const path = (input as { path?: unknown }).path;
    if (typeof path === "string" && path) {
      return resolve(cwd, path);
    }
  }
  return undefined;
}

function replacementBlocks(edits: Edit[]): string {
  return edits
    .map(
      ({ oldText, newText }, index) =>
        `replacement ${index + 1}:\n--- expected\n${oldText}\n+++ proposed\n${newText}`,
    )
    .join("\n\n");
}

function normalizeForPi(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function occurrences(content: string, value: string): number {
  return content.split(value).length - 1;
}

function projectEdits(before: string, edits: Edit[]): Projection {
  const ranges: Array<{ start: number; end: number; edit: Edit }> = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    if (!edit.oldText) {
      return { reason: "an empty replacement cannot be projected exactly" };
    }
    if (seen.has(edit.oldText)) {
      return { reason: "duplicate replacements cannot be projected exactly" };
    }
    seen.add(edit.oldText);
    const start = before.indexOf(edit.oldText);
    if (
      occurrences(normalizeForPi(before), normalizeForPi(edit.oldText)) !== 1 ||
      start === -1 ||
      start !== before.lastIndexOf(edit.oldText)
    ) {
      return { reason: "matching may be fuzzy, missing, or ambiguous" };
    }
    ranges.push({ start, end: start + edit.oldText.length, edit });
  }
  ranges.sort((left, right) => left.start - right.start);
  if (
    ranges.some(
      (range, index) => index > 0 && range.start < ranges[index - 1]!.end,
    )
  ) {
    return { reason: "overlapping replacements cannot be projected exactly" };
  }
  let after = before;
  for (const range of [...ranges].reverse()) {
    after =
      after.slice(0, range.start) + range.edit.newText + after.slice(range.end);
  }
  return { before, after };
}

function unreadable(
  path: string,
  input: unknown,
  edits?: Edit[],
): { path: string; detail: string } {
  return {
    path,
    detail: capped(
      `Exact preview unavailable: existing target could not be read.\n\n${edits ? replacementBlocks(edits) : inputText(input)}`,
    ),
  };
}

export function unknownBackendPreview(input: unknown): string {
  return capped(
    `Custom or unknown backend; exact local preview unavailable.\n\nInput:\n${inputText(input)}`,
  );
}

export function builtinPreview(
  toolName: string,
  input: unknown,
  cwd: string,
): { path?: string; detail: string } {
  const path = pathFor(input, cwd);
  if (!path) {
    return {
      detail: capped(
        `Built-in ${toolName} input has no readable path.\n\n${inputText(input)}`,
      ),
    };
  }

  if (
    toolName === "write" &&
    typeof (input as { content?: unknown }).content === "string"
  ) {
    const after = (input as { content: string }).content;
    try {
      const before = readFileSync(path, "utf8");
      return {
        path,
        detail: capped(generateUnifiedPatch(path, before, after)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path, detail: capped(generateUnifiedPatch(path, "", after)) };
      }
      return unreadable(path, input);
    }
  }

  const edits = (input as { edits?: unknown }).edits;
  if (!Array.isArray(edits) || !edits.every(isEdit)) {
    return {
      path,
      detail: capped(
        `Exact preview unavailable for this built-in edit.\n\n${inputText(input)}`,
      ),
    };
  }
  let before: string;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    return unreadable(path, input, edits);
  }
  const projection = projectEdits(before, edits);
  if ("reason" in projection) {
    return {
      path,
      detail: capped(
        `Exact patch unavailable: ${projection.reason}.\n\n${replacementBlocks(edits)}`,
      ),
    };
  }
  return {
    path,
    detail: capped(
      generateUnifiedPatch(path, projection.before, projection.after),
    ),
  };
}

function isEdit(value: unknown): value is Edit {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Edit).oldText === "string" &&
    typeof (value as Edit).newText === "string"
  );
}
