import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { RequestCancelledError, RequestTimeoutError } from "./protocol.js";
import {
  normalizeHoverResult,
  normalizeLocations,
  normalizeSymbolsResult,
  type NormalizedLocation,
} from "./normalize.js";
import { getLspPool, type LspPool } from "./pool.js";
import {
  resolveServer,
  type ResolvedServer,
  type UnavailableServer,
} from "./server.js";
import {
  assertWorkspaceFile,
  canonicalPath,
  isWithin,
  nearestWorkspaceRoot,
  serverForFile,
  type ServerKind,
} from "./workspace.js";

const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const warningKey = Symbol.for("pipkin:lsp:unavailable-warnings");
type WarningStore = Set<string>;

const Actions = [
  "definition",
  "type_definition",
  "implementation",
  "references",
  "hover",
  "document_symbols",
  "workspace_symbols",
  "diagnostics",
  "status",
] as const;
type Action = (typeof Actions)[number];

export const LspParameters = Type.Object({
  action: Type.Union(Actions.map((action) => Type.Literal(action))),
  file: Type.Optional(
    Type.String({
      description:
        "Workspace-relative or absolute source file. Required except status and workspace_symbols without a target file.",
    }),
  ),
  line: Type.Optional(
    Type.Integer({ description: "1-indexed line for position actions." }),
  ),
  column: Type.Optional(
    Type.Integer({ description: "1-indexed column for position actions." }),
  ),
  symbol: Type.Optional(
    Type.String({
      description:
        "Symbol text resolved on line when column is omitted; use occurrence to choose repeated text.",
    }),
  ),
  occurrence: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "1-indexed occurrence of symbol on the specified line.",
    }),
  ),
  query: Type.Optional(Type.String({ description: "Workspace symbol query." })),
  timeout: Type.Optional(
    Type.Number({
      minimum: 0.1,
      description: "Request timeout in seconds, capped at 15 seconds.",
    }),
  ),
});
type LspInput = Omit<Static<typeof LspParameters>, "action"> & {
  action: Action;
};
type ToolDetails = Record<string, unknown>;

const positionActions = new Set<Action>([
  "definition",
  "type_definition",
  "implementation",
  "references",
  "hover",
]);
const capabilityFor = {
  definition: "definition",
  type_definition: "typeDefinition",
  implementation: "implementation",
  references: "references",
  hover: "hover",
  document_symbols: "documentSymbol",
  workspace_symbols: "workspaceSymbol",
} as const;

export function registerLsp(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "lsp",
    label: "lsp",
    description:
      "Read-only, workspace-scoped language-semantic queries: definitions, implementations, references, type information, symbols, hover, and explicit diagnostics. Prefer this for relationships text search may miss; use text search or Explore for broad/non-semantic discovery. Request diagnostics after a coherent edit batch, not during intentionally incomplete edits. LSP feedback does not replace required lint, typecheck, test, or build commands. If unavailable, continue with source search or project CLI tooling and do not install dependencies unless the user asks.",
    parameters: LspParameters,
    async execute(_toolCallId, input: LspInput, signal, _onUpdate, ctx) {
      return executeLsp(input, signal, ctx);
    },
  });
}

