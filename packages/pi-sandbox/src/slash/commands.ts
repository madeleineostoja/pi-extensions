/**
 * /sandbox slash command implementation.
 *
 * Registers the `sandbox` command with Pi. The module exports testable functions
 * and registration is attempted only when the pi object is passed in.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "../types/pi-tui.js";
import type { AuditPipeline } from "../audit/audit.js";
import { isValidNetworkAllowEntry, matchHost } from "../policy/schema.js";
import {
  getUserConfigPath as getPolicyUserConfigPath,
  type PolicyManager,
} from "../policy/load.js";
import type { EventsTarget } from "../audit/events.js";
import { decideFsAccess } from "../enforcement/decide.js";
import { applySessionOverrides } from "../policy/effective.js";

// ---------------------------------------------------------------------------
// Host validation — delegates to isValidNetworkAllowEntry from policy/schema.ts
// ---------------------------------------------------------------------------

export { isValidNetworkAllowEntry as isValidHost };

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export type SessionState = {
  sessionAllowedHosts: Set<string>;
  networkOff: boolean;
  sandboxOff: boolean;
};

// ---------------------------------------------------------------------------
// Config persistence helpers
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readPersistedConfig(filePath: string): {
  network?: { allow?: string[] };
} {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return (
      (JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        network?: { allow?: string[] };
      }) ?? {}
    );
  } catch {
    return {};
  }
}

function writePersistedConfig(
  filePath: string,
  config: { network?: { allow?: string[] } },
): void {
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function writeHostsToPersisted(filePath: string, hosts: string[]): void {
  ensureDir(filePath);
  const config = readPersistedConfig(filePath);
  const existingHosts = new Set<string>(config?.network?.allow ?? []);

  for (const host of hosts) {
    existingHosts.add(host);
  }

  const updated = {
    ...config,
    network: { ...config.network, allow: [...existingHosts] },
  };
  writePersistedConfig(filePath, updated);
}

export function removeHostFromPersistedFile(
  filePath: string,
  host: string,
): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const config = readPersistedConfig(filePath);
  const currentAllow: string[] = config?.network?.allow ?? [];
  if (!currentAllow.includes(host)) {
    return false;
  }

  const updated = {
    ...config,
    network: {
      ...config.network,
      allow: currentAllow.filter((h) => h !== host),
    },
  };
  writePersistedConfig(filePath, updated);
  return true;
}

function getPersistedAllowedHosts(filePath: string): string[] {
  return readPersistedConfig(filePath)?.network?.allow ?? [];
}

// ---------------------------------------------------------------------------
// Config file paths
// ---------------------------------------------------------------------------

function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "sandbox.json");
}

function getUserConfigPath(): string {
  return getPolicyUserConfigPath();
}

// ---------------------------------------------------------------------------
// Subcommand context
// ---------------------------------------------------------------------------

export type SubcommandContext = {
  ui: Pick<ExtensionUIContext, "notify" | "select" | "input" | "confirm">;
  policyManager: PolicyManager;
  cwd: string;
  events?: EventsTarget;
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export type ParsedArgs = {
  subcommand: string;
  hosts: string[];
  persist: false | "project" | "user";
  target: string;
};

export function parseArgs(rawArgs: string): ParsedArgs {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const result: ParsedArgs = {
    subcommand: "",
    hosts: [],
    persist: false,
    target: "",
  };

  if (tokens.length === 0) {
    return result;
  }

  result.subcommand = tokens[0];

  const rest = tokens.slice(1);
  const positional: string[] = [];

  for (const tok of rest) {
    if (tok === "--persist") {
      result.persist = "project";
    } else if (tok === "--persist=user") {
      result.persist = "user";
    } else {
      positional.push(tok);
    }
  }

  result.hosts = positional;
  result.target = positional[0] ?? "";

  return result;
}

// ---------------------------------------------------------------------------
// Tab completion
// ---------------------------------------------------------------------------

const SUBCOMMANDS = [
  "status",
  "summary",
  "reload",
  "why",
  "allow",
  "revoke",
  "network",
  "on",
  "off",
];

export function getArgumentCompletions(
  prefix: string,
  policyManager: PolicyManager,
  getSession?: () => SessionState,
  getRecentBlockedHosts?: () => readonly string[],
): AutocompleteItem[] | null {
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  const endsWithSpace = prefix.endsWith(" ");

  if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
    const partial = tokens[0] ?? "";
    return SUBCOMMANDS.filter((s) => s.startsWith(partial)).map((s) => ({
      value: s,
      label: s,
    }));
  }

  const subcommand = tokens[0];

  if (subcommand === "allow") {
    const blocked = getRecentBlockedHosts?.() ?? [];
    const existing = new Set(tokens.slice(1));
    return [...blocked]
      .filter((h) => !existing.has(h))
      .map((s) => ({ value: s, label: s }));
  }

  if (subcommand === "revoke") {
    const policy = policyManager.getPolicy();
    const candidates = new Set<string>(policy.network.allow);
    if (getSession) {
      for (const h of getSession().sessionAllowedHosts) {
        candidates.add(h);
      }
    }
    const existing = new Set(tokens.slice(1));
    return [...candidates]
      .filter((h) => !existing.has(h))
      .map((s) => ({ value: s, label: s }));
  }

  if (subcommand === "network") {
    if (tokens.length === 1 || (tokens.length === 2 && !endsWithSpace)) {
      const partial = tokens[1] ?? "";
      return ["on", "off"]
        .filter((s) => s.startsWith(partial))
        .map((s) => ({ value: s, label: s }));
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// createSlashCommands factory — owns per-instance session state and listeners
// ---------------------------------------------------------------------------

export type SlashCommandsInstance = {
  getSessionState: () => SessionState;
  subscribeSessionChange: (fn: () => void) => () => void;
  notifySessionChange: () => void;
  handleStatus: (ctx: SubcommandContext) => void;
  handleSummary: (ctx: SubcommandContext) => void;
  handleReload: (ctx: SubcommandContext) => void;
  handleWhy: (ctx: SubcommandContext, target: string) => Promise<void>;
  handleAllow: (
    ctx: SubcommandContext,
    hosts: string[],
    persist: false | "project" | "user",
  ) => void;
  handleRevoke: (
    ctx: SubcommandContext,
    host: string,
    persist: boolean,
  ) => void;
  handleNetworkOff: (ctx: SubcommandContext) => void;
  handleNetworkOn: (ctx: SubcommandContext) => void;
  handleOff: (ctx: SubcommandContext) => void;
  handleOn: (ctx: SubcommandContext) => void;
  handleMenu: (ctx: SubcommandContext) => Promise<void>;
  dispatch: (rawArgs: string, ctx: SubcommandContext) => Promise<void>;
  registerSandboxCommand: (
    pi: ExtensionAPI,
    policyManager: PolicyManager,
    cwd: string,
    events?: EventsTarget,
  ) => void;
};

export type SlashCommandsDeps = {
  recordAudit: AuditPipeline["recordAudit"];
  getRecentBlockedHosts: AuditPipeline["getRecentBlockedHosts"];
};

export function createSlashCommands(
  deps: SlashCommandsDeps,
): SlashCommandsInstance {
  const { recordAudit, getRecentBlockedHosts } = deps;

  function emitPolicyChange(
    ctx: SubcommandContext,
    decision: "granted" | "revoked",
    scope: "session" | "persisted",
    hostsOrRule?: string | string[],
    rule?: string,
  ): void {
    if (Array.isArray(hostsOrRule)) {
      for (const host of hostsOrRule) {
        recordAudit(
          { kind: "policy-change", decision, scope, source: "command", host },
          { events: ctx.events },
        );
      }
    } else {
      recordAudit(
        {
          kind: "policy-change",
          decision,
          scope,
          source: "command",
          ...(hostsOrRule != null && { host: hostsOrRule }),
          ...(rule != null && { rule }),
        },
        { events: ctx.events },
      );
    }
  }

  const state: SessionState = {
    sessionAllowedHosts: new Set(),
    networkOff: false,
    sandboxOff: false,
  };

  const listeners = new Set<() => void>();

  function getSessionState(): SessionState {
    return state;
  }

  function subscribeSessionChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notifySessionChange(): void {
    for (const fn of listeners) {
      fn();
    }
  }

  function handleStatus(ctx: SubcommandContext): void {
    let line: string;
    if (state.sandboxOff) {
      line = "sandbox: OFF (session override)";
    } else if (state.networkOff) {
      const policy = ctx.policyManager.getPolicy();
      line = `sandbox: ON (network filtering disabled this session) | mode=${policy.network.mode}`;
    } else {
      const policy = ctx.policyManager.getPolicy();
      const grantCount = state.sessionAllowedHosts.size;
      line = `sandbox: ON | mode=${policy.network.mode} | session grants=${grantCount}`;
    }
    ctx.ui.notify(line);
  }

  function handleSummary(ctx: SubcommandContext): void {
    const policy = ctx.policyManager.getPolicy();
    const lines = [
      "=== Sandbox Policy Summary ===",
      `Enabled:         ${
        state.sandboxOff ? "false (session override)" : String(policy.enabled)
      }`,
      `Network mode:    ${
        state.networkOff ? "off (session override)" : policy.network.mode
      }`,
      `Allowed hosts:   ${policy.network.allow.join(", ") || "(none)"}`,
      `Session grants:  ${
        state.sessionAllowedHosts.size > 0
          ? [...state.sessionAllowedHosts].join(", ")
          : "(none)"
      }`,
      `FS allow read:   ${policy.fs.allowRead.join(", ") || "(none)"}`,
      `FS allow write:  ${policy.fs.allowWrite.join(", ") || "(none)"}`,
      `Deny patterns:   ${policy.fs.denyPatterns.join(", ") || "(none)"}`,
      `Audit log:       ${
        policy.audit.log ? policy.audit.logFile : "disabled"
      }`,
    ];
    ctx.ui.notify(lines.join("\n"));
  }

  function handleReload(ctx: SubcommandContext): void {
    const notifyTarget = {
      notify: (text: string, level: "error" | "warning") =>
        ctx.ui.notify(text, level),
    };

    try {
      ctx.policyManager.reloadPolicy(ctx.cwd, notifyTarget);
    } catch (err) {
      ctx.ui.notify(`Sandbox config reload failed: ${String(err)}`, "error");
      return;
    }

    ctx.ui.notify(
      "Sandbox config reloaded. Run /sandbox status for current state.",
    );
  }

  async function handleWhy(
    ctx: SubcommandContext,
    target: string,
  ): Promise<void> {
    if (!target) {
      ctx.ui.notify("Usage: /sandbox why <path|host>", "error");
      return;
    }

    const policy = ctx.policyManager.getPolicy();
    const effective = applySessionOverrides(policy, state);
    const looksLikeHost = !target.includes("/") && !target.startsWith(".");

    if (looksLikeHost) {
      const host = target;

      if (!effective.enabled) {
        ctx.ui.notify(
          `${host}: would be allowed (sandbox disabled this session)`,
        );
        return;
      }
      if (effective.network.mode === "off") {
        ctx.ui.notify(`${host}: would be allowed (network filtering off)`);
        return;
      }

      const matched = effective.network.allow.find((entry) =>
        matchHost(host, entry),
      );
      if (matched !== undefined) {
        const fromSession = state.sessionAllowedHosts.has(matched);
        ctx.ui.notify(
          `${host}: allowed by ${fromSession ? "session grant" : "config"} "${matched}"`,
        );
      } else {
        ctx.ui.notify(
          `${host}: would be blocked (no entry in network.allow matches)`,
        );
      }
    } else {
      const abs = path.resolve(ctx.cwd, target);

      if (!effective.enabled) {
        ctx.ui.notify(
          `${abs}: would be allowed (sandbox disabled this session)`,
        );
        return;
      }

      const [readDecision, writeDecision] = await Promise.all([
        decideFsAccess(target, "read", effective, { cwd: ctx.cwd }),
        decideFsAccess(target, "write", effective, { cwd: ctx.cwd }),
      ]);

      const fmt = (
        mode: "read" | "write",
        decision: typeof readDecision,
      ): string => {
        if (decision.allow) {
          return `  ${mode}:  would be allowed`;
        }
        if (
          decision.rule === "denyPattern" &&
          decision.matchedPattern != null
        ) {
          return `  ${mode}:  blocked by denyPattern "${decision.matchedPattern}"`;
        }
        return `  ${mode}:  blocked (not in fs.allow${mode === "read" ? "Read" : "Write"})`;
      };

      ctx.ui.notify(
        [abs, fmt("read", readDecision), fmt("write", writeDecision)].join(
          "\n",
        ),
      );
    }
  }

  function handleAllow(
    ctx: SubcommandContext,
    hosts: string[],
    persist: false | "project" | "user",
  ): void {
    if (hosts.length === 0) {
      ctx.ui.notify(
        "Usage: /sandbox allow [--persist[=user]] <host> [host…]",
        "error",
      );
      return;
    }

    const invalid = hosts.filter((h) => !isValidNetworkAllowEntry(h));
    if (invalid.length > 0) {
      ctx.ui.notify(
        `Invalid host(s): ${invalid.join(", ")}. CIDR ranges and malformed entries are not accepted.`,
        "error",
      );
      return;
    }

    if (persist === false) {
      for (const host of hosts) {
        state.sessionAllowedHosts.add(host);
      }
      ctx.ui.notify(`Session grant added: ${hosts.join(", ")}`);
      emitPolicyChange(ctx, "granted", "session", hosts);
      notifySessionChange();
    } else {
      const filePath =
        persist === "user"
          ? getUserConfigPath()
          : getProjectConfigPath(ctx.cwd);

      try {
        writeHostsToPersisted(filePath, hosts);
      } catch (err) {
        ctx.ui.notify(
          `Failed to write to ${filePath}: ${String(err)}`,
          "error",
        );
        return;
      }

      ctx.policyManager.reloadPolicy(ctx.cwd);
      ctx.ui.notify(`Persisted grant to ${filePath}: ${hosts.join(", ")}`);
      emitPolicyChange(ctx, "granted", "persisted", hosts);
    }
  }

  function handleRevoke(
    ctx: SubcommandContext,
    host: string,
    persist: boolean,
  ): void {
    if (!host) {
      ctx.ui.notify("Usage: /sandbox revoke [--persist] <host>", "error");
      return;
    }

    const removedSession = state.sessionAllowedHosts.delete(host);

    if (persist) {
      const projectPath = getProjectConfigPath(ctx.cwd);
      const userPath = getUserConfigPath();
      const removedProject = removeHostFromPersistedFile(projectPath, host);
      const removedUser = removeHostFromPersistedFile(userPath, host);

      if (removedProject || removedUser) {
        ctx.policyManager.reloadPolicy(ctx.cwd);
        ctx.ui.notify(`Revoked ${host} from persisted config.`);
        emitPolicyChange(ctx, "revoked", "persisted", host);
        notifySessionChange();
      } else if (removedSession) {
        ctx.ui.notify(`Revoked ${host} from session grants.`);
        emitPolicyChange(ctx, "revoked", "session", host);
        notifySessionChange();
      } else {
        ctx.ui.notify(
          `${host} was not found in session grants or persisted config.`,
        );
      }
    } else {
      if (removedSession) {
        ctx.ui.notify(`Revoked ${host} from session grants.`);
        emitPolicyChange(ctx, "revoked", "session", host);
        notifySessionChange();
      } else {
        const projectPath = getProjectConfigPath(ctx.cwd);
        const projectHosts = getPersistedAllowedHosts(projectPath);
        const userPath = getUserConfigPath();
        const userHosts = getPersistedAllowedHosts(userPath);

        if (projectHosts.includes(host) || userHosts.includes(host)) {
          ctx.ui.notify(
            `${host} is in persisted config but not in session grants. ` +
              `Use /sandbox revoke --persist ${host} to remove from config.`,
          );
        } else {
          ctx.ui.notify(`${host} was not found in session grants.`);
        }
      }
    }
  }

  function handleNetworkOff(ctx: SubcommandContext): void {
    state.networkOff = true;
    ctx.ui.notify("Network filtering disabled for this session.", "warning");
    emitPolicyChange(ctx, "granted", "session", undefined, "network-off");
    notifySessionChange();
  }

  function handleNetworkOn(ctx: SubcommandContext): void {
    state.networkOff = false;
    ctx.ui.notify("Network filtering re-enabled (per config).");
    emitPolicyChange(ctx, "revoked", "session", undefined, "network-off");
    notifySessionChange();
  }

  function handleOff(ctx: SubcommandContext): void {
    state.sandboxOff = true;
    ctx.ui.notify(
      "Sandbox DISABLED for this session. All enforcement is bypassed.",
      "warning",
    );
    emitPolicyChange(ctx, "granted", "session", undefined, "sandbox-off");
    notifySessionChange();
  }

  function handleOn(ctx: SubcommandContext): void {
    state.sandboxOff = false;
    ctx.ui.notify("Sandbox re-enabled.");
    emitPolicyChange(ctx, "revoked", "session", undefined, "sandbox-off");
    notifySessionChange();
  }

  async function handleMenu(ctx: SubcommandContext): Promise<void> {
    const s = getSessionState();

    const networkLabel = s.networkOff
      ? "Re-enable network filtering"
      : "Disable network filtering this session";

    const sandboxLabel = s.sandboxOff
      ? "Re-enable sandbox"
      : "Disable sandbox this session";

    const choice = await ctx.ui.select("Sandbox", [
      "Status",
      "Show policy summary",
      "Explain path/host",
      "Allow host for this session",
      "Revoke session host",
      networkLabel,
      sandboxLabel,
      "Reload config",
    ]);

    if (choice === undefined) {
      return;
    }

    switch (choice) {
      case "Status":
        handleStatus(ctx);
        break;

      case "Show policy summary":
        handleSummary(ctx);
        break;

      case "Explain path/host": {
        const target = await ctx.ui.input("Explain sandbox decision", "path or host");
        if (target === undefined || target.trim().length === 0) {
          return;
        }
        await handleWhy(ctx, target.trim());
        break;
      }

      case "Allow host for this session": {
        const host = await ctx.ui.input("Allow host for this session", "github.com");
        if (host === undefined || host.trim().length === 0) {
          return;
        }
        handleAllow(ctx, [host.trim()], false);
        break;
      }

      case "Revoke session host": {
        const hosts = [...s.sessionAllowedHosts];
        if (hosts.length === 0) {
          ctx.ui.notify("There are no session grants to revoke.");
          return;
        }
        const selected = await ctx.ui.select("Revoke session host", hosts);
        if (selected === undefined) {
          return;
        }
        handleRevoke(ctx, selected, false);
        break;
      }

      case networkLabel: {
        const action = s.networkOff ? "re-enable" : "disable";
        const confirmed = await ctx.ui.confirm(
          `${action === "disable" ? "Disable" : "Re-enable"} network filtering`,
          `Are you sure you want to ${action} network filtering for this session?`,
        );
        if (!confirmed) {
          return;
        }
        if (s.networkOff) {
          handleNetworkOn(ctx);
        } else {
          handleNetworkOff(ctx);
        }
        break;
      }

      case sandboxLabel: {
        const action = s.sandboxOff ? "re-enable" : "disable";
        const confirmed = await ctx.ui.confirm(
          `${action === "disable" ? "Disable" : "Re-enable"} sandbox`,
          `Are you sure you want to ${action} the sandbox for this session?`,
        );
        if (!confirmed) {
          return;
        }
        if (s.sandboxOff) {
          handleOn(ctx);
        } else {
          handleOff(ctx);
        }
        break;
      }

      case "Reload config": {
        const confirmed = await ctx.ui.confirm(
          "Reload config",
          "Reloading may change the effective policy. Continue?",
        );
        if (!confirmed) {
          return;
        }
        handleReload(ctx);
        break;
      }
    }
  }

  async function dispatch(
    rawArgs: string,
    ctx: SubcommandContext,
  ): Promise<void> {
    const parsed = parseArgs(rawArgs);
    const { subcommand } = parsed;

    switch (subcommand) {
      case "":
        await handleMenu(ctx);
        break;

      case "status":
        handleStatus(ctx);
        break;

      case "summary":
        handleSummary(ctx);
        break;

      case "reload":
        handleReload(ctx);
        break;

      case "why":
        await handleWhy(ctx, parsed.target);
        break;

      case "allow":
        handleAllow(ctx, parsed.hosts, parsed.persist);
        break;

      case "revoke":
        handleRevoke(ctx, parsed.target, parsed.persist !== false);
        break;

      case "network":
        if (parsed.target === "off") {
          handleNetworkOff(ctx);
        } else if (parsed.target === "on") {
          handleNetworkOn(ctx);
        } else {
          ctx.ui.notify(
            `Unknown network subcommand: "${parsed.target}". Use 'on' or 'off'.`,
            "error",
          );
        }
        break;

      case "on":
        handleOn(ctx);
        break;

      case "off":
        handleOff(ctx);
        break;

      default:
        ctx.ui.notify(
          `Unknown subcommand: ${subcommand}. Try: ${SUBCOMMANDS.join(", ")}`,
          "error",
        );
    }
  }

  function registerSandboxCommand(
    pi: ExtensionAPI,
    policyManager: PolicyManager,
    cwd: string,
    events?: EventsTarget,
  ): void {
    pi.registerCommand("sandbox", {
      description: "Inspect and control the pi-sandbox policy",
      getArgumentCompletions: (prefix: string) =>
        getArgumentCompletions(
          prefix,
          policyManager,
          getSessionState,
          getRecentBlockedHosts,
        ),
      handler: async (args: string, _ctx: ExtensionCommandContext) => {
        const cmdCtx: SubcommandContext = {
          ui: _ctx.ui,
          policyManager,
          cwd,
          events,
        };
        await dispatch(args, cmdCtx);
      },
    });
  }

  return {
    getSessionState,
    subscribeSessionChange,
    notifySessionChange,
    handleStatus,
    handleSummary,
    handleReload,
    handleWhy,
    handleAllow,
    handleRevoke,
    handleNetworkOff,
    handleNetworkOn,
    handleOff,
    handleOn,
    handleMenu,
    dispatch,
    registerSandboxCommand,
  };
}
