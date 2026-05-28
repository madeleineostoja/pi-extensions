import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type RoleConfig = {
  model?: string;
  type?: string;
};

export type ImplementConfig = {
  implementer?: RoleConfig;
  reviewer?: RoleConfig;
};

export type ConfigReadResult = {
  path: string;
  config: ImplementConfig;
  warning?: string;
};

export type EffectiveRole = {
  model: string;
  type: string;
};

export type EffectiveRoles = {
  implementer: EffectiveRole;
  reviewer: EffectiveRole;
};

const DEFAULT_SUBAGENT_TYPE = "general-purpose";

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
    for (const role of ["implementer", "reviewer"] as const) {
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
  ctx: ExtensionContext,
): { ok: true; roles: EffectiveRoles } | { ok: false; reason: string } {
  const current = currentModelRef(ctx);
  const implementerModel = config.implementer?.model ?? current;
  const reviewerModel = config.reviewer?.model ?? current;
  if (!implementerModel || !reviewerModel) {
    return {
      ok: false,
      reason:
        "No current session model is available and role models are not configured.",
    };
  }
  return {
    ok: true,
    roles: {
      implementer: {
        model: implementerModel,
        type: config.implementer?.type ?? DEFAULT_SUBAGENT_TYPE,
      },
      reviewer: {
        model: reviewerModel,
        type: config.reviewer?.type ?? DEFAULT_SUBAGENT_TYPE,
      },
    },
  };
}

export function isModelRef(value: string): boolean {
  return /^[^/\s]+\/.+\S$/.test(value);
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
    `Implementer model: ${roles?.implementer.model ?? result.config.implementer?.model ?? "(current session)"}`,
  );
  lines.push(
    `Implementer subagent: ${roles?.implementer.type ?? result.config.implementer?.type ?? DEFAULT_SUBAGENT_TYPE}`,
  );
  lines.push(
    `Reviewer model: ${roles?.reviewer.model ?? result.config.reviewer?.model ?? "(current session)"}`,
  );
  lines.push(
    `Reviewer subagent: ${roles?.reviewer.type ?? result.config.reviewer?.type ?? DEFAULT_SUBAGENT_TYPE}`,
  );
  return lines.join("\n");
}
