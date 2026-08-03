import { LIMITS, boundedError, hasControl } from "./bounds.js";

export const CONTEXT7_ORIGIN = "https://context7.com";
const SEARCH_PATH = "/api/v2/libs/search";
const CONTEXT_PATH = "/api/v2/context";

type Fetch = typeof fetch;
type SafeResponse = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

export class Context7Error extends Error {
  constructor(
    readonly kind:
      | "not-found"
      | "version-unavailable"
      | "empty"
      | "auth"
      | "not-ready"
      | "transient"
      | "malformed"
      | "oversized"
      | "timeout"
      | "cancelled"
      | "redirect",
    message: string,
  ) {
    super(boundedError(message));
    this.name = "Context7Error";
  }
}

export type Context7Id = { id: string; pin?: string };
export type Context7Candidate = {
  id: string;
  title: string;
  description?: string;
  rank?: number;
  versions: Array<{ label: string; id?: string }>;
  quality?: { trustScore?: number; totalSnippets?: number };
  truncations?: string[];
};
export type Context7Snippet = {
  text: string;
  title?: string;
  language?: string;
  location?: string;
};
export type Context7Document = {
  snippets: Context7Snippet[];
  redirectId?: string;
  truncations?: string[];
};
export type Context7Transport = {
  search(
    subject: string,
    question: string,
    limit?: number,
  ): Promise<Context7Candidate[]>;
  context(id: string, question: string): Promise<Context7Document>;
  retries: number;
  dispose(): void;
};

export function createContext7Transport(options: {
  fetch?: Fetch;
  token?: string;
  signal?: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Context7Transport {
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const deadline = now() + (options.deadlineMs ?? LIMITS.deadlineMs);
  let retries = 0;
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, deadline - now()),
  );
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const request = async (
    path: string,
    query: Record<string, string>,
    acceptsLogicalRedirect = false,
  ) => {
    const url = new URL(path, CONTEXT7_ORIGIN);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return requestJson(url, {
      fetch: options.fetch ?? fetch,
      token: options.token,
      signal: controller.signal,
      deadline,
      now,
      sleep: options.sleep ?? defaultSleep,
      onRetry: () => retries++,
      acceptsLogicalRedirect,
    });
  };
  return {
    async search(subject, question, limit: number = LIMITS.candidates) {
      return parseSearch(
        await request(SEARCH_PATH, { libraryName: subject, query: question }),
        limit,
      );
    },
    async context(id, question) {
      return parseContext(
        await request(
          CONTEXT_PATH,
          { libraryId: id, query: question, type: "json" },
          true,
        ),
      );
    },
    get retries() {
      return retries;
    },
    dispose() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.abort();
    },
  };
}

async function requestJson(
  initialUrl: URL,
  options: {
    fetch: Fetch;
    token?: string;
    signal: AbortSignal;
    deadline: number;
    now: () => number;
    sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    onRetry: () => void;
    acceptsLogicalRedirect: boolean;
  },
): Promise<unknown> {
  let url = initialUrl;
  let redirects = 0;
  let attempts = 0;
  while (true) {
    if (options.signal.aborted) {
      throw abortError(options.deadline, options.now);
    }
    let response: SafeResponse;
    try {
      response = await fetchWithAbort(
        options.fetch,
        url,
        {
          method: "GET",
          redirect: "manual",
          signal: options.signal,
          headers:
            options.token && url.origin === CONTEXT7_ORIGIN
              ? { authorization: `Bearer ${options.token}` }
              : {},
        },
        options.signal,
      );
    } catch {
      if (options.signal.aborted) {
        throw abortError(options.deadline, options.now);
      }
      throw new Context7Error(
        "transient",
        "Context7 is temporarily unavailable.",
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location) {
        if (redirects >= LIMITS.httpRedirects) {
          throw new Context7Error(
            "redirect",
            "Context7 returned too many or an invalid HTTP redirect.",
          );
        }
        const next = new URL(location, url);
        if (
          next.origin !== CONTEXT7_ORIGIN ||
          next.protocol !== "https:" ||
          next.pathname !== initialUrl.pathname
        ) {
          throw new Context7Error(
            "redirect",
            "Context7 redirected outside its fixed documentation endpoint.",
          );
        }
        url = next;
        redirects++;
        continue;
      }
      if (response.status === 301 && options.acceptsLogicalRedirect) {
        return parseJson(
          await readBounded(
            response,
            options.signal,
            options.deadline,
            options.now,
          ),
        );
      }
      throw new Context7Error(
        "redirect",
        "Context7 returned too many or an invalid HTTP redirect.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Context7Error(
        "auth",
        "Context7 authentication or permission was rejected.",
      );
    }
    if (response.status === 404) {
      throw new Context7Error(
        "not-found",
        "Context7 did not find this documentation library.",
      );
    }
    if (response.status === 422) {
      throw new Context7Error(
        "not-ready",
        "Context7 could not process this documentation request.",
      );
    }
    if (
      response.status === 202 ||
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599)
    ) {
      if (attempts < LIMITS.retries) {
        attempts++;
        options.onRetry();
        try {
          await options.sleep(retryDelay(response), options.signal);
        } catch {
          if (options.signal.aborted) {
            throw abortError(options.deadline, options.now);
          }
          throw new Context7Error("transient", "Context7 retry wait failed.");
        }
        if (options.signal.aborted) {
          throw abortError(options.deadline, options.now);
        }
        continue;
      }
      const kind = response.status === 202 ? "not-ready" : "transient";
      throw new Context7Error(
        kind,
        kind === "not-ready"
          ? "Context7 documentation is not ready after bounded retries."
          : "Context7 rate limiting or transient failure exhausted bounded retries.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Context7Error(
        "malformed",
        "Context7 returned an unsupported documentation response.",
      );
    }
    return parseJson(
      await readBounded(
        response,
        options.signal,
        options.deadline,
        options.now,
      ),
    );
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Context7Error(
      "malformed",
      "Context7 returned malformed documentation data.",
    );
  }
}

