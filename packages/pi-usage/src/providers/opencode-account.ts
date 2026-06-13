import type { UsageConfig } from "../config.js";
import {
  resolveActiveOpencodeAccount,
  resolveAllOpencodeAccounts,
} from "../config.js";

export type ResolvedOpencodeAccount = {
  accountId: string;
  label?: string;
  workspaceId: string;
  authCookie: string;
  credentialSource: "multi-auth" | "pi-usage";
  active: boolean;
};

export function resolveActiveAccount(
  config: UsageConfig | null,
  runtimeRoot?: string,
): ResolvedOpencodeAccount | null {
  const resolved = resolveActiveOpencodeAccount(config, runtimeRoot);
  if (!resolved) {
    return null;
  }

  if (resolved.missingWorkspace) {
    return {
      accountId: resolved.accountId,
      workspaceId: "",
      authCookie: resolved.secret,
      credentialSource: "multi-auth",
      active: true,
    };
  }

  return {
    accountId: resolved.accountId,
    label: resolved.account.label,
    workspaceId: resolved.account.workspaceId,
    authCookie: resolved.secret,
    credentialSource:
      resolved.accountId === "opencode-go" ? "multi-auth" : "pi-usage",
    active: true,
  };
}

export function resolveAllAccounts(
  config: UsageConfig | null,
  runtimeRoot?: string,
): Array<
  | { ok: true; account: ResolvedOpencodeAccount }
  | { ok: false; accountId: string; error: string }
> {
  const all = resolveAllOpencodeAccounts(config, runtimeRoot);
  const active = resolveActiveOpencodeAccount(config, runtimeRoot);
  const activeId = active?.accountId;

  return all.map((entry) => {
    if (!entry.secret) {
      return {
        ok: false as const,
        accountId: entry.accountId,
        error: `No auth cookie. Use pi-multi-auth or add opencode.accounts["${entry.accountId}"].authCookie.`,
      };
    }

    return {
      ok: true as const,
      account: {
        accountId: entry.accountId,
        label: entry.label,
        workspaceId: entry.workspaceId,
        authCookie: entry.secret,
        credentialSource: "pi-usage" as const,
        active: entry.accountId === activeId,
      },
    };
  });
}
