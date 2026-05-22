import { resolve, join } from "node:path";
import { homedir } from "node:os";

const FILE_BEARING_TOOLS = new Set(["read", "edit", "write"]);

// Path normalization mirrors Pi's own path-utils logic:
// - strip a leading @ (some models emit it; Pi strips it before resolution)
// - expand ~/ to the home directory
// We intentionally skip realpath() — it's async, fails for non-existent paths,
// and our matching is a best-effort heuristic that doesn't need canonical symlink resolution.
export function normalizePath(input: unknown, cwd: string): string | null {
	if (typeof input !== "string") return null;
	let s = input.trim();
	if (s.length === 0) return null;
	if (s.startsWith("@")) s = s.slice(1);
	if (s.length === 0) return null;
	if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
	return resolve(cwd, s);
}

// Pi's built-in tools accept both "path" and "file_path" (file_path takes lower priority).
// We mirror that fallback so superseded/duplicate detection fires regardless of which key the model used.
export function extractFilePath(toolName: string, input: unknown): string | null {
	if (!FILE_BEARING_TOOLS.has(toolName)) return null;
	if (typeof input !== "object" || input === null) return null;
	const obj = input as Record<string, unknown>;
	if (typeof obj["path"] === "string") return obj["path"];
	if (typeof obj["file_path"] === "string") return obj["file_path"];
	return null;
}