export async function executeLsp(
  input: LspInput,
  signal: AbortSignal | undefined,
  ctx: Pick<ExtensionContext, "cwd" | "ui">,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails;
}> {
  const validation = validate(input);
  if (validation) {
    return result(validation, {
      action: input.action,
      available: true,
      success: false,
    });
  }
  if (input.action === "status") {
    const details = lspStatus(ctx.cwd);
    return result(renderStatus(details), details);
  }
  let resolvedRoute: { kind: ServerKind; workspaceRoot: string } | undefined;
  try {
    const target = targetFor(input, ctx.cwd);
    const route = routeFor(input, target, ctx.cwd);
    if ("error" in route) {
      return result(route.error, {
        action: input.action,
        available: true,
        success: false,
      });
    }
    if ("available" in route.server) {
      return unavailable(
        input.action,
        route.workspaceRoot,
        route.kind,
        route.server.reason,
        ctx,
      );
    }
    resolvedRoute = route;
    const deadline = Date.now() + boundedTimeout(input.timeout);
    const client = await getLspPool().acquire(
      route.server,
      route.workspaceRoot,
      { timeoutMs: remainingTimeout(deadline), signal },
    );
    if ("available" in client) {
      return unavailable(
        input.action,
        route.workspaceRoot,
        route.kind,
        client.reason,
        ctx,
        client.coolingDown,
      );
    }
    if (input.action === "diagnostics") {
      const diagnostics = await client.diagnostics(
        target!,
        languageId(route.kind, target!),
        client.capabilities,
        { timeoutMs: remainingTimeout(deadline), signal },
      );
      const details = {
        action: input.action,
        available: true,
        success: diagnostics.fresh,
        server: route.kind,
        workspace: route.workspaceRoot,
        diagnostics: diagnostics.diagnostics.map(displayDiagnostic),
        truncation: { diagnostics: diagnostics.truncated },
        ...(diagnostics.stale ? { stale: true } : {}),
        ...(diagnostics.timedOut ? { timedOut: true } : {}),
      };
      return result(
        diagnostics.fresh
          ? `LSP diagnostics: ${diagnostics.diagnostics.length}${diagnostics.truncated ? "+" : ""} issue(s).`
          : "LSP diagnostics were not fresh before the timeout; run project validation for authoritative results.",
        details,
      );
    }
    const capability =
      capabilityFor[input.action as keyof typeof capabilityFor];
    if (!capability || !client.supports(capability)) {
      return result(
        `The ${route.kind} LSP server does not support ${String(input.action).replaceAll("_", " ")}. Use source search or project tooling instead.`,
        {
          action: input.action,
          available: true,
          success: false,
          server: route.kind,
          workspace: route.workspaceRoot,
          unsupported: true,
        },
      );
    }
    const raw =
      input.action === "workspace_symbols"
        ? await client.workspaceSymbols(input.query ?? "", {
            timeoutMs: remainingTimeout(deadline),
            signal,
          })
        : await client.semantic(
            capability as Exclude<typeof capability, "workspaceSymbol">,
            target!,
            languageId(route.kind, target!),
            positionActions.has(input.action)
              ? positionFor(input, target!)
              : undefined,
            { timeoutMs: remainingTimeout(deadline), signal },
          );
    return semanticResult(input.action, raw, route);
  } catch (error) {
    if (signal?.aborted || error instanceof RequestCancelledError) {
      throw error;
    }
    return unavailable(
      input.action,
      resolvedRoute?.workspaceRoot ?? canonicalPath(ctx.cwd),
      resolvedRoute?.kind ?? "typescript",
      conciseError(error),
      ctx,
    );
  }
}

function validate(input: LspInput): string | undefined {
  if (
    input.timeout !== undefined &&
    (!Number.isFinite(input.timeout) || input.timeout <= 0)
  ) {
    return "timeout must be a positive number of seconds";
  }
  if (positionActions.has(input.action)) {
    if (!input.file) {
      return `${input.action} requires file`;
    }
    if (!input.line || input.line < 1) {
      return `${input.action} requires a 1-indexed line`;
    }
    if (input.column !== undefined && input.column < 1) {
      return "column must be 1-indexed";
    }
    if (input.column === undefined && !input.symbol) {
      return `${input.action} requires column or symbol`;
    }
  }
  if (
    ["document_symbols", "diagnostics"].includes(input.action) &&
    !input.file
  ) {
    return `${input.action} requires file`;
  }
  if (input.action === "workspace_symbols" && input.query === undefined) {
    return "workspace_symbols requires query";
  }
  if (input.occurrence !== undefined && input.occurrence < 1) {
    return "occurrence must be a positive 1-indexed integer";
  }
  return undefined;
}

function targetFor(input: LspInput, cwd: string): string | undefined {
  if (!input.file) {
    return undefined;
  }
  const target = assertWorkspaceFile(cwd, resolve(cwd, input.file));
  if (!existsSync(target)) {
    throw new Error(`LSP target does not exist: ${input.file}`);
  }
  return target;
}

