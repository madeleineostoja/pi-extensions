import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "pi-subagents/runtime";

export type RoleConfig = {
  model?: string;
  type?: string;
  thinking?: ThinkingLevel;
};

export type ImplementConfig = {
  implementer?: RoleConfig;
  reviewer?: RoleConfig;
  planner?: RoleConfig;
  recovery?: RoleConfig;
  workerConcurrency?: number;
  maxParallel?: number;
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
  recovery?: EffectiveRole;
  selfHeal: EffectiveRole;
};

export const DEFAULT_SUBAGENT_TYPE = "general-purpose";
const DEFAULT_PLANNER_TYPE = "Explore";
const DEFAULT_RECOVERY_TYPE = DEFAULT_SUBAGENT_TYPE;
const DEFAULT_WORKER_CONCURRENCY = 3;
const HARD_MAX_CONCURRENCY = 8;
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function getConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", "pi-implement", "config.json");
}

export function parseConfig(raw: string): {
  config: ImplementConfig;
  warning?: string;
} {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {
        config: {},
        warning: "Config must be a JSON object; ignoring it.",
      };
    }
    const object = value as Record<string, unknown>;
    const config: ImplementConfig = {};
    const invalid: string[] = [];
    if (object.workerConcurrency !== undefined) {
      if (
        typeof object.workerConcurrency === "number" &&
        Number.isInteger(object.workerConcurrency) &&
        object.workerConcurrency > 0
      ) {
        config.workerConcurrency = Math.min(
          object.workerConcurrency,
          HARD_MAX_CONCURRENCY,
        );
      } else {
        invalid.push("workerConcurrency must be a positive integer");
      }
    }
    for (const name of [
      "planner",
      "implementer",
      "reviewer",
      "recovery",
    ] as const) {
      const role = parseRole(object[name], name, invalid);
      if (role) {
        config[name] = role;
      }
    }
    for (const removed of ["maxParallel", "verifyCommand", "selfHeal"]) {
      if (object[removed] !== undefined) {
        invalid.push(`${removed} is unsupported in VNext`);
      }
    }
    return {
      config,
      ...(invalid.length > 0
        ? { warning: `Invalid config fields ignored: ${invalid.join(", ")}.` }
        : {}),
    };
  } catch (error) {
    return {
      config: {},
      warning: `Could not parse config JSON; ignoring it. ${message(error)}`,
    };
  }
}

export function resolveWorkerConcurrency(config: ImplementConfig): number {
  return Math.min(
    config.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY,
    HARD_MAX_CONCURRENCY,
  );
}

export const resolveMaxParallel = resolveWorkerConcurrency;

export function readConfig(agentDir: string): ConfigReadResult {
  const path = getConfigPath(agentDir);
  try {
    return { path, ...parseConfig(readFileSync(path, "utf-8")) };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return nodeError.code === "ENOENT"
      ? { path, config: {} }
      : {
          path,
          config: {},
          warning: `Could not read config; ignoring it. ${nodeError.message}`,
        };
  }
}

export function currentModelRef(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  return model?.provider && model.id
    ? `${model.provider}/${model.id}`
    : undefined;
}

export function resolveEffectiveRoles(
  config: ImplementConfig,
  _ctx: ExtensionContext,
): { ok: true; roles: EffectiveRoles } | { ok: false; reason: string } {
  const implementer = effective(config.implementer, DEFAULT_SUBAGENT_TYPE);
  const recovery = effective(
    config.recovery,
    DEFAULT_RECOVERY_TYPE,
    implementer,
  );
  return {
    ok: true,
    roles: {
      implementer,
      reviewer: effective(config.reviewer, DEFAULT_SUBAGENT_TYPE),
      planner: effective(config.planner, DEFAULT_PLANNER_TYPE),
      recovery,
      selfHeal: recovery,
    },
  };
}

export function reviewerDefaultTypeWarning(
  roles: EffectiveRoles,
): string | undefined {
  return roles.reviewer.type === DEFAULT_SUBAGENT_TYPE
    ? "Reviewer subagent is using the default general-purpose type. Configure reviewer.type to a dedicated read-only review agent for stronger isolation."
    : undefined;
}

export function formatConfigStatus(
  result: ConfigReadResult,
  roles?: EffectiveRoles,
): string {
  const lines = [`Config: ${result.path}`];
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  for (const name of [
    "planner",
    "implementer",
    "reviewer",
    "recovery",
  ] as const) {
    const role =
      roles?.[name] ??
      effective(
        result.config[name],
        name === "planner" ? DEFAULT_PLANNER_TYPE : DEFAULT_SUBAGENT_TYPE,
      );
    lines.push(
      `${capitalize(name)} model: ${role.model ?? "(subagent type default)"}`,
    );
    lines.push(`${capitalize(name)} subagent: ${role.type}`);
    lines.push(
      `${capitalize(name)} thinking: ${role.thinking ?? "(session default)"}`,
    );
  }
  lines.push(`Worker concurrency: ${resolveWorkerConcurrency(result.config)}`);
  const reviewerWarning = roles && reviewerDefaultTypeWarning(roles);
  if (reviewerWarning) {
    lines.push(`Warning: ${reviewerWarning}`);
  }
  return lines.join("\n");
}

function parseRole(
  value: unknown,
  name: string,
  invalid: string[],
): RoleConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid.push(`${name} config must be an object`);
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const role: RoleConfig = {};
  for (const field of ["model", "type"] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] === "string" && input[field].trim()) {
        role[field] = input[field].trim();
      } else {
        invalid.push(`${name}.${field} must be a string`);
      }
    }
  }
  if (input.thinking !== undefined) {
    if (
      typeof input.thinking === "string" &&
      THINKING_LEVELS.has(input.thinking as ThinkingLevel)
    ) {
      role.thinking = input.thinking as ThinkingLevel;
    } else {
      invalid.push(
        `${name}.thinking must be one of off, minimal, low, medium, high, xhigh`,
      );
    }
  }
  return role;
}

function effective(
  config: RoleConfig | undefined,
  type: string,
  fallback?: EffectiveRole,
): EffectiveRole {
  return {
    model: config?.model ?? fallback?.model,
    type: config?.type ?? type,
    thinking: config?.thinking ?? fallback?.thinking,
  };
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
