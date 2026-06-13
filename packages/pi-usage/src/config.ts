import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getMultiAuthCredentialIds,
  getMultiAuthCredentialSecret,
  getMultiAuthRuntimeRoot,
  isMultiAuthCredentialForProvider,
  resolveActiveMultiAuthCredential,
} from "./multi-auth.js";

export type OpencodeAccountConfig = {
  label?: string;
  workspaceId: string;
  authCookie?: string;
};

export type UsageConfig = {
  opencode?: {
    accounts?: Record<string, OpencodeAccountConfig>;
  };
};

const CONFIG_FILENAME = "pi-usage.json";

export function getConfigPath(agentDir: string): string {
  return join(agentDir, CONFIG_FILENAME);
}

export function readConfig(agentDir?: string): UsageConfig | null {
  const dir = agentDir ?? getAgentDir();
  const path = getConfigPath(dir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return normalizeConfig(parsed as UsageConfig);
  } catch {
    return null;
  }
}

function normalizeConfig(raw: UsageConfig | null): UsageConfig | null {
  if (!raw) {
    return null;
  }

  // Backward compatibility: convert old top-level opencode config to account
  const legacy = (raw as unknown as Record<string, unknown>).opencode;
  if (
    legacy &&
    typeof (legacy as Record<string, unknown>).workspaceId === "string"
  ) {
    const old = legacy as { workspaceId?: string; authCookie?: string };
    return {
      ...raw,
      opencode: {
        accounts: {
          "opencode-go": {
            workspaceId: old.workspaceId ?? "",
            authCookie: old.authCookie,
          },
        },
      },
    };
  }

  return raw;
}

export function validateOpencodeAccountConfig(
  account: unknown,
): OpencodeAccountConfig | null {
  if (typeof account !== "object" || account === null) {
    return null;
  }
  const a = account as Record<string, unknown>;
  const workspaceId =
    typeof a.workspaceId === "string" ? a.workspaceId.trim() : "";
  if (workspaceId.length === 0) {
    return null;
  }
  const label = typeof a.label === "string" ? a.label.trim() : undefined;
  const authCookie =
    typeof a.authCookie === "string" ? a.authCookie.trim() : undefined;
  return { workspaceId, label: label || undefined, authCookie };
}

