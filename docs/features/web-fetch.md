# Web Fetch

`web_fetch` retrieves readable content from one public HTTP(S) URL. It accepts `markdown` (default), cleaned `html`, `text`, validated `json`, and `raw` output, and treats every fetched page as untrusted external data rather than instructions.

The tool uses a fixed browser-grade Chrome/Windows transport, manually follows a small number of redirects, and validates the initial URL plus every HTTP redirect, immediate meta refresh, alternate representation, and extractor request. URL credentials, localhost names, private addresses, and DNS results containing any non-public answer are rejected. DNS validation uses the host resolver, but the browser transport resolves independently afterwards; this leaves a DNS-rebinding window and is not address pinning or a network sandbox.

Responses are capped at 5 MiB before parsing. `raw` accepts only textual responses up to that same limit, saves the complete response to a temporary artifact, skips extraction, and returns a `maxChars`-bounded verbatim preview. Attachments and non-text responses stream to a temporary binary artifact with a 25 MiB limit; their bytes are never placed in tool output or details. Returned ordinary content and raw previews obey the requested `maxChars` limit (up to 40,000), then Pi's 48 KiB and 1,900-line result limits with visible notices. There are no cookies, caller headers, proxy, profile, or private-network exceptions.

Artifacts live in one private, unpredictable session-temporary directory and are deleted when the session shuts down. Copy a returned artifact path during the live session if it must persist. A later direct `read` may inspect that canonical path without another mechanism. Artifact writes are trusted Web Fetch extension writes beneath its own temporary directory: they are not routed through Sandbox, and Readonly's separate public `edit`/`write` mediation does not apply.

Use `web_fetch` for direct public URL retrieval. Use Reference's `docs` for known-library documentation, `package_search` for package discovery, and `code_search` for public GitHub source search.
