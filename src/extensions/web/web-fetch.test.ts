import { describe, expect, it, vi } from "vitest";
import { extractHtml } from "./extraction.js";
import { normalizeInput } from "./schema.js";
import { createInvocationDeadline, type WebTransport } from "./transport.js";
import { executeWebFetch } from "./web-fetch.js";

function page(url: string, contentType: string, body: string): Response {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("web_fetch", () => {
  it("renders validated JSON without extraction and keeps body out of details", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/data", "application/json", '{"answer":42}'),
    };

    const result = await executeWebFetch(
      { url: "https://example.com/data", format: "markdown" },
      undefined,
      undefined,
      { transport },
    );

    expect(result.content[0]?.text).toContain(
      '```json\n{\n  "answer": 42\n}\n```',
    );
    expect(result.content[0]?.text).toMatch(
      /^Requested URL: https:\/\/example\.com\/data/,
    );
    expect(JSON.stringify(result.details)).not.toContain("answer");
  });

  it("extracts readable HTML as markdown without changing global console", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page(
          "https://example.com/post",
          "text/html",
          "<html><head><title>Example</title></head><body><article><h1>Heading</h1><p>Readable page text.</p></article></body></html>",
        ),
    };
    const previousConsoleError = console.error;

    const result = await executeWebFetch(
      { url: "https://example.com/post" },
      undefined,
      undefined,
      { transport },
    );

    expect(result.content[0]?.text).toContain("# Heading");
    expect(result.content[0]?.text).toContain("Readable page text.");
    expect(console.error).toBe(previousConsoleError);
  });

  it("uses bounded extraction metadata and discloses semantic truncation", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/post", "text/html", "<main>ignored</main>"),
    };
    const result = await executeWebFetch(
      { url: "https://example.com/post", maxChars: 4 },
      undefined,
      undefined,
      {
        transport,
        extractHtml: async () => ({
          content: "readable content",
          title: "Example title",
          site: "Example",
          alternates: [],
        }),
      },
    );

    expect(result.content[0]?.text).toContain("Title: Example title");
    expect(result.content[0]?.text).toContain(
      "[Content truncated to requested maxChars",
    );
    expect(result.content[0]?.text).toContain("read");
    expect(result.details).toMatchObject({
      title: "Example title",
      semanticTruncated: true,
    });
    expect(JSON.stringify(result.details)).not.toContain("readable content");
  });

  it("follows one qualified JSON alternate without invoking extraction", async () => {
    const fetch = vi
      .fn<WebTransport["fetch"]>()
      .mockResolvedValueOnce(
        page(
          "https://example.com",
          "text/html",
          '<link rel="alternate" type="application/json" href="/data.json">',
        ),
      )
      .mockResolvedValueOnce(
        page(
          "https://example.com/data.json",
          "application/json",
          '{"ok":true}',
        ),
      );
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch,
    };

    const result = await executeWebFetch(
      { url: "https://example.com", format: "json" },
      undefined,
      undefined,
      { transport },
    );

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://example.com/data.json",
      undefined,
      undefined,
      expect.anything(),
    );
    expect(result.content[0]?.text).toContain('"ok": true');
    expect(result.details).toMatchObject({ alternateAttempts: 1 });
  });

  it("rejects unsupported and attachment media without returning decoded bytes", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/file", "application/octet-stream", "secret"),
    };

    await expect(
      executeWebFetch(
        { url: "https://example.com/file", format: "text" },
        undefined,
        undefined,
        { transport },
      ),
    ).rejects.toThrow("readable textual content");
  });

  it("rejects script-only fallback content as JavaScript-required", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () => page("https://example.com", "text/plain", "unused"),
    };
    const deadline = createInvocationDeadline();

    try {
      await expect(
        extractHtml(
          "<html><body><script>loadApplication()</script><style>.app { color: red }</style><noscript>Enable JavaScript</noscript></body></html>",
          "https://example.com",
          normalizeInput({ url: "https://example.com" }),
          { transport, deadline },
        ),
      ).rejects.toThrow("may require JavaScript");
    } finally {
      deadline.dispose();
    }
  });

  it("reserves the final truncation notice under byte and line ceilings", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () =>
        page("https://example.com/post", "text/html", "<main>ignored</main>"),
    };
    const result = await executeWebFetch(
      { url: "https://example.com/post" },
      undefined,
      undefined,
      {
        transport,
        extractHtml: async () => ({
          content: "line\n".repeat(20_000),
          alternates: [],
        }),
      },
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain(
      "[Final output truncated to 48 KiB or 1,900 lines.]",
    );
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(48 * 1024);
    expect(text.split("\n").length).toBeLessThanOrEqual(1_900);
  });
});
