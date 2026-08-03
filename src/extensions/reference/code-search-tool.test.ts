import { describe, expect, it, vi } from "vitest";
import { executeCodeSearch } from "./code-search-tool.js";
import type { GithubSearchClient } from "./github.js";

const publicItem = {
  sha: "a".repeat(40),
  path: "src/widget.ts",
  html_url: "https://github.com/acme/widget/blob/main/src/widget.ts",
  repository: {
    private: false,
    visibility: "public",
    owner: { login: "acme" },
    name: "widget",
  },
  text_matches: [{ fragment: "useWidget()", matches: [{ indices: [0, 9] }] }],
};

describe("code_search", () => {
  it("assembles validated qualifiers, requests text matches, and filters before normalization", async () => {
    const github = {
      searchRepositories: vi.fn(),
      searchCode: vi.fn(async () => ({
        data: {
          total_count: 3,
          items: [
            {
              ...publicItem,
              repository: {
                private: false,
                visibility: "internal",
                owner: { login: "secret" },
                name: "leak",
              },
              path: "secret.ts",
            },
            publicItem,
          ],
        },
      })),
    } as unknown as GithubSearchClient;
    const result = await executeCodeSearch(
      {
        query: "useWidget",
        repository: "acme/widget",
        language: "TypeScript",
        filename: "widget.ts",
        extension: "ts",
        limit: 2,
      },
      undefined,
      { github: () => github },
    );
    expect(github.searchCode).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "useWidget repo:acme/widget language:TypeScript filename:widget.ts extension:ts",
        per_page: 2,
        mediaType: { format: "text-match" },
      }),
    );
    const details = result.details as {
      discarded: number;
      results: Array<Record<string, unknown>>;
    };
    expect(details).toMatchObject({
      discarded: 1,
      results: [
        {
          rank: 2,
          repository: "acme/widget",
          revision: "a".repeat(40),
          path: "src/widget.ts",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.content[0]?.text).toContain('"repository":"acme/widget"');
    expect(result.content[0]?.text).toContain(
      '"revision":"' + "a".repeat(40) + '"',
    );
    expect(result.content[0]?.text).toContain('"text":"useWidget()"');
  });

  it("succeeds with an empty list when every result fails public visibility", async () => {
    const github = {
      searchCode: vi.fn(async () => ({
        data: {
          total_count: 2,
          incomplete_results: true,
          items: [
            { repository: { private: true, visibility: "public" } },
            { repository: { private: false, visibility: "internal" } },
          ],
        },
      })),
    } as unknown as GithubSearchClient;
    const result = await executeCodeSearch({ query: "widget" }, undefined, {
      github: () => github,
    });
    expect(result.details).toMatchObject({
      accepted: 0,
      discarded: 2,
      truncated: true,
      results: [],
    });
    expect(result.content[0]?.text).toContain("results or fields truncated");
  });

  it("does not construct GitHub work for an already-cancelled invocation", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const github = vi.fn();
    await expect(
      executeCodeSearch({ query: "widget" }, controller.signal, { github }),
    ).rejects.toThrow("cancelled");
    expect(github).not.toHaveBeenCalled();
  });

  it("rejects conflicting or invalid qualifiers before any request", async () => {
    const github = {
      searchCode: vi.fn(),
      searchRepositories: vi.fn(),
    } as unknown as GithubSearchClient;
    await expect(
      executeCodeSearch(
        { query: "x", repository: "a/b", owner: "a" },
        undefined,
        { github: () => github },
      ),
    ).rejects.toThrow("mutually exclusive");
    await expect(
      executeCodeSearch({ query: "x", owner: "bad/name" }, undefined, {
        github: () => github,
      }),
    ).rejects.toThrow("owner is invalid");
    await expect(
      executeCodeSearch({ query: "x", owner: "owner-" }, undefined, {
        github: () => github,
      }),
    ).rejects.toThrow("owner is invalid");
    await expect(
      executeCodeSearch({ query: "x", repository: "a--b/repo" }, undefined, {
        github: () => github,
      }),
    ).rejects.toThrow("repository");
    expect(github.searchCode).not.toHaveBeenCalled();
  });
});
