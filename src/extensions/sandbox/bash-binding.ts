import type {
  AgentToolResult,
  BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { SandboxBashHost, SandboxBashRequest } from "./bash-capability.js";

type SandboxBashExecutor = (
  request: SandboxBashRequest,
) => Promise<AgentToolResult<BashToolDetails | undefined>>;
type Binding = { token: object; execute: SandboxBashExecutor };
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
): { dispose: () => void } {
  const manager = getManager();
  const token = {};
  manager.bindings.set(host, { token, execute });
  return {
    dispose() {
      if (manager.bindings.get(host)?.token === token) {
        manager.bindings.delete(host);
      }
    },
  };
}
