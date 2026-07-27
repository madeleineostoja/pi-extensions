const META_CHARS = /[*?[\]{},!]/;

/**
 * Extracts the longest literal prefix from a glob pattern that can be used
 * as a Seatbelt `path-prefix` deny rule.
 *
 * Returns null if no literal prefix exists (i.e. the pattern has no '/'
 * before the first meta-character, or starts with a meta-character).
 * Returns the whole pattern if it contains no meta-characters at all.
 */
export function literalPrefix(pattern: string): string | null {
  const metaIndex = pattern.search(META_CHARS);

  if (metaIndex === -1) {
    return pattern;
  }

  if (metaIndex === 0) {
    return null;
  }

  const beforeMeta = pattern.slice(0, metaIndex);
  const lastSlash = beforeMeta.lastIndexOf("/");

  if (lastSlash === -1) {
    return null;
  }

  return beforeMeta.slice(0, lastSlash + 1);
}
