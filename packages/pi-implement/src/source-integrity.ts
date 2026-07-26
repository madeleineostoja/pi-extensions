import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type CorpusArtifact = {
  path: string;
  hash: string;
};

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeCheckboxMarker(line: string): string {
  return line.replace(/^([\t ]*[-*+]\s+\[)[ xX](\]\s+)/, "$1 $2");
}

export function resolveCorpusPath(args: {
  planPath: string;
  checkoutRoot: string;
  corpus: readonly CorpusArtifact[];
  reference: string;
}): string {
  const candidates = isAbsolute(args.reference)
    ? [resolve(args.reference)]
    : [
        resolve(dirname(args.planPath), args.reference),
        resolve(args.checkoutRoot, args.reference),
      ];
  const corpus = new Map(
    args.corpus.map((artifact) => [
      canonicalPath(artifact.path),
      artifact.path,
    ]),
  );
  const resolved = candidates
    .map(canonicalPath)
    .map((candidate) => corpus.get(candidate))
    .find((candidate): candidate is string => candidate !== undefined);
  if (!resolved) {
    throw new Error(
      `Source reference is outside the immutable corpus: ${args.reference}`,
    );
  }
  return resolved;
}

export function canonicalPath(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function protectedArtifactsMatch(
  artifacts: Record<string, string>,
): boolean {
  try {
    return Object.entries(artifacts).every(
      ([path, expected]) => sha256(readFileSync(path, "utf-8")) === expected,
    );
  } catch {
    return false;
  }
}
