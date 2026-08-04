# Reference

Reference provides bounded external evidence through `docs`, `package_search`, and `code_search`. These tools use fixed provider origins and accept only non-confidential input. Never send secrets, credentials, proprietary text, or sensitive identifiers.

## Choose a tool

| Tool             | Use it for                                                          | Do not treat results as                                         |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `docs`           | Focused documentation for a known library                           | A synthesized answer or project inspection                      |
| `package_search` | Discovering candidates across documentation, npm, and public GitHub | Identity matching, deduplication, or recommendations            |
| `code_search`    | Finding observed usage in credential-visible GitHub source          | Proof of correctness, authority, freshness, or package identity |

Use Web Fetch for a known public URL and the GitHub tool or skill for broader repository, issue, pull-request, or Actions workflows. Reference never delegates research or automatically falls back between tools.

## `docs`

`docs` retrieves Context7 documentation for a named subject or direct Context7 library ID.

| Argument   | Required | Meaning                                                                   |
| ---------- | -------- | ------------------------------------------------------------------------- |
| `subject`  | Yes      | Library name or `/owner/library[/version]` or `/owner/library@version` ID |
| `question` | Yes      | Focused question for the selected library                                 |
| `version`  | No       | Exact Context7 version label; omitted means provider-current material     |

A direct ID skips library search. When both the direct subject and `version` contain a version, they must match. Pipkin never substitutes a compatible, nearby, tag-equivalent, or current release for an explicit version; `latest` is an ordinary literal that Context7 must advertise.

For named subjects, Pipkin considers at most five provider-ranked candidates, prefers an exact normalized name, and reports fallback selection. Results contain bounded provider snippets and provenance, not a synthesized conclusion.

## `package_search`

`package_search` sends the same non-confidential query to three independent providers concurrently.

| Argument | Required | Meaning                                          |
| -------- | -------- | ------------------------------------------------ |
| `query`  | Yes      | Search text sent separately to each provider     |
| `limit`  | No       | Requested results per provider, from `1` to `10` |

Results remain in fixed Context7, npm, GitHub order and preserve each provider's native rank. Pipkin does not merge, deduplicate, correlate, score, or recommend across groups.

| Provider | What it contributes                                                  | Important boundary                                                                |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Context7 | Documentation availability, advertised versions, and quality signals | Does not retrieve documentation in this tool                                      |
| npm      | Public registry search candidates and observed search metadata       | Does not inspect manifests, dependencies, downloads, vulnerabilities, or tarballs |
| GitHub   | Public repository search metadata                                    | Popularity and activity are discovery signals only                                |

One or two provider failures remain visible beside successful groups; all-provider failure is a tool error. npm and GitHub do not retry or follow result links. Use `npm view <exact-name>` for detailed registry metadata after choosing a candidate.

## `code_search`

`code_search` performs one GitHub REST code search and returns bounded text-match excerpts in provider order.

| Argument     | Required | Meaning                                                                    |
| ------------ | -------- | -------------------------------------------------------------------------- |
| `query`      | Yes      | GitHub code-search text; GitHub syntax is allowed                          |
| `repository` | No       | Exact `owner/name` filter; mutually exclusive with `owner`                 |
| `owner`      | No       | Personal-account `user:owner` filter; mutually exclusive with `repository` |
| `language`   | No       | GitHub language qualifier                                                  |
| `filename`   | No       | Filename qualifier                                                         |
| `extension`  | No       | File extension without a leading dot                                       |
| `limit`      | No       | Requested matches, from `1` to `20`                                        |

There are no path, branch, organization, sort, pagination, regex, route, or URL arguments. `owner` intentionally targets a personal account; organization-wide owner search is unsupported.

Each accepted match contains a repository, revision SHA, repository-relative path, canonical GitHub blob URL, and bounded provider fragments. Reference does not fetch complete files, browse repositories, inspect issues or pull requests, clone repositories, or claim GitHub UI parity.

## Authentication and provider boundaries

Optional credentials live in `<getAgentDir()>/pipkin/auth.json`; see [Configuration](../configuration.md#reference-credentials).

- Context7 authorization is sent only to `https://context7.com`.
- GitHub authorization is sent only to `https://api.github.com`.
- The GitHub token's repository access defines `code_search` scope, including permitted private or internal source.
- `package_search` explicitly requests public repositories.

Reference does not use `gh` authentication, repository or npm configuration credentials, environment tokens, OAuth, GitHub Enterprise, or caller-supplied credentials. Requests, responses, subprocess streams, errors, and results are bounded. A shared invocation deadline and cancellation stop active provider work.
