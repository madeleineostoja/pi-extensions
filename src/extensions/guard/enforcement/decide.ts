import { lstatSync } from "node:fs";
import {
  canonicalizeTarget,
  hasGrant,
  resolvePiToolPath,
  type AccessMode,
  type PiPathCompatibility,
} from "../capabilities.js";
import { isProtectedReadTarget } from "../protected.js";
import type { GuardRuntimeState } from "../state.js";

export type DirectFilesystemTool =
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "write"
  | "edit";

export type DirectFilesystemDecision =
  | { kind: "allow"; target: string }
  | {
      kind: "approval-required";
      target: string;
      access: AccessMode;
      outsideSandbox: boolean;
      protectedRead: boolean;
    }
  | { kind: "deny"; reason: string };

type DirectInput = Readonly<{ path?: unknown }>;

function accessFor(tool: DirectFilesystemTool): AccessMode {
  return tool === "write" || tool === "edit" ? "write" : "read";
}

function isMutation(tool: DirectFilesystemTool): boolean {
  return tool === "write" || tool === "edit";
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function pathFor(
  tool: DirectFilesystemTool,
  input: DirectInput,
): string | null {
  if (tool === "grep" || tool === "find" || tool === "ls") {
    return typeof input.path === "string" && input.path ? input.path : ".";
  }
  return typeof input.path === "string" && input.path ? input.path : null;
}

function isProtectedToolTarget(
  tool: DirectFilesystemTool,
  requested: string,
  target: string,
  cwd: string,
  compatibility: PiPathCompatibility,
): boolean {
  let fileTarget = false;
  try {
    fileTarget = !lstatSync(target).isDirectory();
  } catch {}
  return (
    (tool === "read" || (tool === "grep" && fileTarget)) &&
    isProtectedReadTarget(requested, target, cwd, compatibility)
  );
}

export function isSupportedMac(
  platform = process.platform,
  arch = process.arch,
): boolean {
  return platform === "darwin" && (arch === "arm64" || arch === "x64");
}

export function decideDirectFilesystemTool(options: {
  tool: DirectFilesystemTool;
  input: DirectInput;
  cwd: string;
  supportedMac: boolean;
  state: GuardRuntimeState;
  pathCompatibility?: PiPathCompatibility;
}): DirectFilesystemDecision {
  const requested = pathFor(options.tool, options.input);
  if (!requested) {
    return { kind: "deny", reason: "Guard: filesystem path is required." };
  }

  const compatibility = options.pathCompatibility ?? {};
  let requestedTarget: string;
  let target: string;
  try {
    requestedTarget = resolvePiToolPath(requested, options.cwd, compatibility);
    target = canonicalizeTarget(
      requestedTarget,
      options.cwd,
      options.tool === "read",
      compatibility,
    );
  } catch {
    return { kind: "deny", reason: "Guard: filesystem path is invalid." };
  }

  const access = accessFor(options.tool);
  const fixed = options.state.fixedCapabilities();
  const sandboxEnabled =
    options.supportedMac && options.state.boundaryEnabled();
  if (sandboxEnabled && !fixed) {
    return {
      kind: "deny",
      reason: "Guard: filesystem sandbox is unavailable.",
    };
  }

  const outsideSandbox =
    sandboxEnabled && !hasGrant(fixed!.grants, target, access);
  const protectedRead =
    isProtectedToolTarget(
      options.tool,
      requestedTarget,
      target,
      options.cwd,
      compatibility,
    ) ||
    isProtectedToolTarget(
      options.tool,
      requestedTarget,
      target,
      fixed?.cwd ?? options.cwd,
      compatibility,
    );

  if (!outsideSandbox && !protectedRead) {
    return { kind: "allow", target };
  }
  if (!isMutation(options.tool) && !exists(target)) {
    return { kind: "deny", reason: "Guard: filesystem target is unavailable." };
  }
  return {
    kind: "approval-required",
    target,
    access,
    outsideSandbox,
    protectedRead,
  };
}
