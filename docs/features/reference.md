# Reference

Reference currently exposes one tool: `docs`. It retrieves documentation from **Context7 only**. Give it a library subject and a focused question; a direct Context7 ID beginning with `/` skips library search.

When `version` is omitted, `docs` asks Context7 for provider-current material. An explicit version is an exact pin: Pipkin compares only a trimmed, lowercase label with one leading `v` removed and underscores changed to dots. It never selects a compatible, nearest, prerelease, tag-equivalent, or current substitute. `latest` is an ordinary literal label and works only if Context7 advertises exactly that label. Named subjects examine no more than five provider-ranked candidates, prefer an exact normalized name, and visibly identify a provider-ranked fallback.

Results contain bounded Context7 snippets and provenance: selected ID and rank, current or exact-version state, source locations when supplied, warnings, retries, logical redirects, and visible truncation. The tool returns provider material rather than a synthesized answer.

Optional Context7 authentication is read only from `pipkin/auth.json` beneath Pi's agent directory, using its `context7` string field. The file and token are bounded; malformed credentials produce a safe actionable tool error. Requests use only the fixed `https://context7.com` origin, and bearer authorization is attached only there.

This milestone deliberately excludes project or dependency inference, manifests and lockfiles, package discovery, code search, arbitrary URLs, caches, model calls, children, subagents, and delegated research. Do not include secrets in the subject or question sent to Context7.
