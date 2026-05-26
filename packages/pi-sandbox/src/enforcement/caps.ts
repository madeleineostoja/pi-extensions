import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { Policy } from "../policy/defaults.js";
import { literalPrefix } from "./glob-prefix.js";

export type ManifestContext = {
  hasUI: boolean;
  cwd: string;
  platform?: NodeJS.Platform;
  ui: {
    notify: (text: string, level: "warning" | "error") => void;
  };
};

export type NonoFilesystemDeny = {
  access?: string[];
  unlink?: string[];
};

export type NonoFilesystem = {
  allow_read?: string[];
  allow_write?: string[];
  deny?: NonoFilesystemDeny;
};

export type NonoNetwork = {
  allow_domain?: string[];
};

export type CapabilityManifest = {
  filesystem?: NonoFilesystem;
  network?: NonoNetwork;
};

// nono-ts CapabilitySet is not installable; define a compatible interface.
export type CapabilitySet = {
  queryPath(p: string, mode: "read" | "write"): boolean;
  platformRules: string[];
};

export function escapeSeatbeltString(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) {
      throw new Error(
        `pi-sandbox: refusing to emit Seatbelt rule for path with control characters: ${JSON.stringify(s)}`,
      );
    }
  }
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function expandToken(p: string, cwd: string): string {
  if (p === "<cwd>" || p.startsWith("<cwd>/")) {
    return cwd + p.slice("<cwd>".length);
  }
  if (p === "~" || p.startsWith("~/")) {
    return os.homedir() + p.slice(1);
  }
  return p;
}

function filterExistingPaths(
  paths: string[],
  cwd: string,
  ctx: ManifestContext,
  warnedPaths: Set<string>,
): string[] {
  const result: string[] = [];
  for (const p of paths) {
    const expanded = expandToken(p, cwd);
    const resolved = path.resolve(expanded);
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
    } catch {
      if (!warnedPaths.has(resolved)) {
        warnedPaths.add(resolved);
        ctx.ui.notify(
          `pi-sandbox: capability manifest: path does not exist and will be skipped: ${resolved}`,
          "warning",
        );
      }
      continue;
    }
    result.push(canonical);
  }
  return result;
}

export type CapsInstance = {
  buildManifest: (policy: Policy, ctx: ManifestContext) => CapabilityManifest;
  buildCapabilitySet: (policy: Policy, ctx: ManifestContext) => CapabilitySet;
};

export function createCaps(): CapsInstance {
  const warnedMissingPaths = new Set<string>();

  function buildManifest(
    policy: Policy,
    ctx: ManifestContext,
  ): CapabilityManifest {
    const platform = ctx.platform ?? process.platform;
    const cwd = ctx.cwd;
    const manifest: CapabilityManifest = {};

    const allowRead = filterExistingPaths(
      policy.fs.allowRead,
      cwd,
      ctx,
      warnedMissingPaths,
    );
    const allowWrite = filterExistingPaths(
      policy.fs.allowWrite,
      cwd,
      ctx,
      warnedMissingPaths,
    );

    const filesystem: NonoFilesystem = {};
    if (allowRead.length > 0) filesystem.allow_read = allowRead;
    if (allowWrite.length > 0) filesystem.allow_write = allowWrite;

    if (platform === "darwin") {
      const denyAccess: string[] = [];
      for (const pattern of policy.fs.denyPatterns) {
        const prefix = literalPrefix(pattern);
        if (prefix !== null) {
          denyAccess.push(prefix);
        }
      }
      if (denyAccess.length > 0) {
        filesystem.deny = { access: denyAccess };
      }
    }

    if (
      filesystem.allow_read !== undefined ||
      filesystem.allow_write !== undefined ||
      filesystem.deny !== undefined
    ) {
      manifest.filesystem = filesystem;
    }

    const { mode, allow } = policy.network;

    // mode === "off" means no network filtering: omit the network section
    // entirely so nono leaves outbound traffic unrestricted. Deny-all is
    // expressible as { mode: "always", allow: [] }.
    let applyAllowlist = false;
    if (mode === "always") {
      applyAllowlist = true;
    } else if (mode === "non-interactive-only") {
      applyAllowlist = !ctx.hasUI;
    }

    if (applyAllowlist) {
      manifest.network = { allow_domain: [...allow] };
    }

    return manifest;
  }

  function buildCapabilitySet(
    policy: Policy,
    ctx: ManifestContext,
  ): CapabilitySet {
    const platform = ctx.platform ?? process.platform;
    const cwd = ctx.cwd;

    const allowRead = new Set(
      filterExistingPaths(policy.fs.allowRead, cwd, ctx, warnedMissingPaths),
    );
    const allowWrite = new Set(
      filterExistingPaths(policy.fs.allowWrite, cwd, ctx, warnedMissingPaths),
    );

    const platformRules: string[] = [];
    if (platform === "darwin") {
      for (const pattern of policy.fs.denyPatterns) {
        const prefix = literalPrefix(pattern);
        if (prefix !== null) {
          platformRules.push(
            `(deny file-read* (path-prefix "${escapeSeatbeltString(prefix)}"))`,
          );
        }
      }
    }

    function queryPath(p: string, mode: "read" | "write"): boolean {
      let abs: string;
      try {
        abs = fs.realpathSync(path.resolve(p));
      } catch {
        abs = path.resolve(p);
      }
      const set = mode === "write" ? allowWrite : allowRead;
      for (const allowed of set) {
        if (abs === allowed || abs.startsWith(allowed + path.sep)) {
          return true;
        }
      }
      return false;
    }

    return { queryPath, platformRules };
  }

  return {
    buildManifest,
    buildCapabilitySet,
  };
}
