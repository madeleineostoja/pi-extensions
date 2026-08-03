import { describe, expect, it, vi } from "vitest";
import { executeDocs, normalizeName, normalizeVersion } from "./docs-tool.js";
import {
  Context7Error,
  createContext7Transport,
  type Context7Transport,
} from "./context7.js";

function transport(
  overrides: Partial<Context7Transport> = {},
): Context7Transport {
  return {
    search: vi.fn(async () => [
      { id: "/other/library", title: "Other library", versions: [] },
      {
        id: "/acme/widget",
        title: "Acme Widget",
        versions: [{ label: "v1_2_3" }],
      },
    ]),
    context: vi.fn(async () => ({
      snippets: [
        {
          title: "Getting started",
          language: "ts",
          location: "https://context7.com/source",
          text: "provider material",
        },
      ],
    })),
    retries: 0,
    dispose: vi.fn(),
    ...overrides,
  };
}

const input = { subject: "Acme---Widget", question: "How do I start?" };

describe("docs resolution", () => {
  it("chooses the first exact normalized match and reports provider-current", async () => {
    const client = transport();
    const result = await executeDocs(input, undefined, {
      transport: () => client,
    });
    expect(client.search).toHaveBeenCalledOnce();
    expect(client.context).toHaveBeenCalledWith("/acme/widget", input.question);
    expect(result.details).toMatchObject({
      resolution: { mode: "named", rank: 2 },
      version: { state: "provider-current" },
    });
    expect(result.content[0]?.text).toContain("provider material");
  });

  it("uses and discloses the first provider-ranked fallback", async () => {
    const client = transport();
    const result = await executeDocs(
      { ...input, subject: "nothing" },
      undefined,
      { transport: () => client },
    );
    expect(client.context).toHaveBeenCalledWith(
      "/other/library",
      input.question,
    );
    expect(result.details).toMatchObject({
      warnings: [expect.stringContaining("provider-ranked")],
    });
  });

  it("uses only an advertised exact version and treats latest as literal", async () => {
    const client = transport({
      search: vi.fn(async () => [
        {
          id: "/acme/widget",
          title: "Acme Widget",
          versions: [{ label: "latest" }, { label: "v1_2_3" }],
        },
      ]),
    });
    await executeDocs({ ...input, version: "V1.2.3" }, undefined, {
      transport: () => client,
    });
    expect(client.context).toHaveBeenCalledWith(
      "/acme/widget/v1_2_3",
      input.question,
    );
    await executeDocs({ ...input, version: "latest" }, undefined, {
      transport: () => client,
    });
    expect(client.context).toHaveBeenLastCalledWith(
      "/acme/widget/latest",
      input.question,
    );
  });

  it("uses a named nonnumeric advertised pin as an exact target", async () => {
    const client = transport({
      search: vi.fn(async () => [
        {
          id: "/acme/widget",
          title: "Acme Widget",
          versions: [{ label: "beta" }],
        },
      ]),
    });
    const result = await executeDocs({ ...input, version: "beta" }, undefined, {
      transport: () => client,
    });
    expect(client.context).toHaveBeenCalledWith(
      "/acme/widget/beta",
      input.question,
    );
    expect(result.details).toMatchObject({
      version: { state: "exact-version", pin: "beta" },
    });
  });

  it("fails unavailable pins and direct conflicts before network work", async () => {
    const client = transport();
    await expect(
      executeDocs({ ...input, version: "2" }, undefined, {
        transport: () => client,
      }),
    ).rejects.toThrow("exact Context7 version is unavailable");
    expect(client.context).not.toHaveBeenCalled();
    const direct = transport();
    await expect(
      executeDocs(
        { subject: "/acme/widget/1", question: "x", version: "2" },
        undefined,
        { transport: () => direct },
      ),
    ).rejects.toThrow("conflicting");
    expect(direct.search).not.toHaveBeenCalled();
    expect(direct.context).not.toHaveBeenCalled();
  });

  it("reports a direct exact pin as unavailable rather than falling back", async () => {
    const client = transport({
      context: vi.fn(async () => {
        throw new Context7Error("not-found", "missing");
      }),
    });
    await expect(
      executeDocs(
        { subject: "/acme/widget", question: "x", version: "1" },
        undefined,
        { transport: () => client },
      ),
    ).rejects.toMatchObject({ kind: "version-unavailable" });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("skips search for direct IDs and preserves an explicit pin across logical redirects", async () => {
    const client = transport({
      context: vi
        .fn()
        .mockResolvedValueOnce({
          snippets: [],
          redirectId: "/acme/widget-next/1",
        })
        .mockResolvedValueOnce({ snippets: [{ text: "exact" }] }),
    });
    const result = await executeDocs(
      { subject: "/acme/widget", question: "x", version: "1" },
      undefined,
      { transport: () => client },
    );
    expect(client.search).not.toHaveBeenCalled();
    expect(client.context).toHaveBeenNthCalledWith(1, "/acme/widget/1", "x");
    expect(client.context).toHaveBeenNthCalledWith(
      2,
      "/acme/widget-next/1",
      "x",
    );
    expect(result.details).toMatchObject({ logicalRedirects: 1 });
  });

  it("follows a documented 301 redirectUrl only through the fixed context endpoint", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ redirectUrl: "/acme/widget-next@v1_2" }),
          {
            status: 301,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            codeSnippets: [{ codeList: [{ code: "exact" }] }],
          }),
        ),
      );
    const result = await executeDocs(
      { subject: "/acme/widget@1.2", question: "x" },
      undefined,
      {
        transport: (options) =>
          createContext7Transport({
            ...options,
            fetch: fetcher as typeof fetch,
          }),
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => (url as URL).pathname)).toEqual([
      "/api/v2/context",
      "/api/v2/context",
    ]);
    expect(result.details).toMatchObject({ logicalRedirects: 1 });
  });

  it("rejects malformed IDs, conflicting @ pins, and x wildcards before requests", async () => {
    const client = transport();
    await expect(
      executeDocs({ subject: "/", question: "x" }, undefined, {
        transport: () => client,
      }),
    ).rejects.toThrow("valid direct");
    await expect(
      executeDocs(
        { subject: "/acme/widget@beta", question: "x", version: "other" },
        undefined,
        {
          transport: () => client,
        },
      ),
    ).rejects.toThrow("conflicting");
    await expect(
      executeDocs(
        { subject: "/acme/widget/beta/extra", question: "x" },
        undefined,
        { transport: () => client },
      ),
    ).rejects.toThrow("valid direct");
    await expect(
      executeDocs(
        { subject: "/acme/widget", question: "x", version: "1.x" },
        undefined,
        {
          transport: () => client,
        },
      ),
    ).rejects.toThrow("range or wildcard");
    expect(client.search).not.toHaveBeenCalled();
    expect(client.context).not.toHaveBeenCalled();
  });

  it("keeps the complete model-visible result within its ceiling", async () => {
    const client = transport({
      context: vi.fn(async () => ({
        snippets: Array.from({ length: 40 }, () => ({
          text: "x".repeat(3_000),
          location: "https://context7.com/" + "a".repeat(900),
        })),
      })),
    });
    const result = await executeDocs(input, undefined, {
      transport: () => client,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      48 * 1024,
    );
    expect(result.details).toMatchObject({ truncation: expect.any(String) });
  });

  it("normalizes only the documented subject and version forms", () => {
    expect(normalizeName("Ａcme___Widget")).toBe("acme widget");
    expect(normalizeVersion("v1_2-rc")).toBe("1.2-rc");
  });
});
