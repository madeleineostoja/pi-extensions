import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "pi-subagents/runtime";

export type RoleConfig = {
  model?: string;
  type?: string;
  thinking?: ThinkingLevel;
};

export type TaskReviewConfig = {
  mode?: "auto" | "always";
  maxSkipDiffChars?: number;
  maxSkipFiles?: number;
};

export type ScoutConfig = {
  enabled?: boolean;
  mode?: "auto" | "always" | "off";
  type?: string;
  model?: string;
  maxResultChars?: number;
  timeoutMs?: number;
};

export type ImplementConfig = {
  implementer?: RoleConfig;
  reviewer?: RoleConfig;
  maxParallel?: number;
  verifyCommand?: string;
  planner?: RoleConfig;
  selfHeal?: RoleConfig;
  taskReview?: TaskReviewConfig;
  scout?: ScoutConfig;
};

export type ConfigReadResult = {
  path: string;
  config: ImplementConfig;
  warning?: string;
};

export type EffectiveRole = {
  model?: string;
  type: string;
  thinking?: ThinkingLevel;
};

export type EffectiveRoles = {
  implementer: EffectiveRole;
  reviewer: EffectiveRole;
  planner: EffectiveRole;
  selfHeal: EffectiveRole;
};

export type EffectiveScoutConfig = {
  enabled: boolean;
  mode: "auto" | "always" | "off";
  type: string;
  model?: string;
  maxResultChars: number;
  timeoutMs: number;
};

export const DEFAULT_SUBAGENT_TYPE = "general-purpose";
const DEFAULT_PLANNER_TYPE = "Explore";
const DEFAULT_SELF_HEAL_TYPE = DEFAULT_SUBAGENT_TYPE;
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const DEFAULT_MAX_PARALLEL = 3;
const HARD_MAX_PARALLEL = 8;

const DEFAULT_TASK_REVIEW_MODE = "auto";
const DEFAULT_MAX_SKIP_DIFF_CHARS = 2000;
const DEFAULT_MAX_SKIP_FILES = 3;
const HARD_MAX_SKIP_DIFF_CHARS = 10000;
const HARD_MAX_SKIP_FILES = 10;

const DEFAULT_SCOUT_ENABLED = true;
const DEFAULT_SCOUT_MODE = "auto";
const DEFAULT_SCOUT_TYPE = "Explore";
const DEFAULT_MAX_RESULT_CHARS = 50000;
const DEFAULT_TIMEOUT_MS = 120000;
const HARD_MAX_RESULT_CHARS = 200000;
const HARD_MAX_TIMEOUT_MS = 600000;

export function getConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-implement", "config.json");
}