function routeFor(
  input: LspInput,
  target: string | undefined,
  cwd: string,
):
  | {
      kind: ServerKind;
      workspaceRoot: string;
      server: ResolvedServer | UnavailableServer;
    }
  | { error: string } {
  if (target) {
    const kind = serverForFile(target);
    if (!kind) {
      return { error: `Unsupported LSP file type: ${input.file}` };
    }
    const workspaceRoot = nearestWorkspaceRoot(kind, target, cwd);
    return { kind, workspaceRoot, server: resolveServer(kind, workspaceRoot) };
  }
  const workspace = canonicalPath(cwd);
  const running = getLspPool()
    .status()
    .filter(
      (entry) =>
        entry.state === "running" && isWithin(workspace, entry.workspaceRoot),
    );
  const active = running.length === 1 ? running[0] : undefined;
  const kind = active?.kind ?? discoverKind(workspace);
  if (!kind) {
    return {
      error:
        "No supported TypeScript, Svelte, or Ruby workspace was discovered; provide file to select one.",
    };
  }
  const workspaceRoot = active?.workspaceRoot ?? workspace;
  return { kind, workspaceRoot, server: resolveServer(kind, workspaceRoot) };
}

function discoverKind(workspace: string): ServerKind | undefined {
  if (
    existsSync(resolve(workspace, "Gemfile")) ||
    existsSync(resolve(workspace, ".ruby-version"))
  ) {
    return "ruby";
  }
  if (
    [
      "svelte.config.js",
      "svelte.config.mjs",
      "svelte.config.cjs",
      "svelte.config.ts",
    ].some((name) => existsSync(resolve(workspace, name)))
  ) {
    return "svelte";
  }
  if (
    ["tsconfig.json", "jsconfig.json", "package.json"].some((name) =>
      existsSync(resolve(workspace, name)),
    )
  ) {
    return "typescript";
  }
  return undefined;
}

function positionFor(
  input: LspInput,
  file: string,
): { line: number; character: number } {
  const line = readFileSync(file, "utf8").split(/\r?\n/)[input.line! - 1];
  if (line === undefined) {
    throw new Error(`line ${input.line} is outside ${input.file}`);
  }
  if (input.column !== undefined) {
    return { line: input.line! - 1, character: input.column - 1 };
  }
  const symbol = input.symbol!;
  let start = -1;
  let from = 0;
  for (let count = 0; count < (input.occurrence ?? 1); count++) {
    start = line.indexOf(symbol, from);
    if (start < 0) {
      throw new Error(
        `symbol ${JSON.stringify(symbol)} occurrence ${input.occurrence ?? 1} was not found on line ${input.line}`,
      );
    }
    from = start + symbol.length;
  }
  return { line: input.line! - 1, character: start };
}

function semanticResult(
  action: Action,
  raw: unknown,
  route: { kind: ServerKind; workspaceRoot: string },
): { content: Array<{ type: "text"; text: string }>; details: ToolDetails } {
  const base = {
    action,
    available: true,
    success: true,
    server: route.kind,
    workspace: route.workspaceRoot,
  };
  if (action === "hover") {
    const hover = normalizeHoverResult(raw);
    return result(hover.text ?? "No hover information.", {
      ...base,
      hover: hover.text,
      truncation: { hover: hover.truncated },
    });
  }
  const normalized =
    action === "document_symbols" || action === "workspace_symbols"
      ? normalizeSymbolsResult(raw, 100)
      : normalizeLocations(raw, 100);
  const key =
    action === "document_symbols" || action === "workspace_symbols"
      ? "symbols"
      : "locations";
  return result(
    `LSP ${action.replaceAll("_", " ")}: ${normalized.items.length}${normalized.truncated ? "+" : ""} ${key}.`,
    {
      ...base,
      [key]: normalized.items.map(displayLocationOrSymbol),
      truncation: { [key]: normalized.truncated },
    },
  );
}

