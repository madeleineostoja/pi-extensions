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
export type NormalizedSymbol = {
  name: string;
  kind?: number;
  location?: NormalizedLocation;
};
export type NormalizedResult<T> = { items: T[]; truncated: boolean };

export const MAX_LSP_TEXT = 2_000;

function text(value: unknown): { value: string; truncated: boolean } {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    value: normalized.slice(0, MAX_LSP_TEXT),
    truncated: normalized.length > MAX_LSP_TEXT,
  };
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
  const item = value as
    | {
        uri?: unknown;
        range?: unknown;
        targetUri?: unknown;
        targetSelectionRange?: unknown;
        targetRange?: unknown;
      }
    | undefined;
  const uri =
    typeof item?.uri === "string"
      ? item.uri
      : typeof item?.targetUri === "string"
        ? item.targetUri
        : undefined;
  if (!uri) {
    return undefined;
  }
  return {
    uri,
    range: range(
      item?.range ?? item?.targetSelectionRange ?? item?.targetRange,
    ),
  };
}

export function normalizeLocations(
  value: unknown,
  limit = 100,
): NormalizedResult<NormalizedLocation> {
  const locations = (Array.isArray(value) ? value : [value])
    .map(normalizeLocation)
    .filter((location): location is NormalizedLocation => Boolean(location));
  return {
    items: locations.slice(0, limit),
    truncated: locations.length > limit,
  };
}

export function normalizeDiagnosticsResult(
  value: unknown,
  limit = 100,
): NormalizedResult<NormalizedDiagnostic> {
  const seen = new Set<string>();
  const diagnostics = (Array.isArray(value) ? value : [])
    .flatMap((entry) => {
      const item = entry as {
        range?: unknown;
        severity?: unknown;
        message?: unknown;
        source?: unknown;
        code?: unknown;
      };
      const message = text(item.message).value;
      const normalized = {
        range: range(item.range),
        severity: typeof item.severity === "number" ? item.severity : 1,
        message,
        ...(typeof item.source === "string"
          ? { source: text(item.source).value }
          : {}),
        ...(typeof item.code === "string" || typeof item.code === "number"
          ? { code: item.code }
          : {}),
      };
      const key = JSON.stringify(normalized);
      if (!message || seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [normalized];
    })
    .sort((a, b) => a.severity - b.severity);
  return {
    items: diagnostics.slice(0, limit),
    truncated: diagnostics.length > limit,
  };
}

export function normalizeDiagnostics(
  value: unknown,
  limit = 100,
): NormalizedDiagnostic[] {
  return normalizeDiagnosticsResult(value, limit).items;
}

export function normalizeHoverResult(value: unknown): {
  text?: string;
  truncated: boolean;
} {
  const contents = (value as { contents?: unknown } | undefined)?.contents;
  const values =
    typeof contents === "string"
      ? [contents]
      : Array.isArray(contents)
        ? contents.map((part) =>
            typeof part === "object" && part
              ? ((part as { value?: unknown }).value ?? part)
              : part,
          )
        : contents && typeof contents === "object"
          ? [(contents as { value?: unknown }).value]
          : [];
  const combined = values.map((part) => String(part ?? "")).join("\n");
  const normalized = text(combined);
  return normalized.value
    ? { text: normalized.value, truncated: normalized.truncated }
    : { truncated: false };
}

export function normalizeHover(value: unknown): string | undefined {
  return normalizeHoverResult(value).text;
}

export function normalizeSymbolsResult(
  value: unknown,
  limit = 100,
  defaultUri?: string,
): NormalizedResult<NormalizedSymbol> {
  const symbols: NormalizedSymbol[] = [];
  const visit = (entries: unknown[]): void => {
    for (const entry of entries) {
      const item = entry as {
        name?: unknown;
        kind?: unknown;
        location?: unknown;
        range?: unknown;
        selectionRange?: unknown;
        uri?: unknown;
        children?: unknown;
      };
      const name = text(item.name).value;
      if (name) {
        const location =
          normalizeLocation(item.location) ??
          (typeof item.uri === "string"
            ? { uri: item.uri, range: range(item.selectionRange ?? item.range) }
            : defaultUri
              ? {
                  uri: defaultUri,
                  range: range(item.selectionRange ?? item.range),
                }
              : undefined);
        symbols.push({
          name,
          ...(typeof item.kind === "number" ? { kind: item.kind } : {}),
          ...(location ? { location } : {}),
        });
      }
      if (Array.isArray(item.children)) {
        visit(item.children);
      }
    }
  };
  visit(Array.isArray(value) ? value : []);
  return { items: symbols.slice(0, limit), truncated: symbols.length > limit };
}

export function normalizeSymbols(
  value: unknown,
  limit = 100,
): NormalizedSymbol[] {
  return normalizeSymbolsResult(value, limit).items;
}