export function parseConfig(raw: string): {
  config: ImplementConfig;
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
    const config: ImplementConfig = {};
    const warningParts: string[] = [];

    if (object.maxParallel !== undefined) {
      const mp = object.maxParallel;
      if (typeof mp === "number" && Number.isInteger(mp) && mp > 0) {
        config.maxParallel = Math.min(mp, HARD_MAX_PARALLEL);
      } else {
        warningParts.push("maxParallel must be a positive integer");
      }
    }

    if (object.verifyCommand !== undefined) {
      if (
        typeof object.verifyCommand === "string" &&
        object.verifyCommand.trim()
      ) {
        config.verifyCommand = object.verifyCommand.trim();
      } else {
        warningParts.push("verifyCommand must be a non-empty string");
      }
    }

    if (object.taskReview !== undefined) {
      const tr = object.taskReview;
      if (typeof tr !== "object" || tr === null || Array.isArray(tr)) {
        warningParts.push("taskReview must be an object");
      } else {
        const trObj = tr as Record<string, unknown>;
        const taskReview: TaskReviewConfig = {};
        if (trObj.mode !== undefined) {
          if (trObj.mode === "auto" || trObj.mode === "always") {
            taskReview.mode = trObj.mode;
          } else {
            warningParts.push('taskReview.mode must be "auto" or "always"');
          }
        }
        if (trObj.maxSkipDiffChars !== undefined) {
          const msd = trObj.maxSkipDiffChars;
          if (typeof msd === "number" && Number.isInteger(msd) && msd > 0) {
            taskReview.maxSkipDiffChars = Math.min(
              msd,
              HARD_MAX_SKIP_DIFF_CHARS,
            );
          } else {
            warningParts.push(
              "taskReview.maxSkipDiffChars must be a positive integer",
            );
          }
        }
        if (trObj.maxSkipFiles !== undefined) {
          const msf = trObj.maxSkipFiles;
          if (typeof msf === "number" && Number.isInteger(msf) && msf > 0) {
            taskReview.maxSkipFiles = Math.min(msf, HARD_MAX_SKIP_FILES);
          } else {
            warningParts.push(
              "taskReview.maxSkipFiles must be a positive integer",
            );
          }
        }
        config.taskReview = taskReview;
      }
    }

    if (object.scout !== undefined) {
      const sc = object.scout;
      if (typeof sc !== "object" || sc === null || Array.isArray(sc)) {
        warningParts.push("scout must be an object");
      } else {
        const scObj = sc as Record<string, unknown>;
        const scout: ScoutConfig = {};
        if (scObj.enabled !== undefined) {
          if (typeof scObj.enabled === "boolean") {
            scout.enabled = scObj.enabled;
          } else {
            warningParts.push("scout.enabled must be a boolean");
          }
        }
        if (scObj.mode !== undefined) {
          if (
            scObj.mode === "auto" ||
            scObj.mode === "always" ||
            scObj.mode === "off"
          ) {
            scout.mode = scObj.mode;
          } else {
            warningParts.push('scout.mode must be "auto", "always", or "off"');
          }
        }
        if (scObj.type !== undefined) {
          if (typeof scObj.type === "string") {
            const type = scObj.type.trim();
            if (type) {
              scout.type = type;
            } else {
              warningParts.push("scout.type must be a non-empty string");
            }
          } else {
            warningParts.push("scout.type must be a string");
          }
        }
        if (scObj.model !== undefined) {
          if (typeof scObj.model === "string") {
            const model = scObj.model.trim();
            if (model) {
              scout.model = model;
            } else {
              warningParts.push("scout.model must be a non-empty string");
            }
          } else {
            warningParts.push("scout.model must be a string");
          }
        }
        if (scObj.maxResultChars !== undefined) {
          const mrc = scObj.maxResultChars;
          if (typeof mrc === "number" && Number.isInteger(mrc) && mrc > 0) {
            scout.maxResultChars = Math.min(mrc, HARD_MAX_RESULT_CHARS);
          } else {
            warningParts.push(
              "scout.maxResultChars must be a positive integer",
            );
          }
        }
        if (scObj.timeoutMs !== undefined) {
          const tm = scObj.timeoutMs;
          if (typeof tm === "number" && Number.isInteger(tm) && tm > 0) {
            scout.timeoutMs = Math.min(tm, HARD_MAX_TIMEOUT_MS);
          } else {
            warningParts.push("scout.timeoutMs must be a positive integer");
          }
        }
        config.scout = scout;
      }
    }

    for (const role of [
      "implementer",
      "reviewer",
      "planner",
      "selfHeal",
    ] as const) {
      const value = object[role];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        warningParts.push(`${role} config must be an object`);
        continue;
      }
      const roleObject = value as Record<string, unknown>;
      const roleConfig: RoleConfig = {};
      if (roleObject.model !== undefined) {
        if (typeof roleObject.model === "string") {
          const model = roleObject.model.trim();
          if (model) {
            roleConfig.model = model;
          }
        } else {
          warningParts.push(`${role}.model must be a string`);
        }
      }
      if (roleObject.type !== undefined) {
        if (typeof roleObject.type === "string") {
          const type = roleObject.type.trim();
          if (type) {
            roleConfig.type = type;
          }
        } else {
          warningParts.push(`${role}.type must be a string`);
        }
      }
      if (roleObject.thinking !== undefined) {
        if (
          typeof roleObject.thinking === "string" &&
          THINKING_LEVELS.has(roleObject.thinking as ThinkingLevel)
        ) {
          roleConfig.thinking = roleObject.thinking as ThinkingLevel;
        } else {
          warningParts.push(
            `${role}.thinking must be one of off, minimal, low, medium, high, xhigh`,
          );
        }
      }
      config[role] = roleConfig;
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

export function resolveMaxParallel(config: ImplementConfig): number {
  const fromConfig = config.maxParallel ?? DEFAULT_MAX_PARALLEL;
  return Math.min(fromConfig, HARD_MAX_PARALLEL);
}

export type EffectiveTaskReviewConfig = {
  mode: "auto" | "always";
  maxSkipDiffChars: number;
  maxSkipFiles: number;
};

export function resolveEffectiveTaskReview(
  config: ImplementConfig,
): EffectiveTaskReviewConfig {
  const taskReview = config.taskReview ?? {};
  return {
    mode: taskReview.mode ?? DEFAULT_TASK_REVIEW_MODE,
    maxSkipDiffChars: Math.min(
      taskReview.maxSkipDiffChars ?? DEFAULT_MAX_SKIP_DIFF_CHARS,
      HARD_MAX_SKIP_DIFF_CHARS,
    ),
    maxSkipFiles: Math.min(
      taskReview.maxSkipFiles ?? DEFAULT_MAX_SKIP_FILES,
      HARD_MAX_SKIP_FILES,
    ),
  };
}

export function resolveEffectiveScoutConfig(
  config: ImplementConfig,
): EffectiveScoutConfig {
  const scout = config.scout ?? {};
  return {
    enabled: scout.enabled ?? DEFAULT_SCOUT_ENABLED,
    mode: scout.mode ?? DEFAULT_SCOUT_MODE,
    type: scout.type ?? DEFAULT_SCOUT_TYPE,
    model: scout.model,
    maxResultChars: Math.min(
      scout.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
      HARD_MAX_RESULT_CHARS,
    ),
    timeoutMs: Math.min(
      scout.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      HARD_MAX_TIMEOUT_MS,
    ),
  };
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

export function currentModelRef(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  if (!model?.provider || !model.id) {
    return undefined;
  }
  return `${model.provider}/${model.id}`;
}

export function resolveEffectiveRoles(
  config: ImplementConfig,
  _ctx: ExtensionContext,
): { ok: true; roles: EffectiveRoles } | { ok: false; reason: string } {
  return {
    ok: true,
    roles: {
      implementer: {
        model: config.implementer?.model,
        type: config.implementer?.type ?? DEFAULT_SUBAGENT_TYPE,
        thinking: config.implementer?.thinking,
      },
      reviewer: {
        model: config.reviewer?.model,
        type: config.reviewer?.type ?? DEFAULT_SUBAGENT_TYPE,
        thinking: config.reviewer?.thinking,
      },
      planner: {
        model: config.planner?.model,
        type: config.planner?.type ?? DEFAULT_PLANNER_TYPE,
        thinking: config.planner?.thinking,
      },
      selfHeal: {
        model: config.selfHeal?.model ?? config.implementer?.model,
        type: config.selfHeal?.type ?? DEFAULT_SELF_HEAL_TYPE,
        thinking: config.selfHeal?.thinking ?? config.implementer?.thinking,
      },
    },
  };
}

export function reviewerDefaultTypeWarning(
  roles: EffectiveRoles,
): string | undefined {
  if (roles.reviewer.type !== DEFAULT_SUBAGENT_TYPE) {
    return undefined;
  }
  return "Reviewer subagent is using the default general-purpose type. Review safety is instruction-enforced only; configure reviewer.type to a dedicated read-only review agent for stronger isolation.";
}

export function formatConfigStatus(
  result: ConfigReadResult,
  roles?: EffectiveRoles,
): string {
  const lines = [`Config: ${result.path}`];
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  lines.push(
    `Implementer model: ${roles?.implementer.model ?? result.config.implementer?.model ?? "(subagent type default)"}`,
  );
  lines.push(
    `Implementer subagent: ${roles?.implementer.type ?? result.config.implementer?.type ?? DEFAULT_SUBAGENT_TYPE}`,
  );
  lines.push(
    `Implementer thinking: ${roles?.implementer.thinking ?? result.config.implementer?.thinking ?? "(session default)"}`,
  );
  lines.push(
    `Reviewer model: ${roles?.reviewer.model ?? result.config.reviewer?.model ?? "(subagent type default)"}`,
  );
  lines.push(
    `Reviewer subagent: ${roles?.reviewer.type ?? result.config.reviewer?.type ?? DEFAULT_SUBAGENT_TYPE}`,
  );
  lines.push(
    `Reviewer thinking: ${roles?.reviewer.thinking ?? result.config.reviewer?.thinking ?? "(session default)"}`,
  );
  lines.push(
    `Planner model: ${roles?.planner.model ?? result.config.planner?.model ?? "(subagent type default)"}`,
  );
  lines.push(
    `Planner subagent: ${roles?.planner.type ?? result.config.planner?.type ?? DEFAULT_PLANNER_TYPE}`,
  );
  lines.push(
    `Planner thinking: ${roles?.planner.thinking ?? result.config.planner?.thinking ?? "(session default)"}`,
  );
  lines.push(
    `Self-heal model: ${roles?.selfHeal.model ?? result.config.selfHeal?.model ?? result.config.implementer?.model ?? "(subagent type default)"}`,
  );
  lines.push(
    `Self-heal subagent: ${roles?.selfHeal.type ?? result.config.selfHeal?.type ?? DEFAULT_SELF_HEAL_TYPE}`,
  );
  lines.push(
    `Self-heal thinking: ${roles?.selfHeal.thinking ?? result.config.selfHeal?.thinking ?? result.config.implementer?.thinking ?? "(session default)"}`,
  );
  if (roles) {
    const defaultReviewerWarning = reviewerDefaultTypeWarning(roles);
    if (defaultReviewerWarning) {
      lines.push(`Warning: ${defaultReviewerWarning}`);
    }
  }
  if (result.config.maxParallel !== undefined) {
    lines.push(`Max parallel: ${result.config.maxParallel}`);
  }
  if (result.config.verifyCommand) {
    lines.push(`Verify command: ${result.config.verifyCommand}`);
  }
  const effectiveTaskReview = resolveEffectiveTaskReview(result.config);
  lines.push(`Task review mode: ${effectiveTaskReview.mode}`);
  lines.push(
    `Task review skip thresholds: ${effectiveTaskReview.maxSkipDiffChars} chars, ${effectiveTaskReview.maxSkipFiles} files`,
  );
  const effectiveScout = resolveEffectiveScoutConfig(result.config);
  lines.push(`Scout enabled: ${effectiveScout.enabled}`);
  lines.push(`Scout mode: ${effectiveScout.mode}`);
  lines.push(`Scout subagent: ${effectiveScout.type}`);
  if (effectiveScout.model) {
    lines.push(`Scout model: ${effectiveScout.model}`);
  }
  lines.push(`Scout max result chars: ${effectiveScout.maxResultChars}`);
  lines.push(`Scout timeout: ${effectiveScout.timeoutMs}ms`);
  return lines.join("\n");
}
