# Reference

Reference exposes three bounded tools: `docs`, `package_search`, and `code_search`. They use fixed provider origins and accept only non-confidential search text. Do not send secrets, proprietary text, credentials, or sensitive identifiers to these providers.

## `docs`

`docs` retrieves Context7 documentation only. Give it a library subject and focused question; a direct Context7 ID beginning with `/` skips library search. Without `version`, it requests provider-current material. An explicit version is an exact Context7 pin: Pipkin never substitutes a compatible, nearest, tag-equivalent, or current release. `latest` is an ordinary literal that must be advertised by Context7.

Named subjects inspect at most five provider-ranked candidates, prefer an exact normalized name, and disclose a fallback. Results contain bounded provider snippets, selected ID/rank, version state, locations, warnings, retries, redirects, and truncation. They are provider material, not a synthesized answer.

## `package_search`

`package_search` concurrently returns three independent groups in fixed Context7, npm, GitHub order. Each provider retains its native one-based ranks, result count, failure, discarded count, and truncation state. Pipkin does not merge, deduplicate, correlate identities, score, compare, select, or recommend between groups.

- **Context7** performs library search only, with the query as both library name and search text. Its results are documentation-availability, advertised-version, and quality signals, not npm publication facts. It never retrieves documentation for this tool.
- **npm** invokes the installed npm client once against the fixed public `https://registry.npmjs.org/` registry. Results are current values observed in npm search output, not manifest, dependency, download, vulnerability, or tarball inspection.
- **GitHub** performs one repository REST search with an `is:public` qualifier at fixed `https://api.github.com`. Pipkin trusts GitHub to apply that qualifier, then bounds and normalizes returned repository metadata. Popularity and activity are discovery signals, not evidence of npm identity or suitability.

One or two provider failures remain visible beside successful groups. If all providers fail, the tool reports a normal error. npm and GitHub do not retry, follow result links, use credentials from the checkout or environment, or use alternate registries/origins.

## `code_search`

`code_search` searches GitHub REST code search once for bounded caller search text plus optional validated `repo:owner/name`, personal-account `user:owner`, `language:`, `filename:`, and `extension:` qualifiers. GitHub syntax is allowed in the search text, but there are no path, branch, organization, sort, pagination, regex, route, or URL inputs. `owner` deliberately means a personal account; organization-wide owner search is unsupported. Search scope is whatever the configured GitHub credential can access, including private or internal repositories when that credential permits them; matching source excerpts enter model context.

Pipkin trusts GitHub and the configured credential for repository authorization, then rejects malformed matches during bounded normalization. Accepted results retain GitHub order and contain bounded repository, revision SHA, repository-relative path, canonical GitHub blob URL, and provider text-match fragments/offsets. A match is observed credential-visible usage, not proof of correctness, authority, freshness, package identity, or repository health. Reference does not fetch files, browse repositories, inspect issues/pull requests/Actions, follow URLs, clone, or claim github.com UI parity.

## Authentication and limits

Optional Reference credentials live only in `<getAgentDir()>/pipkin/auth.json`. The bounded JSON object recognizes these optional string fields and ignores unrelated keys:

- `context7` for Context7 requests;
- `github` for a dedicated least-privilege token whose repository access defines the scope of `code_search`; `package_search` still requests public repositories.

Reference sends Context7 authorization only to `https://context7.com` and GitHub authorization only to `https://api.github.com`. It does not use `gh` authentication, repository config, npm config credentials, environment tokens, OAuth, GitHub Enterprise, or caller-supplied credentials. Requests, raw responses/process streams, fields, fragments, errors, and complete results are bounded; redirects are not followed for GitHub. Cancellation and one shared invocation deadline stop active provider work.
