import type { SandboxPolicy } from "./policy.js";
import type { SandboxWriteMode } from "./write-mode.js";

export type SandboxSessionState = {
  enabled: () => boolean;
  writeMode: () => SandboxWriteMode;
  repositoryReadOnly: () => boolean;
  policy: () => SandboxPolicy | undefined;
  unavailableReason: () => string | undefined;
  reset: (
    policy?: SandboxPolicy,
    unavailableReason?: string,
    writeMode?: SandboxWriteMode,
  ) => void;
  revoke: () => void;
  setEnabled: (enabled: boolean) => void;
};

export function createSandboxSessionState(): SandboxSessionState {
  let enabled = true;
  let resolvedWriteMode: SandboxWriteMode = "workspace-write";
  let resolvedPolicy: SandboxPolicy | undefined;
  let failure: string | undefined;

  return {
    enabled: () => enabled,
    writeMode: () => resolvedWriteMode,
    repositoryReadOnly: () => resolvedWriteMode === "repository-read-only",
    policy: () => resolvedPolicy,
    unavailableReason: () => failure,
    reset(policy, unavailableReason, writeMode = "workspace-write") {
      enabled = true;
      resolvedWriteMode = writeMode;
      resolvedPolicy = policy;
      failure = unavailableReason;
    },
    revoke() {
      resolvedWriteMode = "workspace-write";
      resolvedPolicy = undefined;
      failure = undefined;
    },
    setEnabled(value) {
      enabled = value;
    },
  };
}
