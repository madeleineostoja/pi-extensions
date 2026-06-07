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

export type OpencodeConfig = {
  workspaceId: string;
  authCookie: string;
};

export type UsageConfig = {
  opencode?: OpencodeConfig;
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
    return parsed as UsageConfig;
  } catch {
    return null;
  }
}

export function validateOpencodeConfig(
  config: UsageConfig | null,
): OpencodeConfig | null {
  if (!config?.opencode) {
    return null;
  }
  const { workspaceId, authCookie } = config.opencode;
  if (
    typeof workspaceId !== "string" ||
    workspaceId.trim().length === 0 ||
    typeof authCookie !== "string" ||
    authCookie.trim().length === 0
  ) {
    return null;
  }
  return { workspaceId: workspaceId.trim(), authCookie: authCookie.trim() };
}

export function writeConfig(agentDir: string, config: UsageConfig): void {
  const path = getConfigPath(agentDir);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  }
  const existing = readConfig(agentDir) ?? {};
  const merged: UsageConfig = { ...existing, ...config };
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
  if (!ctx.hasUI) {
    return false;
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
    authCookie = await ctx.ui.input("Opencode Go auth cookie", "Fe26.2**...");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
      return false;
    }
    throw err;
  }
  if (authCookie === undefined || authCookie.trim().length === 0) {
    ctx.ui.notify("Opencode auth cancelled. No changes made.", "info");
    return false;
  }

  const hints: string[] = [];
  if (!/^wrk_[A-Za-z0-9]+$/.test(workspaceId.trim())) {
    hints.push(
      "Workspace ID does not look like a typical Opencode workspace ID.",
    );
  }
  if (!authCookie.trim().startsWith("Fe26.2**")) {
    hints.push("Auth cookie does not start with the expected Fe26.2** prefix.");
  }

  const dir = agentDir ?? getAgentDir();
  const existing = readConfig(dir) ?? {};
  const updated: UsageConfig = {
    ...existing,
    opencode: {
      workspaceId: workspaceId.trim(),
      authCookie: authCookie.trim(),
    },
  };

  writeConfig(dir, updated);

  if (hints.length > 0) {
    ctx.ui.notify(
      `Opencode auth saved to ~/.pi/agent/pi-usage.json.\n${hints.join("\n")}`,
      "info",
    );
  } else {
    ctx.ui.notify("Opencode auth saved to ~/.pi/agent/pi-usage.json", "info");
  }
  return true;
}
