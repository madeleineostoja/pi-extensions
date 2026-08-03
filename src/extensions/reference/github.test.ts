import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "./bounds.js";
import {
  GithubError,
  createGithubFetch,
  createGithubSearch,
  normalizeGithubError,
} from "./github.js";

describe("GitHub fixed fetch adapter", () => {
  it("allows only the API origin, preserves auth for it, and rejects redirects", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    const adapter = createGithubFetch(fetcher as typeof fetch);
    await adapter(
      new Request("https://api.github.com/search/repositories", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    const [url, init] = (
      fetcher.mock.calls as unknown as Array<[URL, RequestInit]>
    )[0]!;
    expect(url.origin).toBe("https://api.github.com");
    expect((init.headers as Headers).get("authorization")).toBe(
      "Bearer secret",
    );
    await expect(
      adapter("https://github.com/search" as RequestInfo),
    ).rejects.toBeInstanceOf(GithubError);
    await expect(
      createGithubFetch(
        vi.fn(async () => new Response("", { status: 302 })) as typeof fetch,
      )("https://api.github.com/search/code" as RequestInfo),
    ).rejects.toThrow("redirect");
  });

  it("uses one typed code-search request with text-match media and fixed credentials", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            total_count: 0,
            incomplete_results: false,
            items: [],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = createGithubSearch({
      token: "secret",
      signal: new AbortController().signal,
      fetch: fetcher as typeof fetch,
    });
    await client.searchCode({
      q: "useWidget",
      per_page: 1,
      mediaType: { format: "text-match" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/search/code");
    expect(url.searchParams.get("q")).toBe("useWidget");
    expect((init.headers as Headers).get("accept")).toContain("text-match");
    expect((init.headers as Headers).get("authorization")).toBe("token secret");
    expect((init.headers as Headers).get("x-github-api-version")).toBe(
      "2022-11-28",
    );
  });

  it("normalizes exhausted 403 rate limits without disclosing headers", () => {
    expect(
      normalizeGithubError({
        status: 403,
        response: {
          headers: {
            "x-ratelimit-remaining": "0",
            "retry-after": "60",
            authorization: "token secret",
          },
        },
      }).message,
    ).toBe("GitHub search is rate limited. retry after 60.");
    expect(normalizeGithubError({ status: 403 }).message).toContain(
      "authentication or permission",
    );
  });

  it("enforces the raw response limit before a consumer parses JSON", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LIMITS.responseBytes + 1));
        controller.close();
      },
    });
    const response = await createGithubFetch(
      vi.fn(async () => new Response(body)) as typeof fetch,
    )("https://api.github.com/search/code" as RequestInfo);
    await expect(response.text()).rejects.toBeInstanceOf(GithubError);
  });
});
