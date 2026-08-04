# Web Fetch

`web_fetch` retrieves one public HTTP(S) URL. `batch_web_fetch` retrieves one through eight of the same request objects with a fixed four-worker pool and a 120-second aggregate deadline. Both treat fetched pages as untrusted external data, never as instructions.

Each request accepts a URL and these optional bounded fields: `raw` (default `false`), `maxChars` (default 40,000; integer 1–40,000), `timeoutMs` (default 15,000 ms; integer 1,000–120,000 ms), `removeImages` (default `true`), and `includeReplies` (default `"extractors"`; also accepts `true` or `false`). Both tools use this exact request shape; batch accepts only its 1–8 item `requests` array and no batch options.

Normal requests detect the bounded response body automatically: valid JSON is pretty-printed, HTML is extracted as readable markdown, and other textual content is returned as plain text. Detection does not require the server's declared content type to be accurate. Attachments and non-text responses stream to temporary binary artifacts. Set `raw: true` only to bypass automatic detection and extraction: the complete untouched textual response is saved to a temporary artifact and a bounded verbatim preview is returned.

Responses are capped at 5 MiB before parsing; raw text uses the same limit. Binary artifacts have a 25 MiB limit, and extractor POST bodies are capped at 1 MiB. The tools manually follow at most five HTTP redirects and five immediate meta-refresh redirects. Batch output reserves status metadata for every item, preserves request order, divides the 48 KiB/1,900-line result budget fairly, and visibly marks omitted content. A valid batch can report individual failures beside successful items; a completely failed batch is an error.

The tools use a fixed browser-grade Chrome/Windows transport and validate the initial URL plus every HTTP redirect, immediate meta refresh, and extractor request. URL credentials, localhost names, private addresses, and DNS results containing any non-public answer are rejected. DNS validation uses the host resolver, but the browser transport resolves independently afterwards; this leaves a DNS-rebinding window and is not address pinning or a network sandbox.

There is no JavaScript execution, crawling, ordinary linked-asset retrieval, authentication, cookies, caller headers, proxy, private-network exception, cache, settings, environment configuration, or caller-controlled browser, temporary path, or concurrency. Raw mode accepts only textual responses. Binary artifact bytes never enter tool output or details.

Artifacts live in one private, unpredictable session-temporary directory and are deleted when the session shuts down. Copy a returned artifact path during the live session if it must persist. A later direct `read` can inspect that canonical path without another mechanism. Artifact writes are trusted Web Fetch extension writes beneath its own temporary directory: they are outside Sandbox and are not routed through Readonly's separate public `edit`/`write` mediation.

Use Web Fetch for direct public URL retrieval. Use Reference's `docs` for known-library documentation, `package_search` for package discovery, and `code_search` or the GitHub tool/skill for GitHub source and repository workflows. No tool automatically falls back to another.

If you separately installed `pi-smart-fetch`, remove it before reloading Pipkin so its external tool registration does not collide with Pipkin's Web Fetch tools.
