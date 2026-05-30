import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REVIEW_AGENT_NAME = "review";

export type ScaffoldReviewAgentResult =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string };

export function getGlobalReviewAgentPath(agentDir: string): string {
  return join(agentDir, "agents", `${REVIEW_AGENT_NAME}.md`);
}

export function readBundledReviewAgent(): string {
  return readFileSync(new URL("../agents/review.md", import.meta.url), "utf-8");
}

export function globalReviewAgentExists(agentDir: string): boolean {
  return existsSync(getGlobalReviewAgentPath(agentDir));
}

export function scaffoldGlobalReviewAgent(
  agentDir: string,
): ScaffoldReviewAgentResult {
  const path = getGlobalReviewAgentPath(agentDir);
  if (existsSync(path)) {
    return {
      ok: false,
      path,
      reason: `A global ${REVIEW_AGENT_NAME} agent already exists at ${path}.`,
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readBundledReviewAgent(), {
    encoding: "utf-8",
    flag: "wx",
  });
  return { ok: true, path };
}
