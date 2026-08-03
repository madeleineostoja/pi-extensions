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

  it("accepts representative public literals and rejects special IPv4/IPv6 ranges", () => {
    for (const value of [
      "https://8.8.8.8/",
      "https://[2606:4700:4700::1111]/",
    ]) {
      expect(canonicalTarget(value).isLiteral).toBe(true);
    }
    for (const value of [
      "http://0.0.0.0/",
      "http://255.255.255.255/",
      "http://10.0.0.1/",
      "http://100.64.0.1/",
      "http://169.254.1.1/",
      "http://172.16.0.1/",
      "http://192.0.2.1/",
      "http://198.18.0.1/",
      "http://224.0.0.1/",
      "http://[::]/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[2001:db8::1]/",
    ]) {
      expect(() => canonicalTarget(value)).toThrow();
    }
  });

  it("denies empty, malformed, mixed, and failed DNS results before transport", async () => {
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };
    for (const resolver of [
      async () => [],
      async () => [{ address: "not-an-address", family: 4 }],
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      async () => {
        throw new Error("lookup failed");
      },
    ]) {
      const browser = vi.fn();
      const transport = createWebTransport({
        profiles: ["chrome_120"],
        resolver,
        browserFetch: browser,
      });
      await expect(
        transport.fetch("https://example.com", undefined, undefined, deadline),
      ).rejects.toThrow();
      expect(browser).not.toHaveBeenCalled();
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

  it("permits GET and HEAD while rejecting unsupported nested methods", async () => {
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
      "https://example.com/get",
      undefined,
      undefined,
      deadline,
    );
    await transport.fetch(
      "https://example.com/head",
      { method: "HEAD" },
      undefined,
      deadline,
    );
    await expect(
      transport.fetch(
        "https://example.com/delete",
        { method: "DELETE" },
        undefined,
        deadline,
      ),
    ).rejects.toThrow("only GET, HEAD, and POST");
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it.each(["parent", "deadline"] as const)(
    "preserves %s cancellation identity during response streaming",
    async (source) => {
      const controller = new AbortController();
      const stream = new ReadableStream<Uint8Array>({ pull() {} });
      const browser = vi.fn<BrowserFetch>(async () => ({
        status: 200,
        statusText: "OK",
        url: "",
        headers: [],
        body: stream,
      }));
      const transport = createWebTransport({
        profiles: ["chrome_100"],
        resolver: async () => [{ address: "8.8.8.8", family: 4 }],
        browserFetch: browser,
      });
      const deadline = {
        signal:
          source === "deadline"
            ? controller.signal
            : new AbortController().signal,
        remaining: () => 1_000,
        dispose: () => {},
      };
      const parent = source === "parent" ? controller.signal : undefined;
      const reason = new Error(`${source} cancellation`);
      const pending = transport.fetch(
        "https://example.com/slow",
        undefined,
        parent,
        deadline,
      );

      await vi.waitFor(() => expect(browser).toHaveBeenCalledOnce());
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    },
  );

  it("maps stream failures to a bounded network error and releases the reader lock", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket failed"));
      },
    });
    const transport = createWebTransport({
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
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };

    await expect(
      transport.fetch("https://example.com", undefined, undefined, deadline),
    ).rejects.toThrow("response stream failed");
    expect(stream.locked).toBe(false);
  });

  it("preserves the 1 MiB POST error when request-body cancellation rejects", async () => {
    let cancellations = 0;
    const request = new Request("https://example.com", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(LIMITS.requestBodyBytes + 1));
        },
        cancel() {
          cancellations++;
          return Promise.reject(new Error("cleanup failed"));
        },
      }),
      duplex: "half",
    } as RequestInit);
    const resolver = vi.fn();
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver,
      browserFetch: vi.fn(),
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };

    await expect(
      transport.fetch(request, undefined, undefined, deadline),
    ).rejects.toThrow("1 MiB");
    expect(cancellations).toBe(1);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("preserves an overflow error when reader cancellation rejects", async () => {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LIMITS.responseBytes + 1));
      },
      cancel() {
        cancellations++;
        return Promise.reject(new Error("cleanup failed"));
      },
    });
    const transport = createWebTransport({
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
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };

    await expect(
      transport.fetch("https://example.com", undefined, undefined, deadline),
    ).rejects.toThrow("5 MiB");
    expect(cancellations).toBe(1);
  });

  it("settles an aborted lookup without starting a late request", async () => {
    let resolveLookup:
      | ((answers: { address: string; family: number }[]) => void)
      | undefined;
    const browser = vi.fn();
    let entered!: () => void;
    const enteredLookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver: () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
          entered();
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
    await enteredLookup;
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

  it("returns bounded standard response text, JSON, array-buffer, and stream bodies", async () => {
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      browserFetch: async () =>
        response(200, { "content-type": "application/json" }, '{"ok":true}'),
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };
    const jsonResponse = await transport.fetch(
      "https://example.com/json",
      undefined,
      undefined,
      deadline,
    );
    expect(await jsonResponse.json()).toEqual({ ok: true });

    const bytesResponse = await transport.fetch(
      "https://example.com/bytes",
      undefined,
      undefined,
      deadline,
    );
    expect(new TextDecoder().decode(await bytesResponse.arrayBuffer())).toBe(
      '{"ok":true}',
    );

    const streamResponse = await transport.fetch(
      "https://example.com/stream",
      undefined,
      undefined,
      deadline,
    );
    const reader = streamResponse.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      '{"ok":true}',
    );
    reader.releaseLock();
  });

  it.each([
    [301, "GET"],
    [302, "GET"],
    [303, "GET"],
    [307, "POST"],
    [308, "POST"],
  ])(
    "applies the POST redirect transition for HTTP %i",
    async (status, method) => {
      const browser = vi
        .fn<BrowserFetch>()
        .mockResolvedValueOnce(response(status, { location: "/next" }))
        .mockResolvedValueOnce(response(200));
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
        "https://example.com/start",
        {
          method: "POST",
          body: "request body",
          headers: { "content-type": "text/plain" },
        },
        undefined,
        deadline,
      );

      const redirected = browser.mock.calls[1]![1];
      expect(redirected.method).toBe(method);
      if (method === "GET") {
        expect(redirected.body).toBeUndefined();
        expect(redirected.headers).not.toHaveProperty("content-type");
      } else {
        expect(redirected.body).toBeInstanceOf(Uint8Array);
      }
    },
  );

  it("rejects forbidden and over-limit redirects before another request starts", async () => {
    const forbidden = vi.fn<BrowserFetch>(async () =>
      response(302, { location: "http://127.0.0.1/" }),
    );
    const transport = createWebTransport({
      profiles: ["chrome_100"],
      resolver: async (hostname) => [
        {
          address: hostname === "localhost" ? "127.0.0.1" : "8.8.8.8",
          family: 4,
        },
      ],
      browserFetch: forbidden,
    });
    const deadline = {
      signal: new AbortController().signal,
      remaining: () => 1_000,
      dispose: () => {},
    };
    await expect(
      transport.fetch("https://example.com", undefined, undefined, deadline),
    ).rejects.toThrow("public unicast");
    expect(forbidden).toHaveBeenCalledOnce();

    const looping = vi.fn<BrowserFetch>(async () =>
      response(302, { location: "/again" }),
    );
    const loopingTransport = createWebTransport({
      profiles: ["chrome_100"],
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      browserFetch: looping,
    });
    await expect(
      loopingTransport.fetch(
        "https://example.com",
        undefined,
        undefined,
        deadline,
      ),
    ).rejects.toThrow("five HTTP redirects");
    expect(looping).toHaveBeenCalledTimes(6);
  });

  it("fails clearly when wreq-js has no Chrome profile", () => {
    expect(() => selectBrowserProfile(["firefox_147"])).toThrow(
      "Chrome profile",
    );
  });
});
