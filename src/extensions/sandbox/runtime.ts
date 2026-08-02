import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SandboxHost = ExtensionAPI["events"];

export type SandboxHostBinding = {
  inheritedEnabled: boolean | undefined;
  dispose: () => void;
};

type HostBinding = {
  token: object;
  enabled: () => boolean;
};

type PendingInheritance = {
  token: object;
  enabled: boolean;
};

type SandboxRuntimeManager = {
  hosts: WeakMap<object, HostBinding>;
  pendingChildren: WeakMap<object, PendingInheritance>;
};

const runtimeManagerKey = Symbol.for("pipkin:sandbox:runtime");

function getRuntimeManager(): SandboxRuntimeManager {
  const globalScope = globalThis as Record<symbol, unknown>;
  const existing = globalScope[runtimeManagerKey] as
    | SandboxRuntimeManager
    | undefined;
  if (existing) {
    return existing;
  }
  const manager: SandboxRuntimeManager = {
    hosts: new WeakMap(),
    pendingChildren: new WeakMap(),
  };
  globalScope[runtimeManagerKey] = manager;
  return manager;
}

export function bindSandboxHost(
  host: SandboxHost,
  enabled: () => boolean,
): SandboxHostBinding {
  const manager = getRuntimeManager();
  const token = {};
  const pending = manager.pendingChildren.get(host);
  manager.pendingChildren.delete(host);
  manager.hosts.set(host, { token, enabled });
  return {
    inheritedEnabled: pending?.enabled,
    dispose() {
      if (manager.hosts.get(host)?.token === token) {
        manager.hosts.delete(host);
      }
    },
  };
}

export function prepareSandboxChild(
  parentHost: SandboxHost,
  childHost: SandboxHost,
): { dispose: () => void } | undefined {
  const manager = getRuntimeManager();
  const parent = manager.hosts.get(parentHost);
  if (!parent) {
    return undefined;
  }
  const token = {};
  manager.pendingChildren.set(childHost, {
    token,
    enabled: parent.enabled(),
  });
  return {
    dispose() {
      if (manager.pendingChildren.get(childHost)?.token === token) {
        manager.pendingChildren.delete(childHost);
      }
    },
  };
}
