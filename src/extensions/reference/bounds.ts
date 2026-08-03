export const LIMITS = {
  authFileBytes: 16 * 1024,
  tokenBytes: 8 * 1024,
  responseBytes: 1024 * 1024,
  resultBytes: 48 * 1024,
  subjectChars: 240,
  questionChars: 2_000,
  versionChars: 120,
  idChars: 500,
  urlChars: 1_000,
  fieldChars: 4_000,
  languageChars: 80,
  snippetChars: 3_000,
  snippets: 12,
  candidates: 5,
  advertisedVersions: 20,
  codeSnippetContainers: 12,
  infoSnippetContainers: 12,
  codeEntries: 12,
  normalizedCodeSnippets: 24,
  normalizedInfoSnippets: 12,
  warnings: 4,
  errorsChars: 400,
  detailsLocations: 12,
  retries: 2,
  redirects: 3,
  deadlineMs: 15_000,
  retryAfterMs: 2_000,
  httpRedirects: 3,
} as const;

export function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

export function boundedText(value: string, maximum: number): string {
  const normalized = [...value]
    .map((character) => (hasControl(character) ? " " : character))
    .join("")
    .trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

export function boundedError(message: string): string {
  return boundedText(message, LIMITS.errorsChars);
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateBytes(
  value: string,
  maximum: number,
): {
  value: string;
  truncated: boolean;
} {
  if (byteLength(value) <= maximum) {
    return { value, truncated: false };
  }
  const suffix = "…";
  let end = Math.max(0, maximum - byteLength(suffix));
  while (end > 0 && byteLength(value.slice(0, end) + suffix) > maximum) {
    end--;
  }
  return { value: value.slice(0, end) + suffix, truncated: true };
}
