import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isModelRef } from "./model-ref.js";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ModelPresetName = "utility" | "low" | "medium" | "high";
export type ModelPreset = Readonly<{
  model: string;
  thinking: ThinkingLevel;
}>;
export type ConfigIssue = Readonly<{
  path: string;
  message: string;
}>;
export type PipkinConfig = Readonly<{
  models: Readonly<Partial<Record<ModelPresetName, ModelPreset>>>;
  implement: Readonly<{ workerConcurrency: number }>;
  sandbox?: Readonly<Record<string, unknown>>;
}>;
export type ConfigSnapshot = Readonly<{
  path: string;
  config: PipkinConfig;
  issues: readonly ConfigIssue[];
}>;

type FileReader = (path: string, encoding: "utf8") => string;

const MODEL_PRESETS = ["utility", "low", "medium", "high"] as const;
const thinkingLevels = new Set<string>(THINKING_LEVELS);
const MAX_ISSUES = 32;

export function getConfigPath(agentDir: string): string {
  return join(agentDir, "pipkin", "config.json");
}

export function loadPipkinConfig(
  agentDir: string,
  readFile: FileReader = readFileSync as FileReader,
): ConfigSnapshot {
  const path = getConfigPath(agentDir);
  try {
    return parsePipkinConfig(readFile(path, "utf8"), path);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const message = missing
      ? "file does not exist"
      : `could not be read: ${messageFor(error)}`;
    return parseValue(missing ? {} : undefined, path, [{ path, message }]);
  }
}

export function parsePipkinConfig(
  raw: string,
  path = "config.json",
): ConfigSnapshot {
  try {
    return parseValue(JSON.parse(raw), path, []);
  } catch (error) {
    return parseValue(undefined, path, [
      { path, message: `contains malformed JSON: ${messageFor(error)}` },
    ]);
  }
}

export function presetIssue(
  snapshot: ConfigSnapshot,
  name: ModelPresetName,
): ConfigIssue | undefined {
  return snapshot.issues.find(
    (issue) =>
      issue.path === `models.${name}` ||
      issue.path.startsWith(`models.${name}.`),
  );
}

function parseValue(
  value: unknown,
  path: string,
  initialIssues: ConfigIssue[],
): ConfigSnapshot {
  const issues = [...initialIssues];
  const issue = (field: string, message: string) => {
    if (issues.length < MAX_ISSUES) {
      issues.push({ path: field, message });
    }
  };
  const root = isRecord(value) ? value : undefined;
  if (!root) {
    issue("config", "must be a JSON object");
  }

  const modelsValue = root?.models;
  const modelsInput = isRecord(modelsValue) ? modelsValue : undefined;
  if (!modelsInput) {
    issue(
      "models",
      "must be an object with utility, low, medium, and high presets",
    );
  }
  const models: Partial<Record<ModelPresetName, ModelPreset>> = {};
  for (const name of MODEL_PRESETS) {
    const model = parseModelPreset(modelsInput?.[name], name, issue);
    if (model) {
      models[name] = model;
    }
  }
  if (modelsInput) {
    for (const key of Object.keys(modelsInput)) {
      if (!MODEL_PRESETS.includes(key as ModelPresetName)) {
        issue(`models.${key}`, "is not a supported preset");
      }
    }
  }

  const implementInput = root?.implement;
  let workerConcurrency = 3;
  if (implementInput !== undefined) {
    if (!isRecord(implementInput)) {
      issue("implement", "must be an object");
    } else {
      for (const key of Object.keys(implementInput)) {
        if (key !== "workerConcurrency") {
          issue(`implement.${key}`, "is not supported");
        }
      }
      if (implementInput.workerConcurrency !== undefined) {
        const value = implementInput.workerConcurrency;
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value <= 0
        ) {
          issue("implement.workerConcurrency", "must be a positive integer");
        } else {
          workerConcurrency = Math.min(value, 8);
        }
      }
    }
  }

  const sandbox = optionalSection(root?.sandbox, "sandbox", issue);
  if (root) {
    for (const key of Object.keys(root)) {
      if (!["models", "implement", "sandbox"].includes(key)) {
        issue(key, "is not supported");
      }
    }
  }

  return freeze({
    path,
    config: {
      models,
      implement: { workerConcurrency },
      ...(sandbox === undefined ? {} : { sandbox }),
    },
    issues,
  });
}

function parseModelPreset(
  value: unknown,
  name: ModelPresetName,
  issue: (field: string, message: string) => void,
): ModelPreset | undefined {
  if (!isRecord(value)) {
    issue(`models.${name}`, "must be an object with model and thinking");
    return undefined;
  }
  let valid = true;
  for (const key of Object.keys(value)) {
    if (key !== "model" && key !== "thinking") {
      issue(`models.${name}.${key}`, "is not supported");
      valid = false;
    }
  }
  const model = value.model;
  const thinking = value.thinking;
  if (typeof model !== "string" || !isModelRef(model)) {
    issue(
      `models.${name}`,
      "model must be a non-empty provider/model reference",
    );
    valid = false;
  }
  if (typeof thinking !== "string" || !thinkingLevels.has(thinking)) {
    issue(`models.${name}`, "thinking must be a supported Pi thinking level");
    valid = false;
  }
  return valid
    ? { model: (model as string).trim(), thinking: thinking as ThinkingLevel }
    : undefined;
}

function optionalSection(
  value: unknown,
  name: "sandbox",
  issue: (field: string, message: string) => void,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issue(name, "must be an object");
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }
  return value;
}
