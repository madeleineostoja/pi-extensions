import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { canonicalPath, type ServerKind } from "./workspace.js";

const require = createRequire(import.meta.url);
export type TypeScriptSdk = {
  path: string;
  source: "workspace" | "packaged";
  version?: string;
};
export type ResolvedServer = {
  kind: ServerKind;
  command: string;
  args: string[];
  executableIdentity: string;
  typescript?: TypeScriptSdk;
};
export type UnavailableServer = {
  available: false;
  kind: ServerKind;
  reason: string;
};

export function resolveServer(
  kind: ServerKind,
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedServer | UnavailableServer {
  if (kind === "ruby") {
    return resolveRuby(workspace, env);
  }
  const packageName =
    kind === "typescript"
      ? "typescript-language-server"
      : "svelte-language-server";
  try {
    const entry = resolvePackageBin(packageName);
    const typescript =
      kind === "typescript" ? resolveTypeScriptSdk(workspace) : undefined;
    return {
      kind,
      command: process.execPath,
      args: [entry, "--stdio"],
      executableIdentity: `${canonicalPath(entry)}:${typescript?.path ?? ""}`,
      ...(typescript ? { typescript } : {}),
    };
  } catch (error) {
    return {
      available: false,
      kind,
      reason: `Missing packaged ${packageName}: ${String(error)}`,
    };
  }
}

export function resolveTypeScriptSdk(workspace: string): TypeScriptSdk {
  let current = canonicalPath(workspace);
  while (true) {
    const candidate = join(
      current,
      "node_modules",
      "typescript",
      "lib",
      "tsserverlibrary.js",
    );
    if (existsSync(candidate)) {
      return {
        path: canonicalPath(candidate),
        source: "workspace",
        version: packageVersion(dirname(dirname(candidate))),
      };
    }
    const parent = dirname(current);
    if (existsSync(join(current, ".git")) || parent === current) {
      break;
    }
    current = parent;
  }
  const fallback = require.resolve("typescript/lib/tsserverlibrary.js");
  return {
    path: canonicalPath(fallback),
    source: "packaged",
    version: packageVersion(dirname(dirname(fallback))),
  };
}

function resolveRuby(
  workspace: string,
  env: NodeJS.ProcessEnv,
): ResolvedServer | UnavailableServer {
  const local = join(canonicalPath(workspace), "bin", "ruby-lsp");
  const command = existsSync(local)
    ? local
    : resolvePathExecutable("ruby-lsp", env.PATH);
  if (!command) {
    return {
      available: false,
      kind: "ruby",
      reason: "ruby-lsp was not found in workspace/bin or PATH",
    };
  }
  return {
    kind: "ruby",
    command,
    args: [],
    executableIdentity: canonicalPath(command),
  };
}

function resolvePackageBin(packageName: string): string {
  const manifest = require.resolve(`${packageName}/package.json`);
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin =
    typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
  if (!bin) {
    throw new Error("package has no bin entry");
  }
  return resolve(dirname(manifest), bin);
}
function packageVersion(root: string): string | undefined {
  try {
    return (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        version?: string;
      }
    ).version;
  } catch {
    return undefined;
  }
}
function resolvePathExecutable(
  name: string,
  pathValue: string | undefined,
): string | undefined {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) {
      return canonicalPath(candidate);
    }
  }
  return undefined;
}
