import { Octokit } from "@octokit/rest";
import { LIMITS, boundedError } from "./bounds.js";

export const GITHUB_ORIGIN = "https://api.github.com";
const SAFE_HEADERS = new Set([
  "content-length",
  "content-type",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "retry-after",
]);

type Fetch = typeof fetch;
type RepositorySearch = Parameters<Octokit["rest"]["search"]["repos"]>[0];
type CodeSearch = Parameters<Octokit["rest"]["search"]["code"]>[0];

export class GithubError extends Error {
  constructor(
    readonly kind: "auth" | "provider" | "oversized" | "timeout" | "cancelled",
    message: string,
  ) {
    super(boundedError(message));
    this.name = "GithubError";
  }
}

export type GithubSearchClient = {
  searchRepositories(
    options: RepositorySearch,
  ): ReturnType<Octokit["rest"]["search"]["repos"]>;
  searchCode(
    options: CodeSearch,
  ): ReturnType<Octokit["rest"]["search"]["code"]>;
};

export function createGithubSearch(options: {
  token: string | undefined;
  signal: AbortSignal;
  fetch?: Fetch;
}): GithubSearchClient {
  if (!options.token) {
    throw new GithubError(
      "auth",
      "GitHub search requires a configured GitHub credential.",
    );
  }
  const octokit = new Octokit({
    auth: options.token,
    baseUrl: GITHUB_ORIGIN,
    request: {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      fetch: createGithubFetch(options.fetch ?? fetch),
      signal: options.signal,
      redirect: "manual",
    },
  });
  return {
    searchRepositories: (request) => {
      const options = request!;
      return octokit.rest.search.repos({
        q: options.q!,
        per_page: options.per_page,
        request: { signal: options.request?.signal },
        headers: { "x-github-api-version": "2022-11-28" },
      } as RepositorySearch);
    },
    searchCode: (request) => {
      const options = request!;
      return octokit.rest.search.code({
        q: options.q!,
        per_page: options.per_page,
        mediaType: { format: "text-match" },
        request: { signal: options.request?.signal },
        headers: { "x-github-api-version": "2022-11-28" },
      } as CodeSearch);
    },
  };
}

export function createGithubFetch(fetcher: Fetch): Fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== GITHUB_ORIGIN || url.protocol !== "https:") {
      throw new GithubError(
        "provider",
        "GitHub request used an invalid origin.",
      );
    }
    if (request.signal.aborted) {
      throw cancelled(request.signal);
    }
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        redirect: "manual",
      });
    } catch {
      if (request.signal.aborted) {
        throw cancelled(request.signal);
      }
      throw new GithubError(
        "provider",
        "GitHub search is temporarily unavailable.",
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new GithubError(
        "provider",
        "GitHub search returned an unsupported redirect.",
      );
    }
    if (Number(response.headers.get("content-length")) > LIMITS.responseBytes) {
      await response.body?.cancel();
      throw new GithubError(
        "oversized",
        "GitHub response exceeded the supported size limit.",
      );
    }
    const headers = new Headers();
    for (const [name, value] of response.headers) {
      if (SAFE_HEADERS.has(name.toLocaleLowerCase())) {
        headers.set(name, value);
      }
    }
    return new Response(boundBody(response.body, request.signal), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function boundBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    return null;
  }
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream({
    async pull(controller) {
      if (signal.aborted) {
        await reader.cancel();
        controller.error(cancelled(signal));
        return;
      }
      try {
        const next = await readWithAbort(reader, signal);
        if (next.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        bytes += next.value.byteLength;
        if (bytes > LIMITS.responseBytes) {
          await reader.cancel();
          controller.error(
            new GithubError(
              "oversized",
              "GitHub response exceeded the supported size limit.",
            ),
          );
          return;
        }
        controller.enqueue(next.value);
      } catch {
        controller.error(
          signal.aborted
            ? cancelled(signal)
            : new GithubError("provider", "GitHub response could not be read."),
        );
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(cancelled(signal));
      void reader.cancel();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancelled(signal: AbortSignal): GithubError {
  return new GithubError(
    signal.reason === "deadline" ? "timeout" : "cancelled",
    signal.reason === "deadline"
      ? "GitHub search timed out."
      : "GitHub search was cancelled.",
  );
}

export function normalizeGithubError(error: unknown): Error {
  if (error instanceof GithubError) {
    return error;
  }
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const headers = safeErrorHeaders(error);
  const remaining = headers["x-ratelimit-remaining"];
  if (status === 429 || (status === 403 && remaining === "0")) {
    const retryAfter = boundedRateLimitFact(
      headers["retry-after"],
      "retry after",
    );
    const reset = boundedRateLimitFact(
      headers["x-ratelimit-reset"],
      "resets at",
    );
    return new GithubError(
      "provider",
      `GitHub search is rate limited.${retryAfter ?? reset ?? ""}`,
    );
  }
  if (status === 401 || status === 403) {
    return new GithubError(
      "auth",
      "GitHub authentication or permission was rejected.",
    );
  }
  if (status === 422) {
    return new GithubError("provider", "GitHub rejected this search query.");
  }
  return new GithubError("provider", "GitHub search failed.");
}

function safeErrorHeaders(error: unknown): Record<string, string> {
  const headers =
    error && typeof error === "object" && "response" in error
      ? (error as { response?: { headers?: unknown } }).response?.headers
      : undefined;
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : headers && typeof headers === "object"
        ? Object.entries(headers)
        : [];
  return Object.fromEntries(
    entries.flatMap(([name, value]) => {
      const normalized = name.toLocaleLowerCase();
      return SAFE_HEADERS.has(normalized) && typeof value === "string"
        ? [[normalized, value.slice(0, 64)]]
        : [];
    }),
  );
}

function boundedRateLimitFact(
  value: string | undefined,
  label: string,
): string | undefined {
  return value && /^[0-9]{1,16}$/.test(value)
    ? ` ${label} ${value}.`
    : undefined;
}