function displayLocation(location: NormalizedLocation): {
  file: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
} {
  return {
    file: location.uri.startsWith("file:")
      ? fileURLToPath(location.uri)
      : location.uri,
    range: {
      start: {
        line: location.range.start.line + 1,
        column: location.range.start.character + 1,
      },
      end: {
        line: location.range.end.line + 1,
        column: location.range.end.character + 1,
      },
    },
  };
}
function displayLocationOrSymbol(value: unknown): unknown {
  if (value && typeof value === "object" && "name" in value) {
    const symbol = value as {
      name: string;
      kind?: number;
      location?: NormalizedLocation;
    };
    return {
      name: symbol.name,
      ...(symbol.kind === undefined ? {} : { kind: symbol.kind }),
      ...(symbol.location
        ? { location: displayLocation(symbol.location) }
        : {}),
    };
  }
  return displayLocation(value as NormalizedLocation);
}
function displayDiagnostic(diagnostic: {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}): unknown {
  return {
    ...diagnostic,
    range: {
      start: {
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
      },
      end: {
        line: diagnostic.range.end.line + 1,
        column: diagnostic.range.end.character + 1,
      },
    },
  };
}
function boundedTimeout(seconds: number | undefined): number {
  return Math.min(
    MAX_TIMEOUT_MS,
    Math.round((seconds ?? DEFAULT_TIMEOUT_MS / 1_000) * 1_000),
  );
}
function remainingTimeout(deadline: number): number {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) {
    throw new RequestTimeoutError("LSP request timed out");
  }
  return timeoutMs;
}
function languageId(kind: ServerKind, file: string): string {
  if (kind !== "typescript") {
    return kind;
  }
  const extension = extname(file).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return "javascript";
  }
  if (extension === ".jsx") {
    return "javascriptreact";
  }
  if (extension === ".tsx") {
    return "typescriptreact";
  }
  return "typescript";
}
function result(
  text: string,
  details: ToolDetails,
): { content: Array<{ type: "text"; text: string }>; details: ToolDetails } {
  return { content: [{ type: "text", text }], details };
}
function unavailable(
  action: Action,
  workspace: string,
  kind: ServerKind,
  reason: string,
  ctx: Pick<ExtensionContext, "ui">,
  coolingDown = false,
) {
  warnOnce(workspace, kind, reason, ctx);
  return result(
    `LSP ${kind} is unavailable: ${reason}. Continue with source search or project CLI tooling; do not install dependencies unless asked.`,
    {
      action,
      available: false,
      success: false,
      server: kind,
      workspace,
      reason,
      ...(coolingDown ? { coolingDown: true } : {}),
    },
  );
}
function warnOnce(
  workspace: string,
  kind: ServerKind,
  reason: string,
  ctx: Pick<ExtensionContext, "ui">,
): void {
  const scope = globalThis as Record<symbol, unknown>;
  const warnings = (scope[warningKey] ??= new Set<string>()) as WarningStore;
  const key = `${workspace}|${kind}|${reason}`;
  if (!warnings.has(key)) {
    warnings.add(key);
    ctx.ui.notify(`LSP ${kind} unavailable: ${reason}`, "warning");
  }
}
export function lspStatus(
  cwd: string,
  pool: LspPool = getLspPool(),
): ToolDetails {
  const workspace = canonicalPath(cwd);
  const active = pool
    .status()
    .filter((entry) => isWithin(workspace, entry.workspaceRoot));
  const discovered = (["typescript", "svelte", "ruby"] as ServerKind[]).map(
    (kind) => {
      const server = resolveServer(kind, workspace);
      return "available" in server
        ? { kind, state: "unavailable", reason: server.reason }
        : { kind, state: "not-started" };
    },
  );
  return {
    action: "status",
    available: true,
    workspace,
    servers: active.length > 0 ? active : discovered,
  };
}
function renderStatus(details: ToolDetails): string {
  const servers = details.servers as Array<{
    kind: string;
    state: string;
    workspaceRoot?: string;
    reason?: string;
  }>;
  return [
    "LSP status (discovery does not start servers):",
    ...servers.map(
      (server) =>
        `- ${server.kind}: ${server.state}${server.workspaceRoot ? ` (${server.workspaceRoot})` : ""}${server.reason ? ` — ${server.reason}` : ""}`,
    ),
  ].join("\n");
}
function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
}
