import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  recovery: EffectiveRole;
};

export const DEFAULT_SUBAGENT_TYPE = "general-purpose";
const DEFAULT_PLANNER_TYPE = "Explore";
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
    const unsupported = Object.keys(object).filter(
      (key) =>
        ![
          "workerConcurrency",
          "planner",
          "implementer",
          "reviewer",
          "recovery",
        ].includes(key),
    );
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
    return {
      config,
      ...(invalid.length > 0 || unsupported.length > 0
        ? {
            warning: [
              invalid.length > 0
                ? `Invalid config fields ignored: ${invalid.join(", ")}.`
                : undefined,
              unsupported.length > 0
                ? `Unsupported config fields ignored: ${unsupported.join(", ")}.`
                : undefined,
            ]
              .filter((message): message is string => Boolean(message))
              .join(" "),
          }
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

export function resolveEffectiveRoles(config: ImplementConfig): {
  ok: true;
  roles: EffectiveRoles;
} {
  const implementer = effective(config.implementer, DEFAULT_SUBAGENT_TYPE);
  return {
    ok: true,
    roles: {
      implementer,
      reviewer: effective(config.reviewer, DEFAULT_SUBAGENT_TYPE),
      planner: effective(config.planner, DEFAULT_PLANNER_TYPE),
      recovery: effective(config.recovery, DEFAULT_SUBAGENT_TYPE, implementer),
    },
  };
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
