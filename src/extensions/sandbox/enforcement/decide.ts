import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";

import type { Policy } from "../policy/defaults.js";

export type AccessMode = "read" | "write";

export type Decision =
  | { allow: true; resolvedPath: string }
  | {
      allow: false;
      rule: string;
      matchedPattern?: string;
      resolvedPath: string;
    };

async function resolveWithFallback(
  rawPath: string,
  cwd: string,
): Promise<string> {
  const abs = path.resolve(cwd, rawPath);
  try {
    return await fsPromises.realpath(abs);
  } catch {
    try {
      const parentReal = await fsPromises.realpath(path.dirname(abs));
      return path.join(parentReal, path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function resolveWithFallbackSync(rawPath: string, cwd: string): string {
  const abs = path.resolve(cwd, rawPath);
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      const parentReal = fs.realpathSync(path.dirname(abs));
      return path.join(parentReal, path.basename(abs));
    } catch {
      return abs;
    }
  }
}

export async function canonicalizeFsGrantPath(
  rawPath: string,
  cwd: string,
): Promise<string> {
  return resolveWithFallback(rawPath, cwd);
}

export function canonicalizeFsGrantPathSync(
  rawPath: string,
  cwd: string,
): string {
  return resolveWithFallbackSync(rawPath, cwd);
}

function resolveAllowListEntry(entry: string): string {
  try {
    return fs.realpathSync(path.resolve(entry));
  } catch {
    return path.resolve(entry);
  }
}

function isPathUnderAllowed(
  resolved: string,
  allowedEntries: string[],
): boolean {
  for (const entry of allowedEntries) {
    const real = resolveAllowListEntry(entry);
    if (resolved === real || resolved.startsWith(real + path.sep)) {
      return true;
    }
  }
  return false;
}

export async function decideFsAccess(
  rawPath: string,
  mode: AccessMode,
  policy: Policy,
  ctx: { cwd: string },
): Promise<Decision> {
  const resolved = await resolveWithFallback(rawPath, ctx.cwd);

  const denyMatchers = policy.fs.denyPatterns.map((pat) => ({
    pat,
    match: picomatch(pat, { dot: true }),
  }));

  for (const { pat, match } of denyMatchers) {
    if (match(resolved)) {
      return {
        allow: false,
        rule: "denyPattern",
        matchedPattern: pat,
        resolvedPath: resolved,
      };
    }
  }

  const allowList =
    mode === "write" ? policy.fs.allowWrite : policy.fs.allowRead;
  if (!isPathUnderAllowed(resolved, allowList)) {
    return { allow: false, rule: `allowList:${mode}`, resolvedPath: resolved };
  }

  return { allow: true, resolvedPath: resolved };
}
