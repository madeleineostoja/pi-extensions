import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { LIMITS, boundedError, boundedText, hasControl } from "./bounds.js";

const REGISTRY = "https://registry.npmjs.org/";

type NpmChild = Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> & {
  kill(signal?: NodeJS.Signals): boolean;
};
type NpmRun = (
  executable: string,
  args: string[],
  options: Record<string, unknown>,
) => NpmChild;

export class NpmError extends Error {
  constructor(
    readonly kind:
      | "unavailable"
      | "malformed"
      | "oversized"
      | "timeout"
      | "cancelled",
    message: string,
  ) {
    super(boundedError(message));
    this.name = "NpmError";
  }
}

export type NpmPackage = {
  rank: number;
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  date?: string;
  license?: string;
  publisher?: string;
  links: { npm: string; homepage?: string; repository?: string };
};

export async function searchNpm(
  query: string,
  limit: number,
  signal: AbortSignal,
  dependencies: {
    run?: NpmRun;
    executable?: string;
    makeDirectory?: typeof mkdtemp;
    writeConfig?: typeof writeFile;
    removeDirectory?: typeof rm;
  } = {},
): Promise<{ results: NpmPackage[]; discarded: number; truncated: boolean }> {
  if (signal.aborted) {
    throw aborted(signal);
  }
  let directory: string;
  try {
    directory = await (dependencies.makeDirectory ?? mkdtemp)(
      join(tmpdir(), "pipkin-npm-"),
    );
  } catch {
    throw new NpmError("unavailable", "npm search temporary setup failed.");
  }
  let primaryError: unknown;
  const userconfig = join(directory, "user.npmrc");
  const globalconfig = join(directory, "global.npmrc");
  const cache = join(directory, "cache");
  try {
    try {
      await Promise.all([
        (dependencies.writeConfig ?? writeFile)(userconfig, ""),
        (dependencies.writeConfig ?? writeFile)(globalconfig, ""),
      ]);
    } catch {
      throw new NpmError("unavailable", "npm search temporary setup failed.");
    }
    const args = [
      "search",
      "--json",
      `--searchlimit=${limit}`,
      `--registry=${REGISTRY}`,
      "--prefer-online",
      "--no-color",
      "--",
      query,
    ];
    const run = dependencies.run ?? (execa as unknown as NpmRun);
    if (signal.aborted) {
      throw aborted(signal);
    }
    let child: NpmChild;
    try {
      child = run(dependencies.executable ?? "npm", args, {
        cwd: directory,
        env: npmEnvironment(directory, userconfig, globalconfig, cache),
        shell: false,
        reject: false,
        maxBuffer: LIMITS.responseBytes,
        all: false,
        killDescendants: true,
        forceKillAfterDelay: 1_000,
      });
    } catch {
      throw new NpmError("unavailable", "npm search could not be started.");
    }
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    let completed: { exitCode: number; stdout: string; stderr: string };
    try {
      completed = await child;
    } catch (error) {
      if (signal.aborted) {
        throw aborted(signal);
      }
      if (isMaxBuffer(error)) {
        throw new NpmError(
          "oversized",
          "npm search output exceeded the supported size limit.",
        );
      }
      throw new NpmError(
        "unavailable",
        "npm search is temporarily unavailable.",
      );
    } finally {
      signal.removeEventListener("abort", stop);
    }
    if (signal.aborted) {
      throw aborted(signal);
    }
    if (
      Buffer.byteLength(completed.stdout, "utf8") > LIMITS.responseBytes ||
      Buffer.byteLength(completed.stderr, "utf8") > LIMITS.responseBytes
    ) {
      throw new NpmError(
        "oversized",
        "npm search output exceeded the supported size limit.",
      );
    }
    if (completed.exitCode !== 0) {
      throw new NpmError(
        "unavailable",
        "npm search is temporarily unavailable.",
      );
    }
    return parseNpm(completed.stdout, limit);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupDirectory(
      dependencies.removeDirectory ?? rm,
      directory,
      primaryError,
    );
  }
}

async function cleanupDirectory(
  removeDirectory: typeof rm,
  directory: string,
  primaryError: unknown,
): Promise<void> {
  try {
    await removeDirectory(directory, { force: true, recursive: true });
  } catch {
    if (primaryError === undefined) {
      throw new NpmError("unavailable", "npm search temporary cleanup failed.");
    }
  }
}

export function npmEnvironment(
  home: string,
  userconfig: string,
  globalconfig: string,
  cache: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[key]) {
      environment[key] = process.env[key];
    }
  }
  return {
    ...environment,
    HOME: home,
    NPM_CONFIG_USERCONFIG: userconfig,
    NPM_CONFIG_GLOBALCONFIG: globalconfig,
    NPM_CONFIG_CACHE: cache,
  };
}

