import {
  getAgentDir,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { loadPipkinConfig } from "#lib/config";

export type Config = {
  staleTurns: number;
  minTokens: number;
  supersededReadsEnabled: boolean;
  duplicateReadsEnabled: boolean;
  coveredReadsEnabled: boolean;
  adaptivePolicyEnabled: boolean;
  afterConsumptionBashEnabled: boolean;
  batchPruningEnabled: boolean;
  emergencyContextReserveTokens: number;
  emergencyOrdinaryReadMinSavedTokens: number;
  emergencyMaxOrdinaryReads: number;
  batchMinCandidates: number;
  batchMinSavedTokens: number;
  batchMinNetValue: number;
  batchMaxCandidates: number;
  batchCooldownTurns: number;
  batchMaxSemanticRisk: number;
};

export const DEFAULTS: Config = {
  staleTurns: 4,
  minTokens: 256,
  supersededReadsEnabled: true,
  duplicateReadsEnabled: true,
  coveredReadsEnabled: true,
  adaptivePolicyEnabled: true,
  afterConsumptionBashEnabled: true,
  batchPruningEnabled: true,
  emergencyContextReserveTokens: 16000,
  emergencyOrdinaryReadMinSavedTokens: 4000,
  emergencyMaxOrdinaryReads: 2,
  batchMinCandidates: 2,
  batchMinSavedTokens: 8000,
  batchMinNetValue: 3000,
  batchMaxCandidates: 8,
  batchCooldownTurns: 2,
  batchMaxSemanticRisk: 3.0,
};

type Notifier = ExtensionUIContext["notify"];

export function defaultConfig(): Config {
  return { ...DEFAULTS };
}

export function loadConfig(notify?: Notifier, _readFile?: unknown): Config {
  const snapshot = loadPipkinConfig(getAgentDir());
  const issue = snapshot.issues.find(
    (issue) =>
      issue.path === snapshot.path ||
      issue.path === "config" ||
      issue.path === "context" ||
      issue.path.startsWith("context."),
  );
  if (issue && issue.message !== "file does not exist") {
    notify?.(
      `Context: config error in ${snapshot.path}: ${issue.message}`,
      "warning",
    );
  }
  return resolveConfig(snapshot.config.context, notify);
}

export function resolveConfig(
  section: Readonly<Record<string, unknown>> | undefined,
  notify?: Notifier,
): Config {
  if (section === undefined) {
    return defaultConfig();
  }

  const obj = section;
  const config = defaultConfig();

  const numKeys: Array<
    | "staleTurns"
    | "minTokens"
    | "emergencyContextReserveTokens"
    | "emergencyOrdinaryReadMinSavedTokens"
    | "emergencyMaxOrdinaryReads"
    | "batchMinCandidates"
    | "batchMinSavedTokens"
    | "batchMinNetValue"
    | "batchMaxCandidates"
    | "batchCooldownTurns"
    | "batchMaxSemanticRisk"
  > = [
    "staleTurns",
    "minTokens",
    "emergencyContextReserveTokens",
    "emergencyOrdinaryReadMinSavedTokens",
    "emergencyMaxOrdinaryReads",
    "batchMinCandidates",
    "batchMinSavedTokens",
    "batchMinNetValue",
    "batchMaxCandidates",
    "batchCooldownTurns",
    "batchMaxSemanticRisk",
  ];
  for (const key of numKeys) {
    if (!(key in obj)) {
      continue;
    }
    const val = obj[key];
    if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
      notify?.(
        `Context: config key "${key}" must be a non-negative number; using default (${DEFAULTS[key]})`,
        "warning",
      );
    } else {
      config[key] = val;
    }
  }

  const boolKeys: Array<
    | "supersededReadsEnabled"
    | "duplicateReadsEnabled"
    | "coveredReadsEnabled"
    | "adaptivePolicyEnabled"
    | "afterConsumptionBashEnabled"
    | "batchPruningEnabled"
  > = [
    "supersededReadsEnabled",
    "duplicateReadsEnabled",
    "coveredReadsEnabled",
    "adaptivePolicyEnabled",
    "afterConsumptionBashEnabled",
    "batchPruningEnabled",
  ];
  for (const key of boolKeys) {
    if (!(key in obj)) {
      continue;
    }
    const val = obj[key];
    if (typeof val !== "boolean") {
      notify?.(
        `Context: config key "${key}" must be a boolean; using default (${DEFAULTS[key]})`,
        "warning",
      );
    } else {
      config[key] = val;
    }
  }

  return config;
}
