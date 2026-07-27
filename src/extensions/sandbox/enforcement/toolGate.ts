/**
 * In-process tool gate for Pi's built-in FS tools.
 *
 * Pi's built-in FS tools (read/write/edit/ls/find/grep) run in-process inside
 * the Pi JS runtime and never spawn a subprocess, so the kernel sandbox layer
 * cannot see them. This module intercepts tool_call events for those tools and
 * enforces the same policy that the subprocess layer applies to bash commands.
 *
 * This is also the authoritative enforcer for denyPatterns on Linux, where
 * Landlock is allow-only and glob-based deny semantics must be handled here.
 *
 * Out of scope: in-process network calls (Pi's own fetch() and HTTP). Those are
 * out of scope for the sandbox layer — the permissions extension is the only
 * enforcement mechanism for in-process HTTP. See the threat model in README.
 *
 * TOCTOU note: Pi may evaluate a path between our check and the real FS
 * operation. This is a known weakness of in-process gates; the kernel layer is
 * authoritative for bash. This is documented rather than worked around.
 */

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { Policy } from "../policy/defaults.js";
import type { ManifestContext } from "./caps.js";
import type { AuditEntry } from "../audit/schema.js";
import type { SessionState } from "../slash/commands.js";
import { applySessionOverrides } from "../policy/effective.js";
import { decideFsAccess, type Decision } from "./decide.js";

export { type ToolCallEvent };

export const BLOCK_REASON = "sandbox: path denied";

export type AccessMode = "read" | "write";

export type ToolGateResult = {
  block: true;
  reason: string;
  toolName: string;
  rawPath: string;
  modes: AccessMode[];
  decision: Extract<Decision, { allow: false }>;
};

export type ToolGateOptions = {
  getPolicy: () => Policy;
  getSession?: () => SessionState;
  ctx: ManifestContext;
  /** Optional callback invoked for every allow/block decision. */
  onAudit?: (entry: Omit<AuditEntry, "ts">) => void;
};

type ToolSpec = {
  mode: AccessMode | "readwrite";
  getPath: (input: Record<string, unknown>) => string | undefined;
};

const TOOL_SPECS: Record<string, ToolSpec> = {
  read: { mode: "read", getPath: (i) => i.path as string | undefined },
  ls: { mode: "read", getPath: (i) => i.path as string | undefined },
  find: { mode: "read", getPath: (i) => i.path as string | undefined },
  grep: { mode: "read", getPath: (i) => i.path as string | undefined },
  write: { mode: "write", getPath: (i) => i.path as string | undefined },
  edit: { mode: "readwrite", getPath: (i) => i.path as string | undefined },
};

export type ToolGate = {
  /**
   * Handle a tool_call event. Returns a block result to abort the call, or
   * undefined to allow it.
   */
  handleToolCall(event: ToolCallEvent): Promise<ToolGateResult | undefined>;

  /** Tear down any resources held by this gate. */
  dispose(): void;
};

export function createToolGate(opts: ToolGateOptions): ToolGate {
  const { getPolicy, getSession, ctx, onAudit } = opts;

  function effectivePolicy(): Policy {
    const base = getPolicy();
    return getSession ? applySessionOverrides(base, getSession()) : base;
  }

  async function handleToolCall(
    event: ToolCallEvent,
  ): Promise<ToolGateResult | undefined> {
    if (event.toolName === "bash") {
      return undefined;
    }

    const spec = TOOL_SPECS[event.toolName];
    if (!spec) {
      return undefined;
    }

    const eff = effectivePolicy();
    if (!eff.enabled) {
      return undefined;
    }

    const rawPath = spec.getPath(event.input as Record<string, unknown>);
    if (rawPath == null || typeof rawPath !== "string") {
      return undefined;
    }

    const modes: AccessMode[] =
      spec.mode === "readwrite" ? ["read", "write"] : [spec.mode];
    for (const mode of modes) {
      const decision = await decideFsAccess(rawPath, mode, eff, {
        cwd: ctx.cwd,
      });
      if (!decision.allow) {
        onAudit?.({
          kind: "fs",
          decision: "blocked",
          tool: event.toolName,
          path: decision.resolvedPath,
          rule: decision.rule,
        });
        const result: ToolGateResult = {
          block: true,
          reason: BLOCK_REASON,
        } as ToolGateResult;
        Object.defineProperties(result, {
          toolName: { value: event.toolName },
          rawPath: { value: rawPath },
          modes: { value: modes },
          decision: { value: decision },
        });
        return result;
      }
    }

    return undefined;
  }

  const dispose = (): void => {};

  return { handleToolCall, dispose };
}
