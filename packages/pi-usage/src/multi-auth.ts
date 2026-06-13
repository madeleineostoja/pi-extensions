import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MultiAuthCredential = {
  providerId: string;
  credentialId: string;
  secret: string;
};

type MultiAuthState = {
  providers?: Record<string, MultiAuthProviderState>;
};

type MultiAuthProviderState = {
  credentialIds?: unknown;
  activeIndex?: unknown;
  manualActiveCredentialId?: unknown;
};

type StoredApiKeyCredential = {
  type: "api_key";
  key: string;
};

const PI_DELEGATED_AUTH_RUNTIME_DIR_ENV = "PI_DELEGATED_AUTH_RUNTIME_DIR";
const PI_MULTI_AUTH_RUNTIME_DIR_ENV = "PI_MULTI_AUTH_RUNTIME_DIR";
const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function normalizeEnvPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function getMultiAuthRuntimeRoot(agentDir = getAgentDir()): string {
  return (
    normalizeEnvPath(process.env[PI_DELEGATED_AUTH_RUNTIME_DIR_ENV]) ??
    normalizeEnvPath(process.env[PI_MULTI_AUTH_RUNTIME_DIR_ENV]) ??
    normalizeEnvPath(process.env[PI_CODING_AGENT_DIR_ENV]) ??
    agentDir
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function asMultiAuthState(value: unknown): MultiAuthState | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    providers: isRecord(value.providers)
      ? (value.providers as Record<string, MultiAuthProviderState>)
      : undefined,
  };
}

function asCredentialIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (credentialId): credentialId is string =>
      typeof credentialId === "string" && credentialId.trim().length > 0,
  );
}

function resolveActiveCredentialId(
  state: MultiAuthProviderState | undefined,
): string | null {
  const credentialIds = asCredentialIds(state?.credentialIds);
  if (credentialIds.length === 0) {
    return null;
  }

  const manualActiveCredentialId =
    typeof state?.manualActiveCredentialId === "string"
      ? state.manualActiveCredentialId.trim()
      : "";
  if (
    manualActiveCredentialId &&
    credentialIds.includes(manualActiveCredentialId)
  ) {
    return manualActiveCredentialId;
  }

  const activeIndex = state?.activeIndex;
  if (
    typeof activeIndex === "number" &&
    Number.isInteger(activeIndex) &&
    activeIndex >= 0 &&
    activeIndex < credentialIds.length
  ) {
    return credentialIds[activeIndex] ?? null;
  }

  return credentialIds[0] ?? null;
}

function asStoredApiKeyCredential(
  value: unknown,
): StoredApiKeyCredential | null {
  if (
    !isRecord(value) ||
    value.type !== "api_key" ||
    typeof value.key !== "string"
  ) {
    return null;
  }
  const key = value.key.trim();
  return key ? { type: "api_key", key } : null;
}

export function resolveActiveMultiAuthCredential(
  providerIds: readonly string[],
  runtimeRoot = getMultiAuthRuntimeRoot(),
): MultiAuthCredential | null {
  const state = asMultiAuthState(
    readJsonFile(join(runtimeRoot, "multi-auth.json")),
  );
  const auth = readJsonFile(join(runtimeRoot, "auth.json"));
  if (!state?.providers || !isRecord(auth)) {
    return null;
  }

  for (const providerId of providerIds) {
    const providerState = state.providers[providerId];
    const credentialId = resolveActiveCredentialId(providerState);
    if (!credentialId) {
      continue;
    }

    const credential = asStoredApiKeyCredential(auth[credentialId]);
    if (!credential) {
      continue;
    }

    return {
      providerId,
      credentialId,
      secret: credential.key,
    };
  }

  return null;
}

export function getMultiAuthCredentialIds(
  providerId: string,
  runtimeRoot = getMultiAuthRuntimeRoot(),
): string[] {
  const state = asMultiAuthState(
    readJsonFile(join(runtimeRoot, "multi-auth.json")),
  );
  if (!state?.providers) {
    return [];
  }
  const providerState = state.providers[providerId];
  return asCredentialIds(providerState?.credentialIds);
}

export function getMultiAuthCredentialSecret(
  credentialId: string,
  runtimeRoot = getMultiAuthRuntimeRoot(),
): string | null {
  const auth = readJsonFile(join(runtimeRoot, "auth.json"));
  if (!isRecord(auth)) {
    return null;
  }
  const credential = asStoredApiKeyCredential(auth[credentialId]);
  return credential?.key ?? null;
}

export function isMultiAuthCredentialForProvider(
  credentialId: string,
  providerId: string,
  runtimeRoot = getMultiAuthRuntimeRoot(),
): boolean {
  const state = asMultiAuthState(
    readJsonFile(join(runtimeRoot, "multi-auth.json")),
  );
  if (!state?.providers) {
    return false;
  }
  const providerState = state.providers[providerId];
  const credentialIds = asCredentialIds(providerState?.credentialIds);
  return credentialIds.includes(credentialId);
}