function parseNpm(
  stdout: string,
  limit: number,
): { results: NpmPackage[]; discarded: number; truncated: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new NpmError(
      "malformed",
      "npm search returned malformed package data.",
    );
  }
  if (!Array.isArray(raw)) {
    throw new NpmError(
      "malformed",
      "npm search returned malformed package data.",
    );
  }
  let truncated = raw.length > limit;
  let discarded = 0;
  const results: NpmPackage[] = [];
  for (const [index, item] of raw.slice(0, limit).entries()) {
    const normalized = normalizePackage(item, index + 1);
    if (normalized) {
      truncated ||= packageFieldsWereShortened(item);
      results.push(normalized);
    } else {
      discarded++;
    }
  }
  return { results, discarded, truncated };
}

function normalizePackage(
  value: unknown,
  rank: number,
): NpmPackage | undefined {
  const item = object(value);
  const name =
    item && field(item.name, LIMITS.packageNameChars, validPackageName);
  const version =
    item && field(item.version, LIMITS.versionChars, validVersion);
  if (!item || !name || !version) {
    return undefined;
  }
  const description = optional(item.description, 400);
  const keywords = Array.isArray(item.keywords)
    ? item.keywords
        .slice(0, LIMITS.keywordCount)
        .flatMap((keyword) => optional(keyword, LIMITS.languageChars) ?? [])
    : undefined;
  const publisher = object(item.publisher);
  const username =
    publisher && optional(publisher.username, LIMITS.languageChars);
  const safePublisher = username?.includes("@") ? undefined : username;
  const links = object(item.links);
  const homepage = links && safeUrl(links.homepage);
  const repository = links && safeRepositoryUrl(links.repository);
  const date = optional(item.date, LIMITS.dateChars);
  const license = optional(item.license, LIMITS.languageChars);
  return {
    rank,
    name,
    version,
    ...(description ? { description } : {}),
    ...(keywords?.length ? { keywords } : {}),
    ...(date ? { date } : {}),
    ...(license ? { license } : {}),
    ...(safePublisher ? { publisher: safePublisher } : {}),
    links: {
      npm: `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
      ...(homepage ? { homepage } : {}),
      ...(repository ? { repository } : {}),
    },
  };
}

function packageFieldsWereShortened(value: unknown): boolean {
  const item = object(value);
  const publisher = object(item?.publisher);
  const links = object(item?.links);
  return (
    [
      [item?.description, 400],
      [item?.version, LIMITS.versionChars],
      [item?.date, LIMITS.dateChars],
      [item?.license, LIMITS.languageChars],
      [publisher?.username, LIMITS.languageChars],
    ].some(
      ([field, maximum]) =>
        typeof field === "string" &&
        (!optional(field, Number(maximum)) || field.length > Number(maximum)),
    ) ||
    (typeof publisher?.username === "string" &&
      publisher.username.includes("@")) ||
    (typeof links?.homepage === "string" && !safeUrl(links.homepage)) ||
    (typeof links?.repository === "string" &&
      !safeRepositoryUrl(links.repository)) ||
    (Array.isArray(item?.keywords) &&
      (item.keywords.length > LIMITS.keywordCount ||
        item.keywords.some(
          (keyword) =>
            typeof keyword !== "string" ||
            !optional(keyword, LIMITS.languageChars) ||
            keyword.length > LIMITS.languageChars,
        )))
  );
}

function field(
  value: unknown,
  maximum: number,
  validate: (value: string) => boolean,
): string | undefined {
  return typeof value === "string" &&
    !hasControl(value) &&
    value.length <= maximum &&
    value.trim() &&
    validate(value.trim())
    ? value.trim()
    : undefined;
}
function optional(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || hasControl(value)) {
    return undefined;
  }
  const text = boundedText(value, maximum);
  return text || undefined;
}
function validPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value);
}
function validVersion(value: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(value);
}
function safeUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 300 ||
    hasControl(value)
  ) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
function safeRepositoryUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 300
    ? safeUrl(value.replace(/^git\+/, "").replace(/\.git$/, ""))
    : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function isMaxBuffer(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "isMaxBuffer" in error &&
    (error as { isMaxBuffer?: unknown }).isMaxBuffer,
  );
}
function aborted(signal: AbortSignal): NpmError {
  return new NpmError(
    signal.reason === "deadline" ? "timeout" : "cancelled",
    signal.reason === "deadline"
      ? "npm search timed out."
      : "npm search was cancelled.",
  );
}