export function validateOpencodeAccounts(
  config: UsageConfig | null,
): Record<string, OpencodeAccountConfig> | null {
  const accounts = config?.opencode?.accounts;
  if (typeof accounts !== "object" || accounts === null) {
    return null;
  }
  const result: Record<string, OpencodeAccountConfig> = {};
  for (const [id, account] of Object.entries(accounts)) {
    const validated = validateOpencodeAccountConfig(account);
    if (validated) {
      result[id] = validated;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function getOpencodeAccount(
  config: UsageConfig | null,
  accountId: string,
): OpencodeAccountConfig | null {
  const accounts = validateOpencodeAccounts(config);
  return accounts?.[accountId] ?? null;
}

export type ActiveAccountResult =
  | {
      accountId: string;
      account: OpencodeAccountConfig;
      secret: string;
      missingWorkspace?: false;
    }
  | { accountId: string; secret: string; missingWorkspace: true }
  | null;

export function resolveActiveOpencodeAccount(
  config: UsageConfig | null,
  runtimeRoot?: string,
): ActiveAccountResult {
  const accounts = validateOpencodeAccounts(config);
  if (!accounts) {
    return null;
  }

  const resolvedRoot = runtimeRoot ?? getMultiAuthRuntimeRoot();

  // Try pi-multi-auth active credential first
  const multiAuthActive = resolveActiveMultiAuthCredential(
    ["opencode-go", "opencode"],
    resolvedRoot,
  );
  if (multiAuthActive) {
    const account = accounts[multiAuthActive.credentialId];
    if (account) {
      return {
        accountId: multiAuthActive.credentialId,
        account,
        secret: multiAuthActive.secret,
      };
    }
    return {
      accountId: multiAuthActive.credentialId,
      secret: multiAuthActive.secret,
      missingWorkspace: true,
    };
  }

  // Fallback to first account with a cookie when multi-auth is absent
  const ids = Object.keys(accounts);
  for (const accountId of ids) {
    const account = accounts[accountId];
    if (account.authCookie && account.authCookie.trim().length > 0) {
      return { accountId, account, secret: account.authCookie };
    }
  }

  return null;
}

export function resolveAllOpencodeAccounts(
  config: UsageConfig | null,
  runtimeRoot?: string,
): Array<{
  accountId: string;
  label?: string;
  workspaceId: string;
  secret?: string;
}> {
  const accounts = validateOpencodeAccounts(config);
  if (!accounts) {
    return [];
  }

  const resolvedRoot = runtimeRoot ?? getMultiAuthRuntimeRoot();
  const results: Array<{
    accountId: string;
    label?: string;
    workspaceId: string;
    secret?: string;
  }> = [];

  for (const [accountId, account] of Object.entries(accounts)) {
    // Only use auth.json secrets when the credential is known to multi-auth
    const isKnownToMultiAuth =
      isMultiAuthCredentialForProvider(
        accountId,
        "opencode-go",
        resolvedRoot,
      ) ||
      isMultiAuthCredentialForProvider(accountId, "opencode", resolvedRoot);
    const multiAuthSecret = isKnownToMultiAuth
      ? getMultiAuthCredentialSecret(accountId, resolvedRoot)
      : null;
    const secret = multiAuthSecret ?? account.authCookie;
    results.push({
      accountId,
      label: account.label,
      workspaceId: account.workspaceId,
      secret: secret || undefined,
    });
  }

  return results;
}

export function validateOpencodeConfig(
  config: UsageConfig | null,
  runtimeRoot?: string,
): { workspaceId: string; authCookie: string } | null {
  const resolved = resolveActiveOpencodeAccount(config, runtimeRoot);
  if (!resolved || !resolved.secret || resolved.missingWorkspace) {
    return null;
  }
  return {
    workspaceId: resolved.account.workspaceId,
    authCookie: resolved.secret,
  };
}

export function writeConfig(agentDir: string, config: UsageConfig): void {
  const path = getConfigPath(agentDir);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  }
  const existing = readConfig(agentDir) ?? {};
  const merged: UsageConfig = {
    ...existing,
    opencode: {
      ...existing.opencode,
      ...config.opencode,
      accounts: {
        ...existing.opencode?.accounts,
        ...config.opencode?.accounts,
      },
    },
  };
  const tmpPath = join(agentDir, `.pi-usage-${Date.now()}.tmp.json`);
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(tmpPath, path);
}

export async function runOpencodeAuthSetup(
  ctx: ExtensionContext,
  agentDir?: string,
): Promise<boolean> {
  if (ctx.mode !== "tui") {
    return false;
  }

  const dir = agentDir ?? getAgentDir();
  const existing = readConfig(dir);

  let accountId: string | undefined;
  const multiAuthIds = getMultiAuthCredentialIds(
    "opencode-go",
    getMultiAuthRuntimeRoot(dir),
  );

  if (multiAuthIds.length === 1) {
    accountId = multiAuthIds[0];
  } else if (multiAuthIds.length > 1) {
    try {
      accountId = await ctx.ui.input(
        `Opencode account ID (${multiAuthIds.join(", ")})`,
        multiAuthIds[0],
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
        return false;
      }
      throw err;
    }
    if (accountId === undefined || accountId.trim().length === 0) {
      ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
      return false;
    }
  } else {
    try {
      accountId = await ctx.ui.input("Opencode account ID", "opencode-go");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
        return false;
      }
      throw err;
    }
    if (accountId === undefined || accountId.trim().length === 0) {
      ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
      return false;
    }
  }

  let label: string | undefined;
  try {
    label = await ctx.ui.input("Account label (optional)");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
      return false;
    }
    throw err;
  }

  let workspaceId: string | undefined;
  try {
    workspaceId = await ctx.ui.input("Opencode Go workspace ID", "wrk_...");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
      return false;
    }
    throw err;
  }
  if (workspaceId === undefined || workspaceId.trim().length === 0) {
    ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
    return false;
  }

  let authCookie: string | undefined;
  try {
    authCookie = await ctx.ui.input(
      "Opencode Go auth cookie (optional if using pi-multi-auth)",
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
      return false;
    }
    throw err;
  }

  const hints: string[] = [];
  if (!/^wrk_[A-Za-z0-9]+$/.test(workspaceId.trim())) {
    hints.push(
      "Workspace ID does not look like a typical Opencode workspace ID.",
    );
  }
  if (
    authCookie &&
    authCookie.trim().length > 0 &&
    !authCookie.trim().startsWith("Fe26.2**")
  ) {
    hints.push("Auth cookie does not start with the expected Fe26.2** prefix.");
  }

  const normalizedAccountId = accountId.trim();
  const normalizedLabel = label?.trim() || undefined;
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedCookie = authCookie?.trim();

  const existingAccounts = existing?.opencode?.accounts ?? {};
  const existingAccount = existingAccounts[normalizedAccountId];

  const updatedAccount: OpencodeAccountConfig = {
    workspaceId: normalizedWorkspaceId,
    ...(normalizedLabel && { label: normalizedLabel }),
    ...(normalizedCookie
      ? { authCookie: normalizedCookie }
      : existingAccount
        ? { authCookie: existingAccount.authCookie }
        : {}),
  };

  const updated: UsageConfig = {
    opencode: {
      accounts: {
        ...existingAccounts,
        [normalizedAccountId]: updatedAccount,
      },
    },
  };

  writeConfig(dir, updated);

  const resolvedRoot = getMultiAuthRuntimeRoot(dir);
  const hasMultiAuthSecret =
    getMultiAuthCredentialSecret(normalizedAccountId, resolvedRoot) !== null;
  const hasLocalCookie = !!updatedAccount.authCookie;

  if (!hasLocalCookie && !hasMultiAuthSecret) {
    ctx.ui.notify(
      `Opencode auth saved for ${normalizedAccountId}, but no auth cookie is available. Add pi-multi-auth or set opencode.accounts["${normalizedAccountId}"].authCookie.`,
      "warning",
    );
    return true;
  }

  const message = `Opencode auth saved to ~/.pi/agent/pi-usage.json for account ${normalizedAccountId}`;
  if (hints.length > 0) {
    ctx.ui.notify(`${message}.\n${hints.join("\n")}`, "info");
  } else {
    ctx.ui.notify(message, "info");
  }
  return true;
}
