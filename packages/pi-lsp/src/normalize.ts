export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type NormalizedLocation = { uri: string; range: LspRange };
export type NormalizedDiagnostic = {
  range: LspRange;
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
};
const maxText = 2_000;

function text(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxText);
}
function position(value: unknown): LspPosition {
  const item = value as Partial<LspPosition> | undefined;
  return {
    line: Math.max(0, Number(item?.line) || 0),
    character: Math.max(0, Number(item?.character) || 0),
  };
}
function range(value: unknown): LspRange {
  const item = value as { start?: unknown; end?: unknown } | undefined;
  return { start: position(item?.start), end: position(item?.end) };
}
export function normalizeLocation(
  value: unknown,
): NormalizedLocation | undefined {
  const item = value as { uri?: unknown; range?: unknown } | undefined;
  return typeof item?.uri === "string"
    ? { uri: item.uri, range: range(item.range) }
    : undefined;
}
export function normalizeDiagnostics(
  value: unknown,
  limit = 100,
): NormalizedDiagnostic[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : [])
    .flatMap((entry) => {
      const item = entry as {
        range?: unknown;
        severity?: unknown;
        message?: unknown;
        source?: unknown;
        code?: unknown;
      };
      const normalized = {
        range: range(item.range),
        severity: typeof item.severity === "number" ? item.severity : 1,
        message: text(item.message),
        ...(typeof item.source === "string"
          ? { source: text(item.source) }
          : {}),
        ...(typeof item.code === "string" || typeof item.code === "number"
          ? { code: item.code }
          : {}),
      };
      const key = JSON.stringify(normalized);
      if (!normalized.message || seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [normalized];
    })
    .sort((a, b) => a.severity - b.severity)
    .slice(0, limit);
}
export function normalizeHover(value: unknown): string | undefined {
  const contents = (value as { contents?: unknown } | undefined)?.contents;
  if (typeof contents === "string") {
    return text(contents);
  }
  if (Array.isArray(contents)) {
    return contents
      .map((part) =>
        text(
          typeof part === "object" && part
            ? ((part as { value?: unknown }).value ?? part)
            : part,
        ),
      )
      .filter(Boolean)
      .join("\n")
      .slice(0, maxText);
  }
  if (contents && typeof contents === "object") {
    return text((contents as { value?: unknown }).value);
  }
  return undefined;
}
export function normalizeSymbols(
  value: unknown,
  limit = 100,
): Array<{ name: string; kind?: number; location?: NormalizedLocation }> {
  return (Array.isArray(value) ? value : [])
    .flatMap((entry) => {
      const item = entry as {
        name?: unknown;
        kind?: unknown;
        location?: unknown;
        range?: unknown;
        selectionRange?: unknown;
        uri?: unknown;
      };
      const name = text(item.name);
      if (!name) {
        return [];
      }
      const location =
        normalizeLocation(item.location) ??
        (typeof item.uri === "string"
          ? { uri: item.uri, range: range(item.selectionRange ?? item.range) }
          : undefined);
      return [
        {
          name,
          ...(typeof item.kind === "number" ? { kind: item.kind } : {}),
          ...(location ? { location } : {}),
        },
      ];
    })
    .slice(0, limit);
}
