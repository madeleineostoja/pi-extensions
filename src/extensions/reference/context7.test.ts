import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "./bounds.js";
import { Context7Error, createContext7Transport } from "./context7.js";

const response = (body: string, status = 200, headers?: HeadersInit) =>
  new Response(body, { status, headers });

describe("Context7 fixed transport", () => {
  it("does not issue an auth-bound request for a pre-cancelled caller", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const fetcher = vi.fn();
    const client = createContext7Transport({
      fetch: fetcher as typeof fetch,
      token: "secret",
      signal: controller.signal,
    });
    await expect(client.search("widget", "question")).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(fetcher).not.toHaveBeenCalled();
    client.dispose();
  });

  it("uses fixed endpoints and origin-scoped bearer authorization", async () => {
    const fetcher = vi.fn(async () =>
      response(
        JSON.stringify({ results: [{ id: "/acme/widget", title: "Widget" }] }),
      ),
    );
    const client = createContext7Transport({
      fetch: fetcher as typeof fetch,
      token: "secret",
    });
    await client.search("widget", "question");
    const [url, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];

    expect(url.origin + url.pathname).toBe(
      "https://context7.com/api/v2/libs/search",
    );
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
    client.dispose();
  });

  it("rejects cross-origin redirects without forwarding authorization", async () => {
    const fetcher = vi.fn(async () =>
      response("", 302, { location: "https://elsewhere.invalid/docs" }),
    );
    const client = createContext7Transport({
      fetch: fetcher as typeof fetch,
      token: "secret",
    });
    await expect(client.search("widget", "question")).rejects.toMatchObject({
      kind: "redirect",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("retries only documented status responses within a cap", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response("", 429, { "retry-after": "999" }))
      .mockResolvedValueOnce(response(JSON.stringify({ results: [] })));
    const sleep = vi.fn(async () => {});
    const client = createContext7Transport({
      fetch: fetcher as typeof fetch,
      sleep,
    });
    await client.search("widget", "question");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(
      LIMITS.retryAfterMs,
      expect.any(AbortSignal),
    );
    expect(client.retries).toBe(1);
    client.dispose();
  });

  it("classifies abort while waiting to retry without starting another fetch", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => response("", 429));
    const client = createContext7Transport({
      fetch: fetcher as typeof fetch,
      signal: controller.signal,
      sleep: async (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        }),
    });
    await expect(client.search("widget", "question")).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("parses documented code and information snippets without losing multiline material", async () => {
    const fetcher = vi.fn(async () =>
      response(
        JSON.stringify({
          codeSnippets: [
            {
              codeTitle: "Install",
              codeLanguage: "ts",
              codeId: "install",
              codeList: [
                { code: "const x = 1;\n\tuse(x)" },
                { code: "const y = 2;\n\tuse(y)" },
              ],
            },
          ],
          infoSnippets: [
            { breadcrumb: "Guide", content: "First\nsecond", pageId: "guide" },
          ],
        }),
      ),
    );
    const client = createContext7Transport({ fetch: fetcher as typeof fetch });
    await expect(
      client.context("/acme/widget", "question"),
    ).resolves.toMatchObject({
      snippets: [
        {
          title: "Install",
          language: "ts",
          location: "install",
          text: "const x = 1;\n\tuse(x)",
        },
        {
          title: "Install",
          language: "ts",
          location: "install",
          text: "const y = 2;\n\tuse(y)",
        },
        { title: "Guide", location: "guide", text: "First\nsecond" },
      ],
    });
    client.dispose();
  });

  it("distinguishes malformed documented snippet containers from empty documentation", async () => {
    const malformed = createContext7Transport({
      fetch: vi.fn(async () =>
        response(JSON.stringify({ codeSnippets: [{}] })),
      ) as typeof fetch,
    });
    await expect(
      malformed.context("/acme/widget", "question"),
    ).rejects.toMatchObject({
      kind: "malformed",
    });
    malformed.dispose();

    const empty = createContext7Transport({
      fetch: vi.fn(async () =>
        response(JSON.stringify({ codeSnippets: [], infoSnippets: [] })),
      ) as typeof fetch,
    });
    await expect(
      empty.context("/acme/widget", "question"),
    ).resolves.toMatchObject({
      snippets: [],
    });
    empty.dispose();
  });

  it("stops oversized streams before parsing and reports cancellation", async () => {
    const huge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LIMITS.responseBytes + 1));
        controller.close();
      },
    });
    const fetcher = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      body: huge,
    }));
    const client = createContext7Transport({
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(client.search("widget", "question")).rejects.toMatchObject({
      kind: "oversized",
    });
    client.dispose();

    const controller = new AbortController();
    const pending = vi.fn(() => new Promise<Response>(() => {}));
    const cancelled = createContext7Transport({
      fetch: pending as typeof fetch,
      signal: controller.signal,
    });
    const work = cancelled.search("widget", "question");
    controller.abort();
    await expect(work).rejects.toMatchObject({
      kind: "cancelled",
    } satisfies Partial<Context7Error>);
    cancelled.dispose();
  });
});
