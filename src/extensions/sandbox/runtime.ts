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

type EventHost = {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
};
type Lookup<T> = { resolve: (value: T) => void };

const runtimeManagerKey = Symbol.for("pipkin:sandbox:runtime");
const HOST_LOOKUP_CHANNEL = "pipkin:sandbox:host-lookup";
const INHERITANCE_LOOKUP_CHANNEL = "pipkin:sandbox:inheritance-lookup";

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
  const pending = takeInheritance(host, manager);
  const binding = { token, enabled, writeMode };
  manager.hosts.set(host, binding);
  const unsubscribe = eventHost(host)?.on(HOST_LOOKUP_CHANNEL, (value) => {
    if (isLookup<HostBinding>(value)) {
      value.resolve(binding);
    }
  });
  return {
    inherited: pending?.snapshot,
    inheritedEnabled: pending?.snapshot.enabled,
    dispose() {
      unsubscribe?.();
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
  const parent = lookupHost(parentHost, manager);
  if (!parent) {
    return undefined;
  }
  const token = {};
  const inheritance = {
    token,
    snapshot: Object.freeze({
      enabled: parent.enabled(),
      writeMode: writeMode ?? parent.writeMode(),
    }),
  };
  manager.pendingChildren.set(childHost, inheritance);
  const unsubscribe = eventHost(childHost)?.on(
    INHERITANCE_LOOKUP_CHANNEL,
    (value) => {
      if (
        isLookup<PendingInheritance>(value) &&
        manager.pendingChildren.get(childHost)?.token === token
      ) {
        manager.pendingChildren.delete(childHost);
        value.resolve(inheritance);
      }
    },
  );
  return {
    dispose() {
      unsubscribe?.();
      if (manager.pendingChildren.get(childHost)?.token === token) {
        manager.pendingChildren.delete(childHost);
      }
    },
  };
}

function lookupHost(
  host: SandboxHost,
  manager: SandboxRuntimeManager,
): HostBinding | undefined {
  const direct = manager.hosts.get(host);
  if (direct) {
    return direct;
  }
  let resolved: HostBinding | undefined;
  eventHost(host)?.emit(HOST_LOOKUP_CHANNEL, {
    resolve: (value: HostBinding) => (resolved ??= value),
  });
  return resolved;
}

function takeInheritance(
  host: SandboxHost,
  manager: SandboxRuntimeManager,
): PendingInheritance | undefined {
  const direct = manager.pendingChildren.get(host);
  if (direct) {
    manager.pendingChildren.delete(host);
    return direct;
  }
  let resolved: PendingInheritance | undefined;
  eventHost(host)?.emit(INHERITANCE_LOOKUP_CHANNEL, {
    resolve: (value: PendingInheritance) => (resolved ??= value),
  });
  return resolved;
}

function eventHost(host: SandboxHost): EventHost | undefined {
  return host &&
    typeof host.emit === "function" &&
    typeof host.on === "function"
    ? host
    : undefined;
}

function isLookup<T>(value: unknown): value is Lookup<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { resolve?: unknown }).resolve === "function"
  );
}
