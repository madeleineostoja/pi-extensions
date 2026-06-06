export function parseModelRef(
  ref: string,
): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return {
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1),
  };
}

export function isModelRef(value: string): boolean {
  return /^[^/\s]+\/.+\S$/.test(value);
}
