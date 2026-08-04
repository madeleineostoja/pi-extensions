import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadContext7Auth, loadGithubAuth } from "./auth.js";
import {
  LIMITS,
  boundedError,
  boundedText,
  byteLength,
  hasControl,
} from "./bounds.js";
import { createContext7Transport, type Context7Transport } from "./context7.js";
import {
  createGithubSearch,
  normalizeGithubError,
  type GithubSearchClient,
} from "./github.js";
import { createReferenceInvocation } from "./invocation.js";
import { NpmError, searchNpm, type NpmPackage } from "./npm.js";

export const PackageSearchParameters = Type.Object(
  {
    query: Type.String({
      description:
        "Non-confidential package search text sent separately to documentation, npm, and GitHub searches.",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: LIMITS.packageLimit,
        description:
          "Maximum results requested from each search, bounded by provider limits.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type PackageSearchInput = Static<typeof PackageSearchParameters>;

type Provider = "documentation" | "npm" | "github";
type Group<T> = {
  provider: Provider;
  status: "ok" | "error";
  results: T[];
  error?: string;
  errorKind?: "unavailable" | "malformed" | "oversized";
  discarded?: number;
  truncated?: boolean;
};
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type ContextResult = {
  rank: number;
  id: string;
  title: string;
  description?: string;
  versions: string[];
  quality?: { trustScore?: number; totalSnippets?: number };
};
type GithubRepository = {
  rank: number;
  repository: string;
  description?: string;
  url: string;
  language?: string;
  stars: number;
  forks: number;
  updatedAt?: string;
  pushedAt?: string;
  license?: string;
  archived: boolean;
  fork: boolean;
};

export function registerPackageSearch(
  pi: ExtensionAPI,
  agentDir: () => string,
): void {
  pi.registerTool({
    name: "package_search",
    label: "package_search",
    description:
      "Discover separately ranked ecosystem documentation, public npm packages, and explicitly public GitHub repositories. Results are provider signals, not identity matching or recommendations.",
    parameters: PackageSearchParameters,
    async execute(_toolCallId, input: PackageSearchInput, signal) {
      return executePackageSearch(input, signal, { agentDir: agentDir() });
    },
  });
}

export async function executePackageSearch(
  input: PackageSearchInput,
  signal?: AbortSignal,
  dependencies: {
    agentDir?: string;
    context?: (options: {
      token?: string;
      signal: AbortSignal;
    }) => Context7Transport;
    npm?: (
      query: string,
      limit: number,
      signal: AbortSignal,
    ) => ReturnType<typeof searchNpm>;
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
    let context: Context7Transport | undefined;
    const contextTask = (async () => {
      try {
        const token = dependencies.agentDir
          ? loadContext7Auth(dependencies.agentDir)
          : undefined;
        context = (
          dependencies.context ??
          ((options) => createContext7Transport(options))
        )({
          token,
          signal: invocation.signal,
        });
        return await contextProvider(
          context,
          normalized.query,
          normalized.limit,
        );
      } catch (error) {
        return errorGroup("documentation", error);
      }
    })();
    const githubTask = (async () => {
      try {
        const token = dependencies.agentDir
          ? loadGithubAuth(dependencies.agentDir)
          : undefined;
        return await githubProvider(
          (dependencies.github ?? createGithubSearch)({
            token,
            signal: invocation.signal,
          }),
          normalized.query,
          normalized.limit,
          invocation.signal,
        );
      } catch (error) {
        return errorGroup("github", normalizeGithubError(error));
      }
    })();
    const providers = [
      contextTask,
      Promise.resolve()
        .then(() =>
          (dependencies.npm ?? searchNpm)(
            normalized.query,
            normalized.limit,
            invocation.signal,
          ),
        )
        .then(({ results, discarded, truncated }) => ({
          provider: "npm" as const,
          status: "ok" as const,
          results,
          discarded,
          truncated,
        })),
      githubTask,
    ] as const;
    const settled = await Promise.allSettled(providers);
    context?.dispose();
    if (invocation.signal.aborted) {
      throw aborted(invocation.signal);
    }
    const groups = settled.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : errorGroup(
            (["documentation", "npm", "github"] as const)[index]!,
            result.reason,
          ),
    ) as [Group<ContextResult>, Group<NpmPackage>, Group<GithubRepository>];
    if (groups.every((group) => group.status === "error")) {
      throw new Error("package_search failed across all providers.");
    }
    return buildResult(normalized, groups);
  } finally {
    invocation.dispose();
  }
}

function normalizeInput(input: PackageSearchInput): {
  query: string;
  limit: number;
} {
  const query = input.query?.trim();
  if (!query || query.length > LIMITS.queryChars || hasControl(query)) {
    throw new Error(
      "package_search query must be a non-empty bounded string without control characters.",
    );
  }
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.packageLimit) {
    throw new Error(
      "package_search limit must be an integer from 1 through 10.",
    );
  }
  return { query, limit };
}

async function contextProvider(
  client: Context7Transport,
  query: string,
  limit: number,
): Promise<Group<ContextResult>> {
  try {
    const candidates = await client.search(query, query, limit);
    let locallyTruncated = false;
    const selected = candidates.slice(0, limit).map((candidate, index) => {
      const versions = candidate.versions
        .slice(0, 5)
        .map((version) => boundedText(version.label, LIMITS.versionChars));
      locallyTruncated ||=
        candidate.versions.length > versions.length ||
        candidate.id.length > LIMITS.repositoryChars ||
        candidate.title.length > LIMITS.languageChars ||
        (candidate.description?.length ?? 0) > 400 ||
        candidate.versions.some(
          (version) => version.label.length > LIMITS.versionChars,
        );
      return {
        rank: candidate.rank ?? index + 1,
        id: boundedText(candidate.id, LIMITS.repositoryChars),
        title: boundedText(candidate.title, LIMITS.languageChars),
        ...(candidate.description
          ? { description: boundedText(candidate.description, 400) }
          : {}),
        versions,
        ...(candidate.quality ? { quality: candidate.quality } : {}),
      };
    });
    return {
      provider: "documentation",
      status: "ok",
      results: selected,
      truncated:
        locallyTruncated ||
        candidates.length > limit ||
        candidates.some(
          (candidate) => (candidate.truncations?.length ?? 0) > 0,
        ),
    };
  } catch (error) {
    return errorGroup("documentation", error);
  }
}

async function githubProvider(
  client: GithubSearchClient,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<Group<GithubRepository>> {
  try {
    const response = await client.searchRepositories({
      q: `${query} is:public`,
      per_page: limit,
      request: { signal },
    });
    const payload = response.data as unknown;
    const root = object(payload);
    const items = root && Array.isArray(root.items) ? root.items : undefined;
    if (!items) {
      throw new Error("malformed");
    }
    const results: GithubRepository[] = [];
    let discarded = 0;
    let locallyTruncated = false;
    for (const [index, item] of items.slice(0, limit).entries()) {
      const repository = object(item);
      if (!repository) {
        discarded++;
        continue;
      }
      const normalized = normalizeRepository(repository, index + 1);
      if (normalized) {
        locallyTruncated ||= repositoryFieldsWereShortened(repository);
        results.push(normalized);
      } else {
        discarded++;
      }
    }
    return {
      provider: "github",
      status: "ok",
      results,
      ...(discarded ? { discarded } : {}),
      truncated:
        locallyTruncated ||
        root?.incomplete_results === true ||
        items.length > limit ||
        (typeof root?.total_count === "number" &&
          root.total_count > items.length),
    };
  } catch (error) {
    return errorGroup("github", normalizeGithubError(error));
  }
}

function normalizeRepository(
  repository: Record<string, unknown>,
  rank: number,
): GithubRepository | undefined {
  const owner = object(repository.owner);
  const ownerName = strictText(owner?.login, LIMITS.languageChars);
  const name = strictText(repository.name, LIMITS.languageChars);
  const url = canonicalGithubUrl(repository.html_url);
  const stars = integer(repository.stargazers_count);
  const forks = integer(repository.forks_count);
  if (
    !ownerName ||
    !name ||
    !url ||
    stars === undefined ||
    forks === undefined ||
    typeof repository.archived !== "boolean" ||
    typeof repository.fork !== "boolean"
  ) {
    return undefined;
  }
  return {
    rank,
    repository: `${ownerName}/${name}`,
    ...(text(repository.description, 400)
      ? { description: text(repository.description, 400)! }
      : {}),
    url,
    ...(text(repository.language, LIMITS.languageChars)
      ? { language: text(repository.language, LIMITS.languageChars)! }
      : {}),
    stars,
    forks,
    ...(text(repository.updated_at, LIMITS.dateChars)
      ? { updatedAt: text(repository.updated_at, LIMITS.dateChars)! }
      : {}),
    ...(text(repository.pushed_at, LIMITS.dateChars)
      ? { pushedAt: text(repository.pushed_at, LIMITS.dateChars)! }
      : {}),
    ...(text(object(repository.license)?.spdx_id, LIMITS.languageChars)
      ? {
          license: text(
            object(repository.license)?.spdx_id,
            LIMITS.languageChars,
          )!,
        }
      : {}),
    archived: repository.archived,
    fork: repository.fork,
  };
}

function buildResult(
  input: { query: string; limit: number },
  groups: [Group<ContextResult>, Group<NpmPackage>, Group<GithubRepository>],
): ToolResult {
  const result = () => {
    const details = { query: input.query, limit: input.limit, groups };
    const text = [
      `Package discovery for: ${input.query}`,
      "Documentation availability, npm publication data, and public GitHub repositories are separately ranked provider signals; they are not matched, compared, or recommendations.",
      npmGuidance(groups[1]),
      ...groups.map(renderGroup),
    ].join("\n");
    return { content: [{ type: "text" as const, text }], details };
  };
  while (byteLength(JSON.stringify(result())) > LIMITS.resultBytes) {
    const group = [...groups].reverse().find((entry) => entry.results.length);
    if (!group) {
      break;
    }
    group.results.pop();
    group.truncated = true;
  }
  return result();
}

function npmGuidance(group: Group<NpmPackage>): string {
  return group.status === "ok"
    ? "npm results are query-ranked, similarly named discovery candidates, not verified identity matches. Use an exact package name with `npm view` for manifests, dependencies, platform support, and publication metadata."
    : "npm discovery failed. Retry with a simpler or exact package-name query, or verify a candidate from another provider with `npm view`.";
}

function renderGroup(group: Group<unknown>): string {
  const state =
    group.status === "ok"
      ? "ok"
      : `error${group.errorKind ? ` [${group.errorKind}]` : ""}: ${group.error}`;
  const notices = [
    group.discarded ? `${group.discarded} discarded` : undefined,
    group.truncated
      ? "truncated; omitted provider fields or results"
      : undefined,
  ].filter(Boolean);
  return [
    `${group.provider} (${state})${notices.length ? `; ${notices.join("; ")}` : ""}`,
    ...group.results.map((result) => JSON.stringify(result)),
  ].join("\n");
}

function aborted(signal: AbortSignal): Error {
  return new Error(
    signal.reason === "deadline"
      ? "package_search timed out."
      : "package_search was cancelled.",
  );
}

function repositoryFieldsWereShortened(
  repository: Record<string, unknown>,
): boolean {
  return [
    [repository.description, 400],
    [repository.language, LIMITS.languageChars],
    [repository.updated_at, LIMITS.dateChars],
    [repository.pushed_at, LIMITS.dateChars],
    [object(repository.license)?.spdx_id, LIMITS.languageChars],
  ].some(
    ([value, maximum]) =>
      typeof value === "string" && value.length > Number(maximum),
  );
}

function strictText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    !hasControl(value) &&
    value.length <= maximum
    ? value.trim() || undefined
    : undefined;
}

function errorGroup(provider: Provider, error: unknown): Group<never> {
  const npmKind = provider === "npm" ? npmErrorKind(error) : undefined;
  const message =
    provider === "documentation"
      ? "Documentation search failed."
      : error instanceof Error
        ? error.message
        : `${provider} search failed.`;
  return {
    provider,
    status: "error",
    results: [],
    ...(npmKind ? { errorKind: npmKind } : {}),
    error: boundedError(message),
  };
}

function npmErrorKind(
  error: unknown,
): "unavailable" | "malformed" | "oversized" | undefined {
  if (!(error instanceof NpmError)) {
    return undefined;
  }
  switch (error.kind) {
    case "unavailable":
    case "malformed":
    case "oversized":
      return error.kind;
    default:
      return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && !hasControl(value)
    ? boundedText(value, maximum) || undefined
    : undefined;
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function canonicalGithubUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 500 ||
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
      /^\/[^/]+\/[^/]+\/?$/.test(url.pathname)
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}
