import { describe, expect, it, vi } from "vitest";
import { CodeSearchParameters, executeCodeSearch } from "./code-search-tool.js";
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
  it("assembles validated qualifiers and normalizes matches visible to the credential", async () => {
    const github = {
      searchRepositories: vi.fn(),
      searchCode: vi.fn(async () => ({
        data: {
          total_count: 3,
          items: [
            {
              ...publicItem,
              repository: {
                private: true,
                visibility: "private",
                owner: { login: "acme" },
                name: "private-widget",
              },
              path: "private.ts",
              html_url:
                "https://github.com/acme/private-widget/blob/main/private.ts",
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
      discarded: 0,
      results: [
        {
          rank: 1,
          repository: "acme/private-widget",
          revision: "a".repeat(40),
          path: "private.ts",
        },
        {
          rank: 2,
          repository: "acme/widget",
          revision: "a".repeat(40),
          path: "src/widget.ts",
        },
      ],
    });
    expect(result.content[0]?.text).toContain("## 1. acme/private-widget");
    expect(result.content[0]?.text).toContain("## 2. acme/widget");
    expect(result.content[0]?.text).toContain(
      `Revision: \`${"a".repeat(40)}\``,
    );
    expect(result.content[0]?.text).toContain("```text\nuseWidget()\n```");
  });

  it("contains every multiline fragment line as literal source evidence", async () => {
    const github = {
      searchCode: vi.fn(async () => ({
        data: {
          items: [
            {
              ...publicItem,
              text_matches: [
                {
                  fragment:
                    "const value = 1;\n## not a result heading\n- not a provider list\n<div>literal</div>\n```",
                  matches: [{ indices: [0, 5] }],
                },
              ],
            },
          ],
        },
      })),
    } as unknown as GithubSearchClient;
    const result = await executeCodeSearch({ query: "value" }, undefined, {
      github: () => github,
    });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain(
      "````text\nconst value = 1;\n## not a result heading\n- not a provider list\n<div>literal</div>\n```\n````",
    );
    expect(result.details).toMatchObject({
      results: [
        {
          fragments: [
            {
              text: "const value = 1;\n## not a result heading\n- not a provider list\n<div>literal</div>\n```",
              offsets: [[0, 5]],
            },
          ],
        },
      ],
    });
  });

  it("succeeds with an empty list when every result is malformed", async () => {
    const github = {
      searchCode: vi.fn(async () => ({
        data: {
          total_count: 2,
          incomplete_results: true,
          items: [
            { repository: { owner: { login: "acme" }, name: "missing" } },
            { repository: "malformed" },
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

  it("documents and rejects mutually exclusive repository filters before any request", async () => {
    expect(
      (
        CodeSearchParameters.properties.repository as unknown as {
          description: string;
        }
      ).description,
    ).toContain("mutually exclusive with owner");
    expect(
      (
        CodeSearchParameters.properties.owner as unknown as {
          description: string;
        }
      ).description,
    ).toContain("mutually exclusive with repository");
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
