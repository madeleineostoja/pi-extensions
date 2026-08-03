import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadContext7Auth } from "./auth.js";
import { LIMITS, byteLength, hasControl, truncateBytes } from "./bounds.js";
import {
  Context7Error,
  createContext7Transport,
  type Context7Snippet,
  type Context7Transport,
  parseContext7Id,
  validId,
} from "./context7.js";

export const DocsParameters = Type.Object({
  subject: Type.String({
    description:
      "Context7 library name or direct /owner/library[/version] or /owner/library@version ID.",
  }),
  question: Type.String({
    description: "Focused documentation question sent to Context7.",
  }),
  version: Type.Optional(
    Type.String({
      description:
        "Exact Context7 version label; omitted uses provider-current documentation.",
    }),
  ),
});
export type DocsInput = Static<typeof DocsParameters>;
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function registerDocs(pi: ExtensionAPI, agentDir: () => string): void {
  pi.registerTool({
    name: "docs",
    label: "docs",
    description:
      "Retrieve bounded Context7 documentation for a named library or direct Context7 ID. Omit version for provider-current material; an explicit version must be an exact Context7 pin. This tool does not inspect the project or delegate research.",
    parameters: DocsParameters,
    async execute(_toolCallId, input: DocsInput, signal) {
      return executeDocs(input, signal, { agentDir: agentDir() });
    },
  });
}

export async function executeDocs(
  input: DocsInput,
  signal?: AbortSignal,
  dependencies: {
    agentDir?: string;
    token?: string;
    transport?: (options: {
      token?: string;
      signal?: AbortSignal;
    }) => Context7Transport;
  } = {},
): Promise<ToolResult> {
  const normalized = normalizeInput(input);
  const token =
    dependencies.token ??
    (dependencies.agentDir === undefined
      ? undefined
      : loadContext7Auth(dependencies.agentDir));
  const transport = (
    dependencies.transport ?? ((options) => createContext7Transport(options))
  )({ token, signal });
  try {
    const resolved = await resolve(normalized, transport);
    let id = resolved.id;
    const seenIds = new Set([id]);
    let redirects = 0;
    let document;
    while (true) {
      try {
        document = await transport.context(id, normalized.question);
      } catch (error) {
        if (
          resolved.state === "exact-version" &&
          error instanceof Context7Error &&
          error.kind === "not-found"
        ) {
          throw new Context7Error(
            "version-unavailable",
            "The requested exact Context7 version is unavailable; no substitute was used.",
          );
        }
        throw error;
      }
      const redirect = document.redirectId;
      if (!redirect) {
        break;
      }
      const redirectId = parseContext7Id(redirect);
      if (
        redirects >= LIMITS.redirects ||
        !redirectId ||
        seenIds.has(redirectId.id) ||
        (resolved.pin && redirectId.pin !== resolved.pin)
      ) {
        throw new Context7Error(
          "redirect",
          "Context7 returned an invalid or conflicting logical documentation redirect.",
        );
      }
      id = redirectId.id;
      seenIds.add(id);
      redirects++;
    }
    if (document.snippets.length === 0) {
      throw new Context7Error(
        "empty",
        "Context7 returned no documentation snippets for this request.",
      );
    }
    return buildResult(
      { ...resolved, id },
      normalized.question,
      document.snippets,
      {
        retries: transport.retries,
        redirects,
        truncations: document.truncations ?? [],
      },
    );
  } finally {
    transport.dispose();
  }
}

