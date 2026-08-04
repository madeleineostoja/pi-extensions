import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SandboxChildSnapshot, SandboxWriteMode } from "./write-mode.js";

export type { SandboxWriteMode } from "./write-mode.js";

export type SandboxHost = ExtensionAPI["events"];

export type SandboxHostBinding = {
  inherited: SandboxChildSnapshot | undefined;
  /** @deprecated Use the complete immutable child snapshot. */
  inheritedEnabled: boolean | undefined;
  dispose: () => void;
};

type HostBinding = {
  token: object;
  enabled: () => boolean;
  writeMode: () => SandboxWriteMode;
};

type PendingInheritance = {
  token: object;
  snapshot: SandboxChildSnapshot;
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
  writeMode: () => SandboxWriteMode = () => "workspace-write",
): SandboxHostBinding {
  const manager = getRuntimeManager();
  const token = {};
  const pending = manager.pendingChildren.get(host);
  manager.pendingChildren.delete(host);
  manager.hosts.set(host, { token, enabled, writeMode });
  return {
    inherited: pending?.snapshot,
    inheritedEnabled: pending?.snapshot.enabled,
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
  writeMode?: SandboxWriteMode,
): { dispose: () => void } | undefined {
  const manager = getRuntimeManager();
  const parent = manager.hosts.get(parentHost);
  if (!parent) {
    return undefined;
  }
  const token = {};
  manager.pendingChildren.set(childHost, {
    token,
    snapshot: Object.freeze({
      enabled: parent.enabled(),
      writeMode: writeMode ?? parent.writeMode(),
    }),
  });
  return {
    dispose() {
      if (manager.pendingChildren.get(childHost)?.token === token) {
        manager.pendingChildren.delete(childHost);
      }
    },
  };
}
