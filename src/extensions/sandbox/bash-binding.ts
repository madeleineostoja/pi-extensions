import type {
  AgentToolResult,
  BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import {
  SANDBOX_BASH_LOOKUP_CHANNEL,
  type SandboxBashHost,
  type SandboxBashRequest,
  type SandboxExecutionLease,
  type SandboxManagedRequest,
} from "./bash-capability.js";

type SandboxBashExecutor = (
  request: SandboxBashRequest,
) => Promise<AgentToolResult<BashToolDetails | undefined>>;
type SandboxManagedExecutor = (
  request: SandboxManagedRequest,
) => Promise<SandboxExecutionLease>;
type Binding = {
  token: object;
  execute: SandboxBashExecutor;
  startManaged: SandboxManagedExecutor | undefined;
};
type SandboxBashManager = { bindings: WeakMap<object, Binding> };

const managerKey = Symbol.for("pipkin:sandbox:bash");

function getManager(): SandboxBashManager {
  const globalScope = globalThis as Record<symbol, unknown>;
  const existing = globalScope[managerKey] as SandboxBashManager | undefined;
  if (existing) {
    return existing;
  }
  const manager: SandboxBashManager = { bindings: new WeakMap() };
  globalScope[managerKey] = manager;
  return manager;
}

export function bindSandboxBashExecutor(
  host: SandboxBashHost,
  execute: SandboxBashExecutor,
  startManaged?: SandboxManagedExecutor,
): { dispose: () => void } {
  const manager = getManager();
  const token = {};
  const binding = { token, execute, startManaged };
  manager.bindings.set(host, binding);
  const unsubscribe = host.on?.(SANDBOX_BASH_LOOKUP_CHANNEL, (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { resolve?: unknown }).resolve === "function"
    ) {
      (value as { resolve: (value: Binding) => void }).resolve(binding);
    }
  });
  return {
    dispose() {
      unsubscribe?.();
      if (manager.bindings.get(host)?.token === token) {
        manager.bindings.delete(host);
      }
    },
  };
}
