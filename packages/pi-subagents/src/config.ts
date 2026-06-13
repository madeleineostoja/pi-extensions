import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SubagentsConfig = {
  models?: Record<string, string>;
};

export type ConfigReadResult = {
  path: string;
  config: SubagentsConfig;
  warning?: string;
};

export function getConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-subagents", "config.json");
}

export function parseConfig(raw: string): {
  config: SubagentsConfig;
  warning?: string;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        config: {},
        warning: "Config must be a JSON object; ignoring it.",
      };
    }
    const object = parsed as Record<string, unknown>;
    const config: SubagentsConfig = {};
    const warningParts: string[] = [];

    for (const key of Object.keys(object)) {
      if (key !== "models") {
        warningParts.push(`unknown field "${key}"`);
      }
    }

    if (object.models !== undefined) {
      if (
        typeof object.models !== "object" ||
        object.models === null ||
        Array.isArray(object.models)
      ) {
        warningParts.push("models must be an object");
      } else {
        const models: Record<string, string> = {};
        for (const [k, v] of Object.entries(object.models)) {
          if (typeof v === "string" && v.trim()) {
            models[k] = v.trim();
          } else {
            warningParts.push(`models["${k}"] must be a non-empty string`);
          }
        }
        config.models = models;
      }
    }

    return {
      config,
      warning: warningParts.length
        ? `Invalid config fields ignored: ${warningParts.join(", ")}.`
        : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: {},
      warning: `Could not parse config JSON; ignoring it. ${message}`,
    };
  }
}

export function readConfig(agentDir: string): ConfigReadResult {
  const path = getConfigPath(agentDir);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseConfig(raw);
    return { path, ...parsed };
  } catch (err) {
    const nodeError = err as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return { path, config: {} };
    }
    return {
      path,
      config: {},
      warning: `Could not read config; ignoring it. ${nodeError.message}`,
    };
  }
}
