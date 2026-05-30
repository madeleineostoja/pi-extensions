import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ParsedPlan } from "./plan.js";

const PLAN_REF_RE = /Plan:\s*(?:`([^`]+)`|<([^>]+)>)/;

export function resolvePlanArtifacts(
  sourcePlanPath: string,
  plan: ParsedPlan,
): string[] {
  const sourceDir = dirname(sourcePlanPath);
  const artifacts = new Set<string>();
  artifacts.add(resolve(sourcePlanPath));

  for (const task of plan.tasks) {
    for (const line of task.blockLines) {
      const match = PLAN_REF_RE.exec(line);
      if (!match) {
        continue;
      }
      const raw = (match[1] ?? match[2] ?? "").trim();
      if (!raw) {
        continue;
      }
      if (looksLikeUrl(raw)) {
        continue;
      }
      if (!raw.toLowerCase().endsWith(".md")) {
        continue;
      }
      const absolute = isAbsolute(raw) ? raw : join(sourceDir, raw);
      artifacts.add(resolve(absolute));
    }
  }

  return [...artifacts];
}

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    // If it looks like a URL with protocol, treat as URL even if invalid
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  }
}
