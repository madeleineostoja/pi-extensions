import { describe, expect, it, vi } from "vitest";
import { executePackageSearch } from "./package-search-tool.js";
import type { Context7Transport } from "./context7.js";
import type { GithubSearchClient } from "./github.js";

describe("package_search", () => {
  it("keeps provider order and native ranks while preserving a failed provider", async () => {
    const context = {
      search: vi.fn(async () => [
        {
          id: "/acme/widget",
          title: "Widget",
          rank: 1,
          versions: [
            { label: "1" },
            { label: "2" },
            { label: "3" },
            { label: "4" },
            { label: "5" },
            { label: "6" },
          ],
        },
      ]),
      context: vi.fn(),
      retries: 0,
      dispose: vi.fn(),
    } as unknown as Context7Transport;
    const github = {
      searchRepositories: vi.fn(async () => ({
        data: {
          total_count: 2,
          incomplete_results: true,
          items: [
            {
              private: true,
              visibility: "public",
              owner: { login: "private" },
              name: "leak",
            },
            {
              private: false,
              visibility: "PUBLIC",
              owner: { login: "acme" },
              name: "widget",
              html_url: "https://github.com/acme/widget",
              stargazers_count: 1,
              forks_count: 2,
              archived: false,
              fork: false,
            },
          ],
        },
      })),
      searchCode: vi.fn(),
    } as unknown as GithubSearchClient;
    const result = await executePackageSearch(
      { query: "widget", limit: 2 },
      undefined,
      {
        context: () => context,
        npm: async () => {
          throw new Error("npm unavailable");
        },
        github: () => github,
      },
    );
    const groups = result.details.groups as Array<Record<string, unknown>>;
    expect(groups.map((group) => group.provider)).toEqual([
      "context7",
      "npm",
      "github",
    ]);
    expect(groups[0]).toMatchObject({ truncated: true });
    expect(groups[1]).toMatchObject({ status: "error", results: [] });
    expect(groups[2]).toMatchObject({
      discarded: 1,
      truncated: true,
      results: [{ rank: 2, repository: "acme/widget" }],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.content[0]?.text).toContain('"rank":2');
    expect(result.content[0]?.text).toContain('"repository":"acme/widget"');
    expect(result.content[0]?.text).toContain(
      "omitted provider fields or results",
    );
    expect(context.search).toHaveBeenCalledWith("widget", "widget", 2);
  });

  it("wraps successful npm results in the npm provider group and renders them", async () => {
    const context = {
      search: vi.fn(async () => []),
      dispose: vi.fn(),
    } as unknown as Context7Transport;
    const github = {
      searchRepositories: vi.fn(async () => ({ data: { items: [] } })),
    } as unknown as GithubSearchClient;
    const result = await executePackageSearch({ query: "widget" }, undefined, {
      context: () => context,
      npm: async () => ({
        results: [
          {
            rank: 1,
            name: "widget",
            version: "1.0.0",
            links: { npm: "https://www.npmjs.com/package/widget" },
          },
        ],
        discarded: 0,
        truncated: false,
      }),
      github: () => github,
    });
    const groups = result.details.groups as Array<Record<string, unknown>>;
    expect(groups[1]).toMatchObject({
      provider: "npm",
      status: "ok",
      discarded: 0,
      truncated: false,
      results: [{ rank: 1, name: "widget" }],
    });
    expect(result.content[0]?.text).toContain('"name":"widget"');
  });

  it("does not construct providers for an already-cancelled invocation", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const context = vi.fn();
    const npm = vi.fn();
    const github = vi.fn();
    await expect(
      executePackageSearch({ query: "widget" }, controller.signal, {
        context,
        npm,
        github,
      }),
    ).rejects.toThrow("cancelled");
    expect(context).not.toHaveBeenCalled();
    expect(npm).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
  });

  it("rejects invalid input before starting any provider and all-provider failure", async () => {
    const provider = vi.fn();
    await expect(
      executePackageSearch({ query: "\u0000" }, undefined, { npm: provider }),
    ).rejects.toThrow("query");
    expect(provider).not.toHaveBeenCalled();
    await expect(
      executePackageSearch({ query: "widget" }, undefined, {
        context: () => {
          throw new Error("no context");
        },
        npm: async () => {
          throw new Error("no npm");
        },
        github: () => {
          throw new Error("no GitHub");
        },
      }),
    ).rejects.toThrow("all providers");
  });
});
