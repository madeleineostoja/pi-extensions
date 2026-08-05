import { describe, expect, it, vi } from "vitest";
import {
  PackageSearchParameters,
  executePackageSearch,
} from "./package-search-tool.js";
import type { Context7Transport } from "./context7.js";
import type { GithubSearchClient } from "./github.js";
import { NpmError } from "./npm.js";

describe("package_search", () => {
  it("keeps provider order and native ranks while preserving a failed provider", async () => {
    expect(
      (
        PackageSearchParameters.properties.query as unknown as {
          description: string;
        }
      ).description,
    ).toContain("documentation, npm, and GitHub");
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
              visibility: "private",
              owner: { login: "private" },
              name: "malformed",
            },
            {
              visibility: null,
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
          throw new NpmError(
            "unavailable",
            "npm search is temporarily unavailable.",
          );
        },
        github: () => github,
      },
    );
    const groups = result.details.groups as Array<Record<string, unknown>>;
    expect(groups.map((group) => group.provider)).toEqual([
      "documentation",
      "npm",
      "github",
    ]);
    expect(groups[0]).toMatchObject({ truncated: true });
    expect(groups[1]).toMatchObject({
      status: "error",
      errorKind: "unavailable",
      results: [],
    });
    expect(groups[2]).toMatchObject({
      discarded: 1,
      truncated: true,
      results: [{ rank: 2, repository: "acme/widget" }],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.content[0]?.text).toContain("## github · 1 result");
    expect(result.content[0]?.text).toContain("2. **acme/widget**");
    expect(result.content[0]?.text).toContain(
      "provider fields or results omitted",
    );
    expect(result.content[0]?.text).toContain(
      "verify a candidate from another provider with `npm view`",
    );
    expect(result.content[0]?.text).toContain("Provider failed (unavailable)");
    expect(context.search).toHaveBeenCalledWith("widget", "widget", 2);
    expect(JSON.stringify(result)).not.toMatch(/context7/i);
    expect(github.searchRepositories).toHaveBeenCalledWith(
      expect.objectContaining({ q: "widget is:public", per_page: 2 }),
    );
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
    expect(result.content[0]?.text).toContain("**widget**");
    expect(result.content[0]?.text).toContain(
      "similarly named discovery candidates",
    );
    expect(result.content[0]?.text).toContain(
      "Use an exact package name with `npm view`",
    );
  });

  it("renders each provider's bounded canonical evidence as readable Markdown", async () => {
    const context = {
      search: vi.fn(async () => [
        {
          id: "/acme/widget",
          title: "Widget docs",
          description: "Widget reference",
          rank: 3,
          versions: [{ label: "2.0" }, { label: "1.0" }],
          quality: { trustScore: 9, totalSnippets: 42 },
        },
      ]),
      dispose: vi.fn(),
    } as unknown as Context7Transport;
    const github = {
      searchRepositories: vi.fn(async () => ({
        data: {
          items: [
            {
              owner: { login: "acme" },
              name: "widget",
              description: "Widget source",
              html_url: "https://github.com/acme/widget",
              stargazers_count: 12,
              forks_count: 4,
              language: "TypeScript",
              updated_at: "2026-01-02T00:00:00Z",
              pushed_at: "2026-01-01T00:00:00Z",
              license: { spdx_id: "MIT" },
              archived: true,
              fork: true,
            },
          ],
        },
      })),
    } as unknown as GithubSearchClient;
    const result = await executePackageSearch({ query: "widget" }, undefined, {
      context: () => context,
      npm: async () => ({
        results: [
          {
            rank: 2,
            name: "widget",
            version: "2.0.0",
            description: "Widget package",
            date: "2026-01-03",
            license: "MIT",
            publisher: "acme",
            keywords: ["widget", "tool"],
            links: {
              npm: "https://www.npmjs.com/package/widget",
              homepage: "https://example.com/widget",
              repository: "https://github.com/acme/widget",
            },
          },
        ],
        discarded: 0,
        truncated: false,
      }),
      github: () => github,
    });
    const content = result.content[0]?.text ?? "";

    expect(content).toContain("3. **Widget docs**");
    expect(content).toContain("Versions: 2.0, 1.0");
    expect(content).toContain("Quality: trust score 9 · 42 snippets");
    expect(content).toContain("2. **widget** · version 2.0.0");
    expect(content).toContain(
      "published 2026-01-03 · license MIT · publisher acme",
    );
    expect(content).toContain("Keywords: widget, tool");
    expect(content).toContain("[homepage](https://example.com/widget)");
    expect(content).toContain("1. **acme/widget**");
    expect(content).toContain(
      "language TypeScript · stars 12 · forks 4 · license MIT",
    );
    expect(content).toContain(
      "updated 2026-01-02T00:00:00Z · pushed 2026-01-01T00:00:00Z",
    );
    expect(content).toContain("Archived: yes · Fork: yes");
    expect(result.details).toMatchObject({
      groups: [
        {
          results: [
            { rank: 3, versions: ["2.0", "1.0"], quality: { trustScore: 9 } },
          ],
        },
        {
          results: [
            { rank: 2, links: { homepage: "https://example.com/widget" } },
          ],
        },
        { results: [{ rank: 1, stars: 12, archived: true, fork: true }] },
      ],
    });
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
