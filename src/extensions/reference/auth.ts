import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, byteLength, hasControl } from "./bounds.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

type ReadFile = (path: string) => Buffer;

export function loadContext7Auth(
  agentDir: string,
  readFile: ReadFile = readAgentAuthFile,
): string | undefined {
  return loadReferenceAuth(agentDir, "context7", readFile);
}

export function loadGithubAuth(
  agentDir: string,
  readFile: ReadFile = readAgentAuthFile,
): string | undefined {
  return loadReferenceAuth(agentDir, "github", readFile);
}

function loadReferenceAuth(
  agentDir: string,
  field: "context7" | "github",
  readFile: ReadFile,
): string | undefined {
  let raw: Buffer;
  try {
    raw = readFile(join(agentDir, "pipkin", "auth.json"));
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    throw new AuthError(
      `${provider(field)} authentication file could not be read; fix or remove its credential.`,
    );
  }
  if (raw.byteLength > LIMITS.authFileBytes) {
    throw new AuthError(
      `${provider(field)} authentication data is too large; keep the credential file within the supported limit.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AuthError(
      `${provider(field)} authentication data is malformed; use valid JSON.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthError(
      `${provider(field)} authentication data is malformed; use a JSON object.`,
    );
  }
  const token = (parsed as Record<string, unknown>)[field];
  if (token === undefined) {
    return undefined;
  }
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    token !== token.trim() ||
    hasControl(token) ||
    byteLength(token) > LIMITS.tokenBytes
  ) {
    throw new AuthError(
      `${provider(field)} credential is malformed; provide one non-empty bounded ${field} string.`,
    );
  }
  return token;
}

function provider(field: "context7" | "github"): string {
  return field === "context7" ? "Context7" : "GitHub";
}

function readAgentAuthFile(path: string): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(LIMITS.authFileBytes + 1);
    const bytes = readSync(descriptor, buffer);
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(descriptor);
  }
}
