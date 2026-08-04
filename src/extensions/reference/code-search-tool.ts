import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGithubAuth } from "./auth.js";
import { LIMITS, byteLength, hasControl } from "./bounds.js";
import {
  createGithubSearch,
  normalizeGithubError,
  type GithubSearchClient,
} from "./github.js";
import { createReferenceInvocation } from "./invocation.js";

export const CodeSearchParameters = Type.Object({
  query: Type.String({
    description:
      "Non-confidential GitHub code-search text. GitHub syntax is permitted in this text.",
  }),
  repository: Type.Optional(
    Type.String({
      description: "Exact GitHub owner/name repository filter.",
    }),
  ),
  owner: Type.Optional(
    Type.String({
      description: "GitHub personal-account filter; emits user:owner.",
    }),
  ),
  language: Type.Optional(Type.String()),
  filename: Type.Optional(Type.String()),
  extension: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.codeLimit })),
});
export type CodeSearchInput = Static<typeof CodeSearchParameters>;

type CodeMatch = {
  rank: number;
  repository: string;
  revision: string;
  path: string;
  url: string;
  fragments?: Array<{ text: string; offsets: number[][] }>;
};
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function registerCodeSearch(
  pi: ExtensionAPI,
  agentDir: () => string,
): void {
  pi.registerTool({
    name: "code_search",
    label: "code_search",
    description:
      "Search observed usage in GitHub source visible to the configured credential. Matches are bounded provider excerpts, not proof of correctness, authority, freshness, identity, or repository health.",
    parameters: CodeSearchParameters,
    async execute(_toolCallId, input: CodeSearchInput, signal) {
      return executeCodeSearch(input, signal, { agentDir: agentDir() });
    },
  });
}

export async function executeCodeSearch(
  input: CodeSearchInput,
  signal?: AbortSignal,
  dependencies: {
    agentDir?: string;
    github?: (options: {
      token: string | undefined;
      signal: AbortSignal;
    }) => GithubSearchClient;
  } = {},
): Promise<ToolResult> {
  const normalized = normalizeInput(input);
  const invocation = createReferenceInvocation(signal);
  try {
    if (invocation.signal.aborted) {
      throw aborted(invocation.signal);
    }
    const token = dependencies.agentDir
      ? loadGithubAuth(dependencies.agentDir)
      : undefined;
    const client = (dependencies.github ?? createGithubSearch)({
      token,
      signal: invocation.signal,
    });
    const response = await client.searchCode({
      q: normalized.expression,
      per_page: normalized.limit,
      mediaType: { format: "text-match" },
      request: { signal: invocation.signal },
    });
    if (invocation.signal.aborted) {
      throw aborted(invocation.signal);
    }
    return buildResult(normalized, response.data);
  } catch (error) {
    if (invocation.signal.aborted) {
      throw aborted(invocation.signal);
    }
    throw normalizeGithubError(error);
  } finally {
    invocation.dispose();
  }
}

type NormalizedInput = {
  query: string;
  limit: number;
  expression: string;
  qualifiers: string[];
};
function normalizeInput(input: CodeSearchInput): NormalizedInput {
  const query = required(input.query, "code_search query");
  const repository = optional(input.repository, "code_search repository");
  const owner = optional(input.owner, "code_search owner");
  if (repository && owner) {
    throw new Error("code_search repository and owner are mutually exclusive.");
  }
  const qualifiers: string[] = [];
  if (repository) {
    const [repositoryOwner, repositoryName, extra] = repository.split("/");
    if (
      !repositoryOwner ||
      !repositoryName ||
      extra ||
      !validAccount(repositoryOwner) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repositoryName)
    ) {
      throw new Error(
        "code_search repository must be an exact bounded owner/name.",
      );
    }
    qualifiers.push(`repo:${repository}`);
  }
  if (owner) {
    if (!validAccount(owner)) {
      throw new Error("code_search owner is invalid.");
    }
    qualifiers.push(`user:${owner}`);
  }
  const language = optional(input.language, "code_search language");
  const filename = optional(input.filename, "code_search filename");
  const extension = optional(input.extension, "code_search extension");
  if (language) {
    if (!/^[A-Za-z][A-Za-z0-9+#.-]{0,79}$/.test(language)) {
      throw new Error("code_search language is invalid.");
    }
    qualifiers.push(`language:${language}`);
  }
  if (filename) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(filename)) {
      throw new Error("code_search filename is invalid.");
    }
    qualifiers.push(`filename:${filename}`);
  }
  if (extension) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/.test(extension)) {
      throw new Error("code_search extension is invalid.");
    }
    qualifiers.push(`extension:${extension}`);
  }
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.codeLimit) {
    throw new Error("code_search limit must be an integer from 1 through 20.");
  }
  return {
    query,
    limit,
    qualifiers,
    expression: [query, ...qualifiers].join(" "),
  };
}
function validAccount(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,37}$/.test(value);
}

function required(value: unknown, name: string): string {
  const result = optional(value, name);
  if (!result) {
    throw new Error(
      `${name} must be a non-empty bounded string without control characters.`,
    );
  }
  return result;
}
function optional(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(
      `${name} must be a bounded string without control characters.`,
    );
  }
  const result = value.trim();
  if (!result || result.length > LIMITS.queryChars || hasControl(result)) {
    throw new Error(
      `${name} must be a non-empty bounded string without control characters.`,
    );
  }
  return result;
}

