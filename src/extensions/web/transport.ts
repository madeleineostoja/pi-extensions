import { fetch as browserFetch, getProfiles } from "wreq-js";
import {
  assertActive,
  composeSignal,
  createDeadline,
  type Deadline,
} from "./cancellation.js";
import { LIMITS } from "./constants.js";
import { abortReason, WebError } from "./errors.js";
import { normalizeRequest, type ControlledRequest } from "./request.js";
import { boundedResponse, header, type BrowserResponse } from "./response.js";
import { resolvePublicTarget, type Resolver } from "./resolver.js";
import { canonicalTarget } from "./target.js";

export type BrowserProfile = { browser: string; os: "windows" };
export type BrowserRequest = {
  method: ControlledRequest["method"];
  headers: Record<string, string>;
  body?: Uint8Array;
  redirect: "manual";
  browser: string;
  os: "windows";
  timeout: number;
  signal: AbortSignal;
};
export type BrowserFetch = (
  url: string,
  init: BrowserRequest,
) => Promise<BrowserResponse>;

type TransportDependencies = {
  resolver?: Resolver;
  browserFetch?: BrowserFetch;
  profiles?: readonly string[];
};

export type WebTransport = {
  profile: BrowserProfile;
  fetch: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    parentSignal: AbortSignal | undefined,
    deadline: Deadline,
  ) => Promise<Response>;
};

export function selectBrowserProfile(
  profiles: readonly string[],
): BrowserProfile {
  const selected = profiles
    .map((profile) => ({
      profile,
      version: /^chrome_(\d+)$/u.exec(profile)?.[1],
    }))
    .filter((candidate): candidate is { profile: string; version: string } =>
      Boolean(candidate.version),
    )
    .sort((left, right) => Number(right.version) - Number(left.version))[0];
  if (!selected) {
    throw new WebError(
      "network",
      "Web Fetch needs a supported wreq-js Chrome profile, but none is available.",
    );
  }
  return { browser: selected.profile, os: "windows" };
}

export function createWebTransport(
  dependencies: TransportDependencies = {},
): WebTransport {
  const profile = selectBrowserProfile(dependencies.profiles ?? getProfiles());
  const resolve = (
    target: ReturnType<typeof canonicalTarget>,
    signal: AbortSignal,
  ) => resolvePublicTarget(target, signal, dependencies.resolver);
  const send: BrowserFetch =
    dependencies.browserFetch ??
    (async (url, init) =>
      browserFetch(url, init as never) as unknown as Promise<BrowserResponse>);

  return {
    profile,
    async fetch(input, init, parentSignal, deadline) {
      const requestSignal = input instanceof Request ? input.signal : undefined;
      const composed = composeSignal([
        parentSignal,
        requestSignal,
        init?.signal ?? undefined,
        deadline.signal,
      ]);
      try {
        assertActive(deadline, composed.signal);
        let request = await normalizeRequest(input, init, composed.signal);
        for (let redirects = 0; ; redirects++) {
          assertActive(deadline, composed.signal);
          const target = await resolve(
            canonicalTarget(request.url),
            composed.signal,
          );
          assertActive(deadline, composed.signal);
          let source: BrowserResponse;
          try {
            source = await send(target.url, {
              method: request.method,
              headers: request.headers,
              ...(request.body ? { body: request.body } : {}),
              redirect: "manual",
              browser: profile.browser,
              os: profile.os,
              timeout: Math.max(1, deadline.remaining()),
              signal: composed.signal,
            });
          } catch (error) {
            if (composed.signal.aborted) {
              throw abortReason(composed.signal);
            }
            if (error instanceof WebError) {
              throw error;
            }
            throw new WebError(
              "network",
              "Web Fetch browser transport could not complete the request.",
            );
          }
          assertActive(deadline, composed.signal);
          if (!redirectStatus(source.status)) {
            const response = await boundedResponse(
              source,
              composed.signal,
              target.url,
            );
            assertActive(deadline, composed.signal);
            return response;
          }
          try {
            const location = redirectLocation(source, target.url);
            if (!location) {
              const response = await boundedResponse(
                source,
                composed.signal,
                target.url,
              );
              assertActive(deadline, composed.signal);
              return response;
            }
            if (redirects >= LIMITS.redirects) {
              throw new WebError(
                "redirect",
                "Web Fetch stopped after five HTTP redirects.",
              );
            }
            request = redirectedRequest(request, location, source.status);
          } finally {
            await source.body?.cancel().catch(() => {});
          }
        }
      } finally {
        composed.dispose();
      }
    },
  };
}

function redirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function redirectLocation(
  source: BrowserResponse,
  base: string,
): string | undefined {
  if (!redirectStatus(source.status)) {
    return undefined;
  }
  const location = header(source.headers, "location");
  if (!location) {
    return undefined;
  }
  try {
    return new URL(location, base).href;
  } catch {
    throw new WebError(
      "redirect",
      "Web Fetch received an invalid HTTP redirect target.",
    );
  }
}

function redirectedRequest(
  request: ControlledRequest,
  url: string,
  status: number,
): ControlledRequest {
  const switchToGet =
    status === 303
      ? request.method !== "HEAD"
      : (status === 301 || status === 302) && request.method === "POST";
  if (!switchToGet) {
    return { ...request, url };
  }
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(
      ([name]) => !/^content-/iu.test(name),
    ),
  );
  return { url, method: "GET", headers };
}

export function createInvocationDeadline(
  timeoutMs: number = LIMITS.defaultTimeoutMs,
): Deadline {
  return createDeadline(timeoutMs);
}
