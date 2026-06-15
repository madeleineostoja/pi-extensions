import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PUBLIC_BUILTIN_TYPES, type PublicBuiltinType } from "./definitions.js";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type PublicSubagentsConfig = {
  models?: Partial<Record<PublicBuiltinType, string>>;
  thinking?: Partial<Record<PublicBuiltinType, ThinkingLevel>>;
};

export type ResolvedPublicSubagentsConfig = {
  models: Record<PublicBuiltinType, string | undefined>;
  thinking: Record<PublicBuiltinType, ThinkingLevel | undefined>;
};

export type ParsedPublicSubagentsConfig = {
  config: PublicSubagentsConfig;
  warnings: string[];
};

const publicTypes = new Set<string>(PUBLIC_BUILTIN_TYPES);
const thinkingLevels = new Set<string>(THINKING_LEVELS);

export function getPublicConfigPath(home = homedir()): string {
  return join(
    home,
    ".pi",
    "agent",
    "extensions",
    "pi-subagents",
    "config.json",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModels(
  value: unknown,
  warnings: string[],
): PublicSubagentsConfig["models"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push(
      "models must be an object keyed by General, Explore, or Review",
    );
    return undefined;
  }

  const models: Partial<Record<PublicBuiltinType, string>> = {};
  for (const [key, model] of Object.entries(value)) {
    if (!publicTypes.has(key)) {
      warnings.push(`Ignoring model for unknown public subagent ${key}`);
      continue;
    }
    if (typeof model !== "string" || model.trim() === "") {
      warnings.push(`Ignoring invalid model for ${key}`);
      continue;
    }
    models[key as PublicBuiltinType] = model;
  }
  return models;
}

function parseThinking(
  value: unknown,
  warnings: string[],
): PublicSubagentsConfig["thinking"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    warnings.push(
      "thinking must be an object keyed by General, Explore, or Review",
    );
    return undefined;
  }

  const thinking: Partial<Record<PublicBuiltinType, ThinkingLevel>> = {};
  for (const [key, level] of Object.entries(value)) {
    if (!publicTypes.has(key)) {
      warnings.push(
        `Ignoring thinking level for unknown public subagent ${key}`,
      );
      continue;
    }
    if (typeof level !== "string" || !thinkingLevels.has(level)) {
      warnings.push(`Ignoring invalid thinking level for ${key}`);
      continue;
    }
    thinking[key as PublicBuiltinType] = level as ThinkingLevel;
  }
  return thinking;
}

export function parsePublicConfig(source: string): ParsedPublicSubagentsConfig {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (err) {
    return {
      config: {},
      warnings: [
        `Failed to parse pi-subagents config: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  if (!isRecord(data)) {
    return {
      config: {},
      warnings: ["pi-subagents config must be a JSON object"],
    };
  }

  return {
    config: {
      models: parseModels(data.models, warnings),
      thinking: parseThinking(data.thinking, warnings),
    },
    warnings,
  };
}

export function resolvePublicConfig(
  config: PublicSubagentsConfig,
): ResolvedPublicSubagentsConfig {
  return {
    models: {
      General: config.models?.General,
      Explore: config.models?.Explore,
      Review: config.models?.Review,
    },
    thinking: {
      General: config.thinking?.General,
      Explore: config.thinking?.Explore,
      Review: config.thinking?.Review,
    },
  };
}

export function loadPublicConfig(
  options: {
    path?: string;
    warn?: (message: string) => void;
  } = {},
): ResolvedPublicSubagentsConfig {
  const path = options.path ?? getPublicConfigPath();
  if (!existsSync(path)) {
    return resolvePublicConfig({});
  }

  const parsed = parsePublicConfig(readFileSync(path, "utf8"));
  for (const warning of parsed.warnings) {
    options.warn?.(warning);
  }
  return resolvePublicConfig(parsed.config);
}
