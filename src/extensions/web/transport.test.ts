import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "./constants.js";
import { canonicalTarget } from "./target.js";
import {
  createWebTransport,
  selectBrowserProfile,
  type BrowserFetch,
} from "./transport.js";

function response(
  status: number,
  headers: Record<string, string> = {},
  body = "ok",
) {
  return {
    status,
    statusText: "OK",
    url: "",
    headers: Object.entries(headers),
    body: new Response(body).body,
  };
}

describe("public target transport", () => {
  it("canonicalizes public targets and rejects localhost and non-public literal spellings", () => {
    expect(canonicalTarget("HTTP://EXAMPLE.COM./a")).toMatchObject({
      hostname: "example.com",
      url: "http://example.com/a",
    });
    for (const value of [
      "http://LOCALHOST./",
      "http://localhost..",
      "http://%6cocalhost/",
      "http://localhost%E3%80%82/",
      "http://127.1/",
      "http://0x7f000001/",
      "http://[::ffff:127.0.0.1]/",
      "http://192.168.0.1/",
      "ftp://example.com/",
      "https://user:password@example.com/",
    ]) {
      expect(() => canonicalTarget(value)).toThrow();
    }
  });

  it("denies mixed DNS answers before browser transport", async () => {
    const browser = vi.fn();
    const transport = createWebTransport({
      profiles: ["chrome_120"],
      resolver: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      browserFetch: browser,
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };

    await expect(
      transport.fetch("https://example.com", undefined, undefined, deadline),
    ).rejects.toThrow("entirely public");
    expect(browser).not.toHaveBeenCalled();
  });

  it("uses the highest Chrome/Windows profile and revalidates manual redirects", async () => {
    const browser = vi
      .fn()
      .mockResolvedValueOnce(
        response(302, { location: "https://example.org/next" }),
      )
      .mockResolvedValueOnce(
        response(200, { "content-type": "text/plain" }, "done"),
      );
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const transport = createWebTransport({
      profiles: ["chrome_99", "firefox_200", "chrome_147"],
      resolver,
      browserFetch: browser,
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };

    const result = await transport.fetch(
      "https://example.com",
      undefined,
      undefined,
      deadline,
    );

    expect(await result.text()).toBe("done");
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(browser).toHaveBeenNthCalledWith(
      1,
      "https://example.com/",
      expect.objectContaining({
        redirect: "manual",
        browser: "chrome_147",
        os: "windows",
        timeout: 1_000,
      }),
    );
    expect(browser).toHaveBeenNthCalledWith(
      2,
      "https://example.org/next",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("keeps ordinary POST headers while stripping credential and transport controls", async () => {
    const browser = vi.fn<BrowserFetch>(async () => response(200));
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      browserFetch: browser,
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };

    await transport.fetch(
      "https://example.com",
      {
        method: "POST",
        body: "extractor body",
        headers: {
          Accept: "application/json",
          "X-Extractor": "yes",
          Authorization: "secret",
          Cookie: "session=secret",
          Host: "private.example",
          Connection: "close",
          "Content-Length": "999",
        },
      },
      undefined,
      deadline,
    );

    expect(browser).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({
        method: "POST",
        body: expect.any(Uint8Array),
        headers: expect.objectContaining({
          accept: "application/json",
          "x-extractor": "yes",
        }),
      }),
    );
    const sent = browser.mock.calls[0]![1].headers;
    expect(sent).not.toHaveProperty("authorization");
    expect(sent).not.toHaveProperty("cookie");
    expect(sent).not.toHaveProperty("host");
    expect(sent).not.toHaveProperty("connection");
  });

  it("rejects oversize POST bodies before lookup and cancels overflow streams", async () => {
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const browser = vi.fn();
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver,
      browserFetch: browser,
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };
    const request = new Request("https://example.com", {
      method: "POST",
      body: "x".repeat(LIMITS.requestBodyBytes + 1),
    });

    await expect(
      transport.fetch(request, undefined, undefined, deadline),
    ).rejects.toThrow("1 MiB");
    expect(resolver).not.toHaveBeenCalled();

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(LIMITS.responseBytes + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const overflow = createWebTransport({
      profiles: ["chrome_100"],
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      browserFetch: async () => ({
        status: 200,
        statusText: "OK",
        url: "",
        headers: [],
        body: stream,
      }),
    });
    await expect(
      overflow.fetch("https://example.com", undefined, undefined, deadline),
    ).rejects.toThrow("5 MiB");
    expect(cancelled).toBe(true);
  });

  it("settles an aborted lookup without starting a late request", async () => {
    let resolveLookup:
      | ((answers: { address: string; family: number }[]) => void)
      | undefined;
    const browser = vi.fn();
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver: () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
      browserFetch: browser,
    });
    const controller = new AbortController();
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };
    const pending = transport.fetch(
      "https://example.com",
      undefined,
      controller.signal,
      deadline,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolveLookup?.([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    expect(browser).not.toHaveBeenCalled();
  });

  it("cancels rejected redirect responses and ignores unsupported 3xx locations", async () => {
    let cancelled = false;
    const browser = vi.fn<BrowserFetch>(async () => ({
      ...response(302, { location: "http://%" }),
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    }));
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      browserFetch: browser,
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };

    await expect(
      transport.fetch("https://example.com", undefined, undefined, deadline),
    ).rejects.toThrow("invalid HTTP redirect");
    expect(cancelled).toBe(true);

    browser.mockResolvedValueOnce(
      response(304, { location: "https://next.example" }),
    );
    const result = await transport.fetch(
      "https://example.com",
      undefined,
      undefined,
      deadline,
    );
    expect(result.status).toBe(304);
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it("retains nested cancellation identity while a response read is pending", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    const browser = vi.fn<BrowserFetch>(async () => ({
      status: 200,
      statusText: "OK",
      url: "",
      headers: [["content-type", "text/plain"]],
      body: stream,
    }));
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      browserFetch: browser,
    });
    const controller = new AbortController();
    const reason = new Error("nested cancellation");
    const request = new Request("https://example.com", {
      signal: controller.signal,
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };
    const pending = transport.fetch(request, undefined, undefined, deadline);

    await vi.waitFor(() => expect(browser).toHaveBeenCalledOnce());
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancelled).toBe(true);
  });

  it("fails clearly when wreq-js has no Chrome profile", () => {
    expect(() => selectBrowserProfile(["firefox_147"])).toThrow(
      "Chrome profile",
    );
  });
});
