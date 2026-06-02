import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type Config = {
  staleTurns: number;
  minTokens: number;
  supersededReadsEnabled: boolean;
  duplicateReadsEnabled: boolean;
  adaptivePolicyEnabled: boolean;
};

export const DEFAULTS: Config = {
  staleTurns: 4,
  minTokens: 256,
  supersededReadsEnabled: true,
  duplicateReadsEnabled: true,
  adaptivePolicyEnabled: false,
};

type Notifier = ExtensionUIContext["notify"];
type FileReader = (path: string, encoding: "utf8") => string;

export function defaultConfig(): Config {
  return { ...DEFAULTS };
}

export function loadConfig(
  notify?: Notifier,
  _readFile: FileReader = readFileSync as FileReader,
): Config {
  const home = homedir();
  if (!home) {
    return defaultConfig();
  }

  const configPath = join(
    home,
    ".pi",
    "agent",
    "extensions",
    "pi-context-prune",
    "config.json",
  );

  let raw: string;
  try {
    raw = _readFile(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    notify?.(
      `pi-context-prune: could not read config file: ${String(err)}`,
      "warning",
    );
    return defaultConfig();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    notify?.(
      "pi-context-prune: config file contains malformed JSON; using defaults",
      "warning",
    );
    return defaultConfig();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    notify?.(
      "pi-context-prune: config file must be a JSON object; using defaults",
      "warning",
    );
    return defaultConfig();
  }

  const obj = parsed as Record<string, unknown>;
  const config = defaultConfig();

  const numKeys: Array<"staleTurns" | "minTokens"> = [
    "staleTurns",
    "minTokens",
  ];
  for (const key of numKeys) {
    if (!(key in obj)) {
      continue;
    }
    const val = obj[key];
    if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
      notify?.(
        `pi-context-prune: config key "${key}" must be a non-negative number; using default (${DEFAULTS[key]})`,
        "warning",
      );
    } else {
      config[key] = val;
    }
  }

  const boolKeys: Array<
    "supersededReadsEnabled" | "duplicateReadsEnabled" | "adaptivePolicyEnabled"
  > = [
    "supersededReadsEnabled",
    "duplicateReadsEnabled",
    "adaptivePolicyEnabled",
  ];
  for (const key of boolKeys) {
    if (!(key in obj)) {
      continue;
    }
    const val = obj[key];
    if (typeof val !== "boolean") {
      notify?.(
        `pi-context-prune: config key "${key}" must be a boolean; using default (${DEFAULTS[key]})`,
        "warning",
      );
    } else {
      config[key] = val;
    }
  }

  return config;
}
