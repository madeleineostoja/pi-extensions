import { lstatSync } from "node:fs";
import {
  canonicalizeTarget,
  createFilesystemGrant,
  hasGrant,
  resolvePiToolPath,
  type AccessMode,
  type FilesystemGrant,
  type GrantKind,
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
      grant: FilesystemGrant;
      outsideBoundary: boolean;
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

function kindFor(path: string): GrantKind | null {
  try {
    return lstatSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return null;
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
): boolean {
  return (
    (tool === "read" || (tool === "grep" && kindFor(target) === "file")) &&
    isProtectedReadTarget(requested, target, cwd)
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
}): DirectFilesystemDecision {
  const requested = pathFor(options.tool, options.input);
  if (!requested) {
    return { kind: "deny", reason: "Guard: filesystem path is required." };
  }

  let requestedTarget: string;
  let target: string;
  try {
    requestedTarget = resolvePiToolPath(requested, options.cwd);
    target = canonicalizeTarget(
      requestedTarget,
      options.cwd,
      options.tool === "read",
    );
  } catch {
    return { kind: "deny", reason: "Guard: filesystem path is invalid." };
  }

  const access = accessFor(options.tool);
  const fixed = options.state.fixedCapabilities();
  const reachabilityEnabled =
    options.supportedMac && options.state.boundaryEnabled();
  if (reachabilityEnabled && !fixed) {
    return {
      kind: "deny",
      reason: "Guard: filesystem boundary is unavailable.",
    };
  }

  const outsideBoundary =
    reachabilityEnabled &&
    !hasGrant(fixed!.grants, target, access) &&
    !options.state.allowsReachability(target, access);
  const protectedRead =
    (isProtectedToolTarget(
      options.tool,
      requestedTarget,
      target,
      options.cwd,
    ) ||
      isProtectedToolTarget(
        options.tool,
        requestedTarget,
        target,
        fixed?.cwd ?? options.cwd,
      )) &&
    !options.state.allowsProtectedRead(target);

  if (!outsideBoundary && !protectedRead) {
    return { kind: "allow", target };
  }

  const grant = createFilesystemGrant(
    target,
    options.cwd,
    access,
    [
      ...(outsideBoundary ? (["outside-boundary"] as const) : []),
      ...(protectedRead ? (["protected-read"] as const) : []),
    ],
    isMutation(options.tool),
  );
  if (!grant) {
    return { kind: "deny", reason: "Guard: filesystem target is unavailable." };
  }
  return {
    kind: "approval-required",
    target,
    grant,
    outsideBoundary,
    protectedRead,
  };
}

export function prepareExplicitFilesystemGrant(options: {
  path: string;
  cwd: string;
  access: AccessMode;
  supportedMac: boolean;
  state: GuardRuntimeState;
}): FilesystemGrant | null {
  if (!options.supportedMac) {
    return null;
  }
  const fixed = options.state.fixedCapabilities();
  if (!fixed) {
    return null;
  }
  let requestedTarget: string;
  let target: string;
  try {
    requestedTarget = resolvePiToolPath(options.path, options.cwd);
    target = canonicalizeTarget(requestedTarget, options.cwd);
  } catch {
    return null;
  }
  const kind = kindFor(target);
  if (!kind) {
    return null;
  }
  const outsideBoundary = !hasGrant(fixed.grants, target, options.access);
  const protectedRead =
    kind === "file" &&
    (isProtectedReadTarget(requestedTarget, target, options.cwd) ||
      isProtectedReadTarget(requestedTarget, target, fixed.cwd));
  return createFilesystemGrant(target, options.cwd, options.access, [
    ...(outsideBoundary ? (["outside-boundary"] as const) : []),
    ...(protectedRead ? (["protected-read"] as const) : []),
  ]);
}