async function readBounded(
  response: SafeResponse,
  signal: AbortSignal,
  deadline: number,
  now: () => number,
): Promise<string> {
  if (Number(response.headers.get("content-length")) > LIMITS.responseBytes) {
    throw new Context7Error(
      "oversized",
      "Context7 response exceeded the supported size limit.",
    );
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw abortError(deadline, now);
      }
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await readWithAbort(reader, signal);
      } catch {
        if (signal.aborted) {
          throw abortError(deadline, now);
        }
        throw new Context7Error(
          "malformed",
          "Context7 documentation stream could not be read.",
        );
      }
      if (next.done) {
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > LIMITS.responseBytes) {
        await reader.cancel();
        throw new Context7Error(
          "oversized",
          "Context7 response exceeded the supported size limit.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      concat(chunks, bytes),
    );
  } catch {
    throw new Context7Error(
      "malformed",
      "Context7 returned malformed documentation data.",
    );
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader
        .cancel()
        .finally(() => reject(new DOMException("Aborted", "AbortError")));
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

function fetchWithAbort(
  fetcher: Fetch,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    fetcher(url, init).then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function concat(chunks: Uint8Array[], bytes: number): Uint8Array {
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}
function retryDelay(response: SafeResponse): number {
  const raw = response.headers.get("retry-after");
  const seconds = raw && /^\d+$/.test(raw) ? Number(raw) * 1_000 : 50;
  return Math.min(LIMITS.retryAfterMs, Math.max(0, seconds));
}
function abortError(deadline: number, now: () => number): Context7Error {
  return now() >= deadline
    ? new Context7Error("timeout", "Context7 documentation request timed out.")
    : new Context7Error(
        "cancelled",
        "Context7 documentation request was cancelled.",
      );
}
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseSearch(
  value: unknown,
  limit: number = LIMITS.candidates,
): Context7Candidate[] {
  const root = object(value);
  const results = array(root?.results ?? root?.libraries ?? value);
  if (!results) {
    throw malformedSearch();
  }
  const candidates: Context7Candidate[] = [];
  const resultsTruncated = results.length > limit;
  for (const [index, item] of results.slice(0, limit).entries()) {
    const candidate = object(item);
    const id = candidate && requiredId(candidate.id ?? candidate.libraryId);
    const title =
      candidate &&
      requiredText(candidate.title ?? candidate.name, LIMITS.fieldChars);
    if (!candidate || !id || !title) {
      throw malformedSearch();
    }
    const truncations: string[] = [];
    if (index === 0 && resultsTruncated) {
      truncations.push("Additional Context7 library results were omitted.");
    }
    if (title.truncated) {
      truncations.push("A provider library title was truncated.");
    }
    const description =
      candidate.description === undefined
        ? undefined
        : optionalText(
            candidate.description,
            LIMITS.fieldChars,
            truncations,
            "description",
          );
    if (description === false) {
      throw malformedSearch();
    }
    const quality = parseQuality(candidate, truncations);
    const rawVersions = candidate.versions;
    if (rawVersions !== undefined && !array(rawVersions)) {
      throw malformedSearch();
    }
    const versionValues = (array(rawVersions) ?? []).slice(
      0,
      LIMITS.advertisedVersions,
    );
    if ((array(rawVersions)?.length ?? 0) > LIMITS.advertisedVersions) {
      truncations.push("Additional advertised Context7 versions were omitted.");
    }
    const versions = versionValues.map((raw) => parseVersion(raw, truncations));
    candidates.push({
      id: id.id,
      title: title.value,
      ...(description ? { description } : {}),
      rank: index + 1,
      versions,
      ...(quality ? { quality } : {}),
      truncations,
    });
  }
  return candidates;
}

function parseQuality(
  candidate: Record<string, unknown>,
  truncations: string[],
): { trustScore?: number; totalSnippets?: number } | undefined {
  const raw = object(candidate.trustScore) ? candidate.trustScore : candidate;
  const source = object(raw) ?? candidate;
  const trustScore = number(source.trustScore ?? source.score);
  const totalSnippets = number(source.totalSnippets);
  if (trustScore === false || totalSnippets === false) {
    throw malformedSearch();
  }
  if (trustScore === undefined && totalSnippets === undefined) {
    return undefined;
  }
  if (trustScore !== undefined && !Number.isFinite(trustScore)) {
    truncations.push("An invalid Context7 quality signal was omitted.");
  }
  return {
    ...(typeof trustScore === "number" && Number.isFinite(trustScore)
      ? { trustScore }
      : {}),
    ...(typeof totalSnippets === "number" && Number.isFinite(totalSnippets)
      ? { totalSnippets }
      : {}),
  };
}
function number(value: unknown): number | false | undefined {
  return value === undefined
    ? undefined
    : typeof value === "number"
      ? value
      : false;
}

function parseVersion(
  value: unknown,
  truncations: string[],
): { label: string; id?: string } {
  if (typeof value === "string") {
    const label = requiredText(value, LIMITS.versionChars);
    if (!label) {
      throw malformedSearch();
    }
    if (label.truncated) {
      truncations.push("An advertised Context7 version was truncated.");
    }
    return { label: label.value };
  }
  const entry = object(value);
  const label =
    entry &&
    requiredText(entry.version ?? entry.name ?? entry.id, LIMITS.versionChars);
  if (!entry || !label) {
    throw malformedSearch();
  }
  const id = entry.id === undefined ? undefined : requiredId(entry.id);
  if (entry.id !== undefined && !id) {
    throw malformedSearch();
  }
  if (label.truncated) {
    truncations.push("An advertised Context7 version was truncated.");
  }
  return { label: label.value, ...(id ? { id: id.id } : {}) };
}

function parseContext(value: unknown): Context7Document {
  const root = object(value);
  if (!root) {
    throw malformedContext();
  }
  const rawCode = root.codeSnippets;
  const rawInfo = root.infoSnippets;
  if (
    (rawCode !== undefined && !array(rawCode)) ||
    (rawInfo !== undefined && !array(rawInfo))
  ) {
    throw malformedContext();
  }
  const truncations: string[] = [];
  const snippets = [
    ...parseCodeSnippets(array(rawCode) ?? [], truncations),
    ...parseInfoSnippets(array(rawInfo) ?? [], truncations),
  ];
  const redirectRaw = root.redirectUrl;
  if (redirectRaw !== undefined && typeof redirectRaw !== "string") {
    throw malformedContext();
  }
  const redirect =
    redirectRaw === undefined ? undefined : parseContext7Id(redirectRaw);
  if (redirectRaw !== undefined && !redirect) {
    throw malformedContext();
  }
  return {
    snippets,
    ...(redirect ? { redirectId: redirect.id } : {}),
    truncations,
  };
}

function parseCodeSnippets(
  raw: unknown[],
  truncations: string[],
): Context7Snippet[] {
  if (raw.length > LIMITS.codeSnippetContainers) {
    truncations.push(
      "Additional Context7 code snippet containers were omitted.",
    );
  }
  const snippets: Context7Snippet[] = [];
  for (const item of raw.slice(0, LIMITS.codeSnippetContainers)) {
    const entry = object(item);
    const title =
      entry &&
      optionalText(
        entry.codeTitle,
        LIMITS.fieldChars,
        truncations,
        "code title",
      );
    const language =
      entry &&
      optionalText(
        entry.codeLanguage,
        LIMITS.languageChars,
        truncations,
        "code language",
      );
    const codeList = entry && array(entry.codeList);
    if (!entry || !codeList || title === false || language === false) {
      throw malformedContext();
    }
    if (codeList.length > LIMITS.codeEntries) {
      truncations.push("Additional Context7 code entries were omitted.");
    }
    for (const codeItem of codeList.slice(0, LIMITS.codeEntries)) {
      if (snippets.length >= LIMITS.normalizedCodeSnippets) {
        truncations.push("Additional Context7 code snippets were omitted.");
        return snippets;
      }
      const code = object(codeItem);
      const text = code && requiredText(code.code, LIMITS.snippetChars);
      const location =
        code &&
        optionalText(
          code.codeId,
          LIMITS.urlChars,
          truncations,
          "code source identifier",
        );
      if (!code || !text || location === false) {
        throw malformedContext();
      }
      if (text.truncated) {
        truncations.push("A Context7 code snippet was truncated.");
      }
      snippets.push({
        text: text.value,
        ...(title ? { title } : {}),
        ...(language ? { language } : {}),
        ...(location ? { location } : {}),
      });
    }
  }
  return snippets;
}

function parseInfoSnippets(
  raw: unknown[],
  truncations: string[],
): Context7Snippet[] {
  if (raw.length > LIMITS.infoSnippetContainers) {
    truncations.push("Additional Context7 information snippets were omitted.");
  }
  const snippets: Context7Snippet[] = [];
  for (const item of raw.slice(0, LIMITS.infoSnippetContainers)) {
    if (snippets.length >= LIMITS.normalizedInfoSnippets) {
      truncations.push(
        "Additional Context7 information snippets were omitted.",
      );
      break;
    }
    const entry = object(item);
    const text = entry && requiredText(entry.content, LIMITS.snippetChars);
    const title =
      entry &&
      optionalText(
        entry.breadcrumb,
        LIMITS.fieldChars,
        truncations,
        "information breadcrumb",
      );
    const location =
      entry &&
      optionalText(
        entry.pageId,
        LIMITS.urlChars,
        truncations,
        "information source identifier",
      );
    if (!entry || !text || title === false || location === false) {
      throw malformedContext();
    }
    if (text.truncated) {
      truncations.push("A Context7 information snippet was truncated.");
    }
    snippets.push({
      text: text.value,
      ...(title ? { title } : {}),
      ...(location ? { location } : {}),
    });
  }
  return snippets;
}

function requiredId(value: unknown): Context7Id | undefined {
  return typeof value === "string" ? parseContext7Id(value) : undefined;
}

export function parseContext7Id(value: string): Context7Id | undefined {
  if (
    value.length === 0 ||
    value.length > LIMITS.idChars ||
    hasControl(value) ||
    /\s|[?#]/.test(value) ||
    !value.startsWith("/")
  ) {
    return undefined;
  }
  const parts = value.slice(1).split("/");
  if (parts.length < 2) {
    return undefined;
  }
  const final = parts.at(-1)!;
  const at = final.indexOf("@");
  if (
    !parts
      .slice(0, -1)
      .every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
    !(at >= 0
      ? /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(final)
      : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(final))
  ) {
    return undefined;
  }
  if (at >= 0) {
    const library = final.slice(0, at);
    const version = final.slice(at + 1);
    if (
      !library ||
      !validVersionPart(version) ||
      final.indexOf("@", at + 1) >= 0
    ) {
      return undefined;
    }
    return { id: value, pin: normalizeVersion(version) };
  }
  const pin =
    parts.length === 3 && validSlashVersion(final)
      ? normalizeVersion(final)
      : undefined;
  return { id: value, ...(pin ? { pin } : {}) };
}

export function validId(value: string): boolean {
  return parseContext7Id(value) !== undefined;
}

function validSlashVersion(value: string): boolean {
  return value === "latest" || /^v?\d[A-Za-z0-9._-]*$/i.test(value);
}
function validVersionPart(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
function normalizeVersion(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/^v/, "")
    .replaceAll("_", ".");
}
function requiredText(
  value: unknown,
  maximum: number,
): { value: string; truncated: boolean } | undefined {
  return typeof value === "string" ? normalizedText(value, maximum) : undefined;
}
function optionalText(
  value: unknown,
  maximum: number,
  truncations: string[],
  name: string,
): string | false | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = requiredText(value, maximum);
  if (!text) {
    return false;
  }
  if (text.truncated) {
    truncations.push(`A Context7 ${name} was truncated.`);
  }
  return text.value;
}
function normalizedText(
  value: string,
  maximum: number,
): { value: string; truncated: boolean } | undefined {
  const normalized = [...value]
    .map((character) =>
      character === "\r"
        ? "\n"
        : character === "\n" || character === "\t" || !hasControl(character)
          ? character
          : " ",
    )
    .join("")
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
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
function malformedSearch(): Context7Error {
  return new Context7Error(
    "malformed",
    "Context7 returned malformed library search data.",
  );
}
function malformedContext(): Context7Error {
  return new Context7Error(
    "malformed",
    "Context7 returned malformed documentation data.",
  );
}
