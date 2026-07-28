import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DETAIL_LIMIT = 16_384;
const TRUNCATION = "\n… detail truncated at 16,384 characters";

type Edit = { oldText: string; newText: string };

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
    let before = "";
    try {
      before = readFileSync(path, "utf8");
    } catch {}
    const after = (input as { content: string }).content;
    return {
      path,
      detail: capped(`--- ${path}\n+++ ${path}\n-${before}\n+${after}`),
    };
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
    return {
      path,
      detail: capped(
        `Exact preview unavailable: current file could not be read.\n\n${replacementBlocks(edits)}`,
      ),
    };
  }
  let after = before;
  for (const edit of edits) {
    const first = after.indexOf(edit.oldText);
    if (first === -1 || first !== after.lastIndexOf(edit.oldText)) {
      return {
        path,
        detail: capped(
          `Exact patch unavailable: built-in edit matching may be fuzzy or nonprojectable.\n\n${replacementBlocks(edits)}`,
        ),
      };
    }
    after =
      after.slice(0, first) +
      edit.newText +
      after.slice(first + edit.oldText.length);
  }
  return {
    path,
    detail: capped(`--- ${path}\n+++ ${path}\n-${before}\n+${after}`),
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
