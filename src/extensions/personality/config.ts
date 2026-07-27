import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_RELATIVE_PATH = "extensions/pi-auto-name/config.json";

export type AutoNameConfig = {
  model?: string;
};

function configPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-auto-name", "config.json");
}

export function readConfig(agentDir: string): AutoNameConfig {
  try {
    const raw = readFileSync(configPath(agentDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const config = parsed as Record<string, unknown>;
    const result: AutoNameConfig = {};
    if (typeof config.model === "string") {
      result.model = config.model;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeConfig(agentDir: string, config: AutoNameConfig): void {
  const path = configPath(agentDir);
  mkdirSync(join(agentDir, "extensions", "pi-auto-name"), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function resolveConfiguredModel(agentDir: string): string | null {
  const config = readConfig(agentDir);
  return config.model || null;
}
