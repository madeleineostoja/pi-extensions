import type { SandboxPolicy } from "./policy.js";

export type SandboxSessionState = {
  enabled: () => boolean;
  policy: () => SandboxPolicy | undefined;
  unavailableReason: () => string | undefined;
  reset: (policy?: SandboxPolicy, unavailableReason?: string) => void;
  revoke: () => void;
  setEnabled: (enabled: boolean) => void;
};

export function createSandboxSessionState(): SandboxSessionState {
  let enabled = true;
  let resolvedPolicy: SandboxPolicy | undefined;
  let failure: string | undefined;

  return {
    enabled: () => enabled,
    policy: () => resolvedPolicy,
    unavailableReason: () => failure,
    reset(policy, unavailableReason) {
      enabled = true;
      resolvedPolicy = policy;
      failure = unavailableReason;
    },
    revoke() {
      resolvedPolicy = undefined;
      failure = undefined;
    },
    setEnabled(value) {
      enabled = value;
    },
  };
}
