import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { extractJsonObject } from "./graph.js";
import {
  hashContent,
  isWithinAnyAllowedRoot,
  looksLikeUrl,
  stripFragment,
  type MaterialStore,
} from "./material-store.js";

export type NeedsMaterialRequest = {
  pathHint: string;
  relativeTo?: string;
  reason: string;
};

export type NeedsMaterialResponse = {
  kind: "needs_material";
  requests: NeedsMaterialRequest[];
};

export type ResolvedNeedsMaterialFile = {
  absolutePath: string;
  displayPath: string;
  content: string;
  hash: string;
};

export type NeedsMaterialResolutionResult = {
  files: ResolvedNeedsMaterialFile[];
  errors: string[];
};

export function parseNeedsMaterialResponse(
  text: string,
): { ok: true; value: NeedsMaterialResponse } | { ok: false; reason: string } {
  const candidate = extractJsonObject(text);
  if (!candidate.ok) {
    return candidate;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.text);
  } catch {
    return { ok: false, reason: "Needs-material response is not valid JSON." };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: "Needs-material response JSON must be an object.",
    };
  }

  const obj = parsed;
  if (obj.kind !== "needs_material") {
    return {
      ok: false,
      reason: `Needs-material response kind must be "needs_material", got: ${String(obj.kind)}.`,
    };
  }

  if (!Array.isArray(obj.requests)) {
    return {
      ok: false,
      reason: "Needs-material response requests must be an array.",
    };
  }

  const requests: NeedsMaterialRequest[] = [];
  for (let i = 0; i < obj.requests.length; i++) {
    const reqResult = parseNeedsMaterialRequest(obj.requests[i], i);
    if (!reqResult.ok) {
      return { ok: false, reason: reqResult.reason };
    }
    requests.push(reqResult.value);
  }

  return { ok: true, value: { kind: "needs_material", requests } };
}

function parseNeedsMaterialRequest(
  value: unknown,
  index: number,
): { ok: true; value: NeedsMaterialRequest } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: `Needs-material response requests[${index}] must be an object.`,
    };
  }

  const obj = value;
  if (typeof obj.pathHint !== "string" || obj.pathHint.trim().length === 0) {
    return {
      ok: false,
      reason: `Needs-material response requests[${index}] pathHint must be a non-empty string.`,
    };
  }

  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
    return {
      ok: false,
      reason: `Needs-material response requests[${index}] reason must be a non-empty string.`,
    };
  }

  const relativeTo =
    obj.relativeTo === undefined
      ? undefined
      : typeof obj.relativeTo === "string" && obj.relativeTo.trim().length > 0
        ? obj.relativeTo.trim()
        : undefined;

  return {
    ok: true,
    value: {
      pathHint: obj.pathHint.trim(),
      ...(relativeTo !== undefined ? { relativeTo } : {}),
      reason: obj.reason.trim(),
    },
  };
}

export function resolveNeedsMaterialRequests(
  requests: NeedsMaterialRequest[],
  store: MaterialStore,
): NeedsMaterialResolutionResult {
  const files: ResolvedNeedsMaterialFile[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  if (requests.length === 0) {
    errors.push("No material requests were provided.");
  }

  for (const request of requests) {
    const resolution = resolveNeedsMaterialRequest(request, store);
    if (!resolution.ok) {
      errors.push(resolution.reason);
      continue;
    }

    const key = resolution.value.absolutePath;
    if (seen.has(key)) {
      continue;
    }
    if (store.files.some((file) => file.absolutePath === key)) {
      // Preserve frozen-content/hash semantics for paths already in the store.
      continue;
    }
    seen.add(key);
    files.push(resolution.value);
  }

  if (files.length === 0 && errors.length === 0) {
    errors.push(
      "All requested material paths are already present in the material store.",
    );
  }

  return { files, errors };
}

function resolveNeedsMaterialRequest(
  request: NeedsMaterialRequest,
  store: MaterialStore,
):
  | { ok: true; value: ResolvedNeedsMaterialFile }
  | { ok: false; reason: string } {
  if (looksLikeUrl(request.pathHint)) {
    return {
      ok: false,
      reason: `URL material request not allowed: ${request.pathHint}`,
    };
  }

  const targetPath = stripFragment(request.pathHint).trim();
  if (!targetPath) {
    return {
      ok: false,
      reason: `empty material request target: ${request.pathHint}`,
    };
  }

  const baseDir = resolveRelativeBase(request.relativeTo, store);
  const absolutePath = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(baseDir, targetPath);

  if (!isWithinAnyAllowedRoot(absolutePath, store.allowedRoots)) {
    return {
      ok: false,
      reason: `material request target escapes allowed roots: ${request.pathHint}`,
    };
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolutePath);
  } catch {
    return {
      ok: false,
      reason: `missing or unreadable material request target: ${request.pathHint}`,
    };
  }

  if (stat.isDirectory()) {
    return {
      ok: false,
      reason: `material request target is a directory: ${request.pathHint}`,
    };
  }

  if (!targetPath.toLowerCase().endsWith(".md")) {
    return {
      ok: false,
      reason: `non-markdown material request target: ${request.pathHint}`,
    };
  }

  let content: string;
  try {
    content = readFileSync(absolutePath, "utf-8");
  } catch {
    return {
      ok: false,
      reason: `missing or unreadable material request target: ${request.pathHint}`,
    };
  }

  if (!content.trim()) {
    return {
      ok: false,
      reason: `empty or whitespace-only material request target: ${request.pathHint}`,
    };
  }

  return {
    ok: true,
    value: {
      absolutePath,
      displayPath: targetPath,
      content,
      hash: hashContent(content),
    },
  };
}

function resolveRelativeBase(
  relativeTo: string | undefined,
  store: MaterialStore,
): string {
  if (relativeTo === undefined || relativeTo === "plan") {
    return store.planDir;
  }
  if (relativeTo === "repo") {
    return store.repoRoot ?? store.planDir;
  }
  return isAbsolute(relativeTo)
    ? resolve(relativeTo)
    : resolve(store.planDir, relativeTo);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNeedsMaterialResponse(
  value: unknown,
): value is NeedsMaterialResponse {
  return (
    isRecord(value) &&
    value.kind === "needs_material" &&
    Array.isArray(value.requests) &&
    value.requests.every(
      (req) =>
        isRecord(req) &&
        typeof req.pathHint === "string" &&
        typeof req.reason === "string",
    )
  );
}