function buildResult(input: NormalizedInput, payload: unknown): ToolResult {
  const root = object(payload);
  const items = root && Array.isArray(root.items) ? root.items : undefined;
  if (!items) {
    throw new Error("GitHub returned malformed code-search data.");
  }
  const results: CodeMatch[] = [];
  let discarded = 0;
  let locallyTruncated = false;
  for (const [index, item] of items.slice(0, input.limit).entries()) {
    const repository = object(object(item)?.repository);
    const normalized = repository
      ? normalizeMatch(item, repository, index + 1)
      : undefined;
    if (normalized) {
      locallyTruncated ||= normalized.truncated;
      results.push(normalized.match);
    } else {
      discarded++;
    }
  }
  const truncated =
    locallyTruncated ||
    root?.incomplete_results === true ||
    items.length > input.limit ||
    (typeof root?.total_count === "number" && root.total_count > items.length);
  let boundedTruncation = truncated;
  const result = () => {
    const details = {
      provider: "GitHub",
      query: input.query,
      qualifiers: input.qualifiers,
      accepted: results.length,
      discarded,
      truncated: boundedTruncation,
      results,
    };
    const text = [
      `GitHub code search for: ${input.query}`,
      input.qualifiers.length
        ? `Qualifiers: ${input.qualifiers.join(" ")}`
        : "Qualifiers: none",
      `Accepted: ${results.length}; discarded before normalization: ${discarded}${boundedTruncation ? "; results or fields truncated" : ""}.`,
      "Matches are observed usage visible to the configured GitHub credential, not proof of correctness, authority, freshness, package identity, or repository health.",
      ...results.map((result) => JSON.stringify(result)),
    ].join("\n");
    return { content: [{ type: "text" as const, text }], details };
  };
  while (
    byteLength(JSON.stringify(result())) > LIMITS.resultBytes &&
    results.length
  ) {
    results.pop();
    boundedTruncation = true;
  }
  return result();
}

function normalizeMatch(
  value: unknown,
  repository: Record<string, unknown>,
  rank: number,
): { match: CodeMatch; truncated: boolean } | undefined {
  const item = object(value)!;
  const owner = strictText(
    object(repository.owner)?.login,
    LIMITS.languageChars,
  );
  const name = strictText(repository.name, LIMITS.languageChars);
  const revision = strictText(item.sha, LIMITS.shaChars);
  const path = strictText(item.path, LIMITS.pathChars);
  const url = canonicalBlobUrl(item.html_url);
  if (
    !owner ||
    !name ||
    !revision ||
    !/^[a-f0-9]{40}$/i.test(revision) ||
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "..") ||
    !url
  ) {
    return undefined;
  }
  const rawFragments = Array.isArray(item.text_matches)
    ? item.text_matches
    : [];
  const normalizedFragments = rawFragments
    .slice(0, LIMITS.fragmentsPerMatch)
    .flatMap(normalizeFragment);
  const fragments = normalizedFragments.map(({ fragment }) => fragment);
  return {
    match: {
      rank,
      repository: `${owner}/${name}`,
      revision,
      path,
      url,
      ...(fragments.length ? { fragments } : {}),
    },
    truncated:
      rawFragments.length > LIMITS.fragmentsPerMatch ||
      normalizedFragments.some((fragment) => fragment.truncated),
  };
}
function normalizeFragment(value: unknown): Array<{
  fragment: { text: string; offsets: number[][] };
  truncated: boolean;
}> {
  const fragment = object(value);
  const textValue = fragmentText(fragment?.fragment, LIMITS.fragmentChars);
  if (!fragment || !textValue) {
    return [];
  }
  const rawOffsets = Array.isArray(fragment.matches) ? fragment.matches : [];
  let truncated = textValue.truncated || rawOffsets.length > LIMITS.offsetCount;
  const offsets = rawOffsets.slice(0, LIMITS.offsetCount).flatMap((match) => {
    const indices = object(match)?.indices;
    const valid =
      Array.isArray(indices) &&
      indices.length === 2 &&
      indices.every(
        (offset) =>
          typeof offset === "number" &&
          Number.isSafeInteger(offset) &&
          offset >= 0,
      ) &&
      (indices[0] as number) <= (indices[1] as number) &&
      (indices[1] as number) <= textValue.value.length;
    if (!valid) {
      truncated = true;
      return [];
    }
    return [indices as number[]];
  });
  return [{ fragment: { text: textValue.value, offsets }, truncated }];
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function fragmentText(
  value: unknown,
  maximum: number,
): { value: string; truncated: boolean } | undefined {
  if (
    typeof value !== "string" ||
    [...value].some(
      (character) => hasControl(character) && !/[\n\t]/.test(character),
    )
  ) {
    return undefined;
  }
  const normalized = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= maximum
    ? { value: normalized, truncated: false }
    : {
        value: `${normalized.slice(0, Math.max(0, maximum - 1))}…`,
        truncated: true,
      };
}
function strictText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    !hasControl(value) &&
    value.length <= maximum
    ? value.trim() || undefined
    : undefined;
}
function canonicalBlobUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 300 ||
    hasControl(value)
  ) {
    return undefined;
  }
  const raw = value;
  try {
    const url = new URL(raw);
    return url.origin === "https://github.com" &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/[^/]+\/[^/]+\/blob\/[^/]+\/.+/.test(url.pathname)
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}
function aborted(signal: AbortSignal): Error {
  return new Error(
    signal.reason === "deadline"
      ? "GitHub search timed out."
      : "GitHub search was cancelled.",
  );
}