type NormalizedInput = { subject: string; question: string; version?: string };
type Resolved = {
  id: string;
  subject: string;
  mode: "direct" | "named";
  rank?: number;
  state: "provider-current" | "exact-version";
  pin?: string;
  warnings: string[];
};
function normalizeInput(input: DocsInput): NormalizedInput {
  const subject = input.subject?.trim();
  const question = input.question?.trim();
  if (!validField(subject, LIMITS.subjectChars)) {
    throw new Error(
      "docs subject must be a non-empty bounded string without control characters.",
    );
  }
  if (!validField(question, LIMITS.questionChars)) {
    throw new Error(
      "docs question must be a non-empty bounded string without control characters.",
    );
  }
  const version = input.version?.trim();
  if (
    version !== undefined &&
    (!validField(version, LIMITS.versionChars) ||
      /[~^*<>=|]/.test(version) ||
      /(^|[._-])[xX](?=$|[._-])/.test(version) ||
      /\s/.test(version))
  ) {
    throw new Error(
      "docs version must be one exact bounded label, not a range or wildcard.",
    );
  }
  if (subject.startsWith("/") && !validId(subject)) {
    throw new Error("docs subject is not a valid direct Context7 ID.");
  }
  return { subject, question, ...(version ? { version } : {}) };
}
async function resolve(
  input: NormalizedInput,
  transport: Context7Transport,
): Promise<Resolved> {
  if (input.subject.startsWith("/")) {
    return resolveDirect(input);
  }
  const candidates = await transport.search(input.subject, input.question);
  if (candidates.length === 0) {
    throw new Context7Error(
      "not-found",
      "Context7 did not find a documentation library for this subject.",
    );
  }
  const normalizedSubject = normalizeName(input.subject);
  const rank = candidates.findIndex(
    (candidate) => normalizeName(candidate.title) === normalizedSubject,
  );
  const selected = candidates[rank < 0 ? 0 : rank];
  if (!selected) {
    throw new Context7Error(
      "not-found",
      "Context7 did not find a documentation library for this subject.",
    );
  }
  const warning =
    rank < 0
      ? [
          "No exact normalized subject match; using the first provider-ranked match.",
        ]
      : [];
  if (!input.version) {
    return {
      id: selected.id,
      subject: selected.title,
      mode: "named",
      rank: selected.rank ?? (rank < 0 ? 1 : rank + 1),
      state: "provider-current",
      warnings: [...warning, ...(selected.truncations ?? [])],
    };
  }
  const requested = normalizeVersion(input.version);
  const version = selected.versions.find(
    (entry) => normalizeVersion(entry.label) === requested,
  );
  if (!version) {
    throw new Context7Error(
      "version-unavailable",
      "The requested exact Context7 version is unavailable; no substitute was used.",
    );
  }
  const id = version.id ?? `${selected.id}/${version.label}`;
  const advertisedPin = parseContext7Id(id)?.pin;
  if (!validId(id) || advertisedPin !== requested) {
    throw new Context7Error(
      "malformed",
      "Context7 advertised an invalid exact version identifier.",
    );
  }
  return {
    id,
    subject: selected.title,
    mode: "named",
    rank: selected.rank ?? (rank < 0 ? 1 : rank + 1),
    state: "exact-version",
    pin: advertisedPin ?? requested,
    warnings: [...warning, ...(selected.truncations ?? [])],
  };
}
function resolveDirect(input: NormalizedInput): Resolved {
  const parsed = parseContext7Id(input.subject)!;
  const existing = parsed.pin;
  const requested = input.version && normalizeVersion(input.version);
  if (existing !== undefined && requested && existing !== requested) {
    throw new Error(
      "The direct Context7 ID and version input specify conflicting exact versions.",
    );
  }
  const id =
    existing !== undefined || !input.version
      ? input.subject
      : `${input.subject}/${input.version}`;
  if (!validId(id)) {
    throw new Error("docs subject is not a valid direct Context7 ID.");
  }
  return {
    id,
    subject: input.subject,
    mode: "direct",
    state:
      existing !== undefined || input.version
        ? "exact-version"
        : "provider-current",
    ...(existing !== undefined || requested !== undefined
      ? { pin: existing ?? requested }
      : {}),
    warnings: [],
  };
}
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export function normalizeVersion(value: string): string {
  const trimmed = value.trim().toLocaleLowerCase().replace(/^v/, "");
  return trimmed.replaceAll("_", ".");
}
function validField(
  value: string | undefined,
  maximum: number,
): value is string {
  return Boolean(value && value.length <= maximum && !hasControl(value));
}

function buildResult(
  resolved: Resolved,
  question: string,
  snippets: Context7Snippet[],
  activity: { retries: number; redirects: number; truncations: string[] },
): ToolResult {
  const providerTruncated =
    activity.truncations.length > 0 ||
    resolved.warnings.some((warning) => warning.includes("truncated"));
  const warnings = [
    ...(providerTruncated ? ["Context7 provider material was truncated."] : []),
    ...resolved.warnings,
    ...activity.truncations,
  ].slice(0, LIMITS.warnings);
  const locations = snippets
    .flatMap((snippet) => (snippet.location ? [snippet.location] : []))
    .slice(0, LIMITS.detailsLocations);
  const details: Record<string, unknown> = {
    provider: "Context7",
    resolution: {
      mode: resolved.mode,
      selectedId: resolved.id,
      ...(resolved.rank ? { rank: resolved.rank } : {}),
    },
    version:
      resolved.state === "provider-current"
        ? { state: "provider-current" }
        : { state: "exact-version", pin: resolved.pin },
    ...(warnings.length ? { warnings } : {}),
    ...(locations.length ? { locations } : {}),
    retries: activity.retries,
    logicalRedirects: activity.redirects,
  };
  const rendered = render(resolved, question, snippets, warnings);
  let text = rendered.text;
  let truncation = rendered.truncated;
  const budget =
    LIMITS.resultBytes -
    byteLength(
      JSON.stringify({ content: [{ type: "text", text: "" }], details }),
    ) -
    32;
  const clipped = truncateBytes(text, Math.max(128, budget));
  text = clipped.value;
  truncation ||= clipped.truncated;
  if (truncation) {
    details.truncation =
      "Documentation was truncated to the tool result limit.";
  }
  while (
    byteLength(JSON.stringify({ content: [{ type: "text", text }], details })) >
      LIMITS.resultBytes &&
    text.length > 0
  ) {
    text = truncateBytes(text, Math.max(0, byteLength(text) - 256)).value;
    truncation = true;
    details.truncation =
      "Documentation was truncated to the tool result limit.";
  }
  return { content: [{ type: "text", text }], details };
}
function render(
  resolved: Resolved,
  question: string,
  snippets: Context7Snippet[],
  warnings: string[],
): { text: string; truncated: boolean } {
  const lines = [
    `Context7 documentation for ${resolved.subject}`,
    `Resolution: ${resolved.mode}; ID: ${resolved.id}`,
    resolved.state === "provider-current"
      ? "Version: provider-current"
      : `Version: exact ${resolved.pin}`,
    `Question: ${question}`,
    ...warnings.map((warning) => `Warning: ${warning}`),
  ];
  let truncated = false;
  for (const [index, snippet] of snippets.entries()) {
    if (index >= LIMITS.snippets) {
      truncated = true;
      break;
    }
    const title = snippet.title ?? "Context7 snippet";
    const source = snippet.location ? ` (${snippet.location})` : "";
    const language = snippet.language ? ` [${snippet.language}]` : "";
    lines.push(`\n${index + 1}. ${title}${language}${source}\n${snippet.text}`);
  }
  if (snippets.length > LIMITS.snippets) {
    lines.push("\nAdditional Context7 snippets were omitted.");
  }
  return { text: lines.join("\n"), truncated };
}
