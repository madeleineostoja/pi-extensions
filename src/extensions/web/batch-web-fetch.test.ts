import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifacts.js";
import { executeBatchWebFetch } from "./batch-web-fetch.js";
import { DeadlineError, WebError } from "./errors.js";
import type { Deadline } from "./cancellation.js";
import { executeWebFetch, type WebFetchResult } from "./web-fetch.js";
import type { WebTransport } from "./transport.js";
import { renderBatchWebFetchResult } from "./result-renderer.js";

function page(url: string, contentType: string, body: string): Response {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function result(url: string, body: string): WebFetchResult {
  return {
    content: [{ type: "text", text: `Requested URL: ${url}\n\n${body}` }],
    details: {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: "text/plain",
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) {
    await Promise.resolve();
  }
}

beforeAll(() => initTheme("dark", false));

describe("batch_web_fetch", () => {
  it("summarizes mixed success while preserving ordered expanded sections", () => {
    const result = {
      content: [
        {
          type: "text" as const,
          text: "## Item 1: https://one.example\nStatus: succeeded\n\nfirst body\n\n## Item 2: https://two.example\nStatus: failed · timed out",
        },
      ],
      details: { total: 2, succeeded: 1, failed: 1 },
    };
    const theme = { fg: (_color: string, text: string) => text } as never;
    const collapsed = renderBatchWebFetchResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      {},
    )
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");
    const expanded = renderBatchWebFetchResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      {},
    )
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");

    expect(collapsed).toBe("1/2 fetched · 1 failed");
    expect(expanded.indexOf("Item 1")).toBeLessThan(expanded.indexOf("Item 2"));
    expect(expanded).toContain("Status: failed · timed out");
  });
  it("runs at most four items, caps item deadlines, and assembles out-of-order work in request order", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const deadlines: number[] = [];
    const deadlineArguments: number[] = [];
    let remaining = 1_200;
    let deadlineCalls = 0;
    const aggregate = {
      signal: new AbortController().signal,
      remaining: () => remaining,
      dispose: () => {},
    } satisfies Deadline;
    const batch = executeBatchWebFetch(
      {
        requests: Array.from({ length: 8 }, (_, index) => ({
          url: `https://example.com/${index + 1}`,
          timeoutMs: 120_000,
        })),
      },
      undefined,
      undefined,
      {
        createDeadline: (milliseconds) => {
          deadlineArguments.push(milliseconds);
          return deadlineCalls++ === 0 ? aggregate : deadline(milliseconds);
        },
        execute: async (request, _signal, _update, dependencies) => {
          starts.push(request.url);
          deadlines.push(dependencies?.deadline?.remaining() ?? 0);
          active++;
          maximumActive = Math.max(maximumActive, active);
          const gate = deferred();
          gates.set(request.url, gate);
          await gate.promise;
          active--;
          return result(request.url, `body ${request.url}`);
        },
      },
    );

    await turns();
    expect(starts).toEqual([
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/3",
      "https://example.com/4",
    ]);
    expect(maximumActive).toBe(4);
    expect(deadlines).toEqual([1_200, 1_200, 1_200, 1_200]);
    remaining = 750;
    gates.get("https://example.com/4")?.resolve();
    await turns();
    expect(starts).toHaveLength(5);
    expect(deadlineArguments).toEqual([
      120_000, 1_200, 1_200, 1_200, 1_200, 750,
    ]);
    for (let index = 1; index <= 8; index++) {
      gates.get(`https://example.com/${index}`)?.resolve();
      await turns();
    }

    const output = (await batch).content[0]?.text ?? "";
    expect(output.indexOf("## Item 1:")).toBeLessThan(
      output.indexOf("## Item 2:"),
    );
    expect(output.indexOf("## Item 4:")).toBeLessThan(
      output.indexOf("## Item 5:"),
    );
    expect(output.indexOf("## Item 5:")).toBeLessThan(
      output.indexOf("## Item 8:"),
    );
  });

  it("runs one valid request through the same bounded pool", async () => {
    let active = 0;
    let maximumActive = 0;
    const output = await executeBatchWebFetch(
      { requests: [{ url: "https://example.com/one" }] },
      undefined,
      undefined,
      {
        execute: async (request) => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          active--;
          return result(request.url, "one body");
        },
      },
    );

    expect(maximumActive).toBe(1);
    expect(output.content[0]?.text).toContain("## Item 1:");
  });

  it("runs concurrent HTML extraction without changing observed process globals", async () => {
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async (input) =>
        page(
          String(input),
          "text/html",
          "<html><head><title>Example</title></head><body><article><h1>Heading</h1><p>Readable page text.</p></article></body></html>",
        ),
    };
    const previousConsoleError = console.error;
    const previousConsoleLog = console.log;

    const output = await executeBatchWebFetch(
      {
        requests: Array.from({ length: 4 }, (_, index) => ({
          url: `https://example.com/${index}`,
        })),
      },
      undefined,
      undefined,
      { transport },
    );

    expect(output.details).toMatchObject({ succeeded: 4, failed: 0 });
    expect(output.content[0]?.text).toContain("# Heading");
    expect(console.error).toBe(previousConsoleError);
    expect(console.log).toBe(previousConsoleLog);
  });

  it("validates the complete batch before starting a request", async () => {
    let started = false;
    await expect(
      executeBatchWebFetch(
        {
          requests: [
            { url: "https://example.com/valid" },
            { url: "https://example.com/invalid", maxChars: 0 },
          ],
        } as never,
        undefined,
        undefined,
        {
          execute: async () => {
            started = true;
            return result("https://example.com", "unexpected");
          },
        },
      ),
    ).rejects.toThrow("invalid schema");
    expect(started).toBe(false);
  });

  it("allocates result content fairly and retains every status section", async () => {
    const body = "x".repeat(40_000);
    const output = await executeBatchWebFetch(
      {
        requests: [
          { url: "https://example.com/first" },
          { url: "https://example.com/second" },
        ],
      },
      undefined,
      undefined,
      {
        execute: async (request) => result(request.url, body),
      },
    );
    const text = output.content[0]?.text ?? "";

    expect(text).toContain("Status: succeeded");
    expect(
      text.match(/\[Item content truncated for fair batch allocation\.\]/gu),
    ).toHaveLength(2);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(48 * 1024);
    expect(text.split("\n").length).toBeLessThanOrEqual(1_900);
  });

  it("retains source truncation facts and authoritatively bounds UTF-8 output and details", async () => {
    const body = `${"secret body 😀\n".repeat(2_000)}`;
    const output = await executeBatchWebFetch(
      {
        requests: Array.from({ length: 8 }, (_, index) => ({
          url: `https://example.com/${"😀".repeat(200)}/${index}`,
          maxChars: 40_000,
        })),
      },
      undefined,
      undefined,
      {
        execute: async (request) => ({
          content: [
            { type: "text", text: `Requested URL: ${request.url}\n\n${body}` },
          ],
          details: {
            finalUrl: request.url,
            status: 200,
            contentType: `text/${"😀".repeat(100)}`,
            semanticTruncated: true,
            artifact: {
              path: `/${"😀".repeat(200)}`,
              kind: "raw-text",
              bytes: 1,
            },
          },
        }),
      },
    );
    const text = output.content[0]?.text ?? "";
    const details = JSON.stringify(output.details);

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(48 * 1024);
    expect(text.split("\n").length).toBeLessThanOrEqual(1_900);
    expect(
      text.match(/Content: truncated to the request's maxChars\./gu),
    ).toHaveLength(8);
    expect(text.match(/## Item \d:/gu)).toHaveLength(8);
    expect(
      text.match(/\[Item content truncated for fair batch allocation\.\]/gu),
    ).toHaveLength(8);
    expect(details).toContain('"semanticTruncated":true');
    expect(Buffer.byteLength(details)).toBeLessThan(20 * 1024);
    expect(details).not.toContain("secret body");
  });

  it("returns mixed failures as success and throws one bounded error when all fail", async () => {
    const mixed = await executeBatchWebFetch(
      {
        requests: [
          { url: "https://example.com/good" },
          { url: "https://example.com/bad" },
        ],
      },
      undefined,
      undefined,
      {
        execute: async (request) => {
          if (request.url.endsWith("bad")) {
            throw new WebError(
              "network",
              "The public target could not respond.",
            );
          }
          return result(request.url, "available");
        },
      },
    );
    expect(mixed.details).toMatchObject({ succeeded: 1, failed: 1 });
    expect(mixed.content[0]?.text).toContain(
      "Status: failed · The public target could not respond.",
    );

    let failure: Error | undefined;
    try {
      await executeBatchWebFetch(
        {
          requests: [
            { url: "https://example.com/one" },
            { url: "https://example.com/two" },
          ],
        },
        undefined,
        undefined,
        {
          execute: async () => {
            throw new WebError(
              "network",
              "The public target could not respond.",
            );
          },
        },
      );
    } catch (error) {
      failure = error as Error;
    }
    const message = failure?.message ?? "";
    expect(message).toContain("failed for every item");
    expect(message.indexOf("Item 1 (https://example.com/one)")).toBeLessThan(
      message.indexOf("Item 2 (https://example.com/two)"),
    );
    expect(message).toContain("The public target could not respond.");
    expect(Buffer.byteLength(message)).toBeLessThan(8 * 1024);
  });

  it("keeps a successful artifact available when a sibling fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipkin-web-batch-test-"));
    const artifacts = new ArtifactStore({ temporaryRoot: root });
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async () => {
        throw new WebError("network", "The public target could not respond.");
      },
      fetchArtifact: async (input) => {
        if (String(input).endsWith("bad")) {
          throw new WebError("network", "The public target could not respond.");
        }
        return page(String(input), "text/plain", "raw evidence");
      },
    };
    try {
      const output = await executeBatchWebFetch(
        {
          requests: [
            {
              url: "https://example.com/good",
              raw: true,
              maxChars: 4,
            },
            { url: "https://example.com/bad", raw: true },
          ],
        },
        undefined,
        undefined,
        { artifacts, transport },
      );
      const items = output.details.items as Array<{
        status: string;
        artifact?: { path: string };
      }>;

      expect(items[0]).toMatchObject({
        status: "succeeded",
        semanticTruncated: true,
      });
      expect(output.content[0]?.text).toContain(
        "Content: truncated to the request's maxChars.",
      );
      expect(items[1]).toMatchObject({ status: "failed" });
      expect(await readFile(items[0]?.artifact?.path ?? "", "utf8")).toBe(
        "raw evidence",
      );
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts queued work with a sub-second deadline through the existing fetch core", async () => {
    const gates = Array.from({ length: 4 }, () => deferred());
    const aggregateController = new AbortController();
    let remaining = 1_000;
    let deadlineCalls = 0;
    const started = deferred();
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async (input) => {
        started.resolve();
        return page(String(input), "text/plain", "finished before expiry");
      },
    };
    const output = executeBatchWebFetch(
      {
        requests: Array.from({ length: 5 }, (_, index) => ({
          url: `https://example.com/${index}`,
        })),
      },
      undefined,
      undefined,
      {
        transport,
        createDeadline: (milliseconds) => {
          if (deadlineCalls++ === 0) {
            return {
              signal: aggregateController.signal,
              remaining: () => remaining,
              dispose: () => {},
            };
          }
          return deadline(milliseconds);
        },
        execute: async (request, signal, onUpdate, dependencies) => {
          const index = Number(request.url.slice(-1));
          if (index < 4) {
            await gates[index]!.promise;
            return result(request.url, "completed");
          }
          return executeWebFetch(request, signal, onUpdate, dependencies);
        },
      },
    );

    await turns();
    remaining = 500;
    gates[0]?.resolve();
    await started.promise;
    for (const gate of gates.slice(1)) {
      gate.resolve();
    }

    const batchResult = await output;
    expect(batchResult.details).toMatchObject({ succeeded: 5, failed: 0 });
    expect(batchResult.content[0]?.text).toContain("finished before expiry");
  });

  it("preserves deadline identity when active sub-second work expires", async () => {
    const aggregateController = new AbortController();
    let deadlineCalls = 0;
    let started = false;
    const transport: WebTransport = {
      profile: { browser: "chrome_147", os: "windows" },
      fetch: async (_input, _init, signal) => {
        started = true;
        return await new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    };
    const batch = executeBatchWebFetch(
      { requests: [{ url: "https://example.com/slow" }] },
      undefined,
      undefined,
      {
        transport,
        createDeadline: (milliseconds) => {
          if (deadlineCalls++ === 0) {
            return {
              signal: aggregateController.signal,
              remaining: () => 500,
              dispose: () => {},
            };
          }
          return deadline(milliseconds);
        },
      },
    );

    await turns();
    expect(started).toBe(true);
    aggregateController.abort(new DeadlineError());
    await expect(batch).rejects.toBeInstanceOf(DeadlineError);
  });

  it("aborts active work and does not start queued items after parent cancellation", async () => {
    const controller = new AbortController();
    let started = 0;
    const batch = executeBatchWebFetch(
      {
        requests: Array.from({ length: 5 }, (_, index) => ({
          url: `https://example.com/${index}`,
        })),
      },
      controller.signal,
      undefined,
      {
        execute: async (_request, signal) => {
          started++;
          return await new Promise<WebFetchResult>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      },
    );
    await turns();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(batch).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(4);
  });

  it("stops queued work when the aggregate deadline expires", async () => {
    const controller = new AbortController();
    let started = 0;
    const aggregate = deadline(1_000, controller);
    const batch = executeBatchWebFetch(
      {
        requests: Array.from({ length: 5 }, (_, index) => ({
          url: `https://example.com/${index}`,
        })),
      },
      undefined,
      undefined,
      {
        createDeadline: () => aggregate,
        execute: async (_request, signal) => {
          started++;
          return await new Promise<WebFetchResult>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      },
    );
    await turns();
    controller.abort(new DeadlineError());

    await expect(batch).rejects.toBeInstanceOf(DeadlineError);
    expect(started).toBe(4);
  });

  it("keeps single-fetch final-limit omissions distinct from request and fair truncation", async () => {
    const output = await executeBatchWebFetch(
      {
        requests: [
          { url: "https://example.com/utf8", maxChars: 40_000 },
          { url: "https://example.com/lines", maxChars: 40_000 },
        ],
      },
      undefined,
      undefined,
      {
        execute: async (request) => ({
          content: [
            {
              type: "text",
              text: `Requested URL: ${request.url}\n\n${"😀".repeat(20_000)}\n${"line\n".repeat(2_000)}`,
            },
          ],
          details: {
            finalUrl: request.url,
            status: 200,
            contentType: "text/plain",
            semanticTruncated: request.url.endsWith("utf8"),
            finalTruncated: true,
          },
        }),
      },
    );
    const content = output.content[0]?.text ?? "";
    const items = output.details.items as Array<Record<string, unknown>>;

    expect(
      content.match(
        /Content: truncated by the single-fetch final result limit\./gu,
      ),
    ).toHaveLength(2);
    expect(content).toContain("Content: truncated to the request's maxChars.");
    expect(content).toContain(
      "[Item content truncated for fair batch allocation.]",
    );
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ finalTruncated: true }),
      ]),
    );
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(48 * 1024);
    expect(content.split("\n").length).toBeLessThanOrEqual(1_900);
  });
});

function deadline(
  remaining: number,
  controller = new AbortController(),
): Deadline {
  return {
    signal: controller.signal,
    remaining: () => (controller.signal.aborted ? 0 : remaining),
    dispose: () => {},
  };
}
