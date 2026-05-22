import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";

import type { Policy } from "../policy/defaults.js";

export type AccessMode = "read" | "write";

export type Decision =
  | { allow: true }
  | { allow: false; rule: string; matchedPattern?: string };

async function resolveWithFallback(rawPath: string, cwd: string): Promise<string> {
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

function resolveAllowListEntry(entry: string): string {
  try {
    return fs.realpathSync(path.resolve(entry));
  } catch {
    return path.resolve(entry);
  }
}

function isPathUnderAllowed(resolved: string, allowedEntries: string[]): boolean {
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
  ctx: { cwd: string }
): Promise<Decision> {
  const resolved = await resolveWithFallback(rawPath, ctx.cwd);

  const denyMatchers = policy.fs.denyPatterns.map((pat) => ({
    pat,
    match: picomatch(pat, { dot: true }),
  }));

  for (const { pat, match } of denyMatchers) {
    if (match(resolved)) {
      return { allow: false, rule: "denyPattern", matchedPattern: pat };
    }
  }

  const allowList = mode === "write" ? policy.fs.allowWrite : policy.fs.allowRead;
  if (!isPathUnderAllowed(resolved, allowList)) {
    return { allow: false, rule: `allowList:${mode}` };
  }

  return { allow: true };
}
