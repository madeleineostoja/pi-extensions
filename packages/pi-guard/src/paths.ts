import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, normalize, relative, resolve } from "node:path";

const TEMP_ENV_VARS = new Set(["TMPDIR", "TMP", "TEMP", "TEMPDIR"]);
const COMMON_TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp"];

export function toAbsolutePath(inputPath: string, cwd: string): string {
  return normalize(resolve(cwd, inputPath));
}

function addNormalizedPath(paths: Set<string>, inputPath: string): void {
  const abs = normalize(resolve(inputPath));
  if (abs !== "/") {
    paths.add(abs);
  }
  if (existsSync(abs)) {
    try {
      const real = normalize(realpathSync(abs));
      if (real !== "/") {
        paths.add(real);
      }
    } catch {}
  }
}

function getTempRoots(): string[] {
  const roots = new Set<string>();
  addNormalizedPath(roots, tmpdir());
  for (const envName of TEMP_ENV_VARS) {
    const value = process.env[envName];
    if (value) {
      addNormalizedPath(roots, value);
    }
  }
  for (const root of COMMON_TEMP_ROOTS) {
    addNormalizedPath(roots, root);
  }
  return [...roots];
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  return parent === child || isPathInside(parent, child);
}

export function expandKnownTempEnvVars(input: string): string | undefined {
  if (/\$\(/.test(input)) {
    return undefined;
  }

  let ok = true;
  const expanded = input.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      if (!TEMP_ENV_VARS.has(name)) {
        ok = false;
        return "";
      }
      const value = process.env[name];
      if (!value) {
        ok = false;
        return "";
      }
      return value;
    },
  );

  return ok ? expanded : undefined;
}

export function isDisposableTempTarget(
  inputPath: string,
  cwd: string,
  protectedRoots: string[] = [cwd],
): boolean {
  const expanded = expandKnownTempEnvVars(inputPath);
  if (expanded === undefined) {
    return false;
  }
  if (/[;&|`$*?{}]|<\(/.test(expanded)) {
    return false;
  }

  const abs = toAbsolutePath(expanded, cwd);
  const normalizedProtectedRoots = protectedRoots.map((root) =>
    normalize(resolve(root)),
  );
  if (normalizedProtectedRoots.some((root) => isPathInsideOrEqual(root, abs))) {
    return false;
  }

  const tempRoots = getTempRoots();
  if (tempRoots.some((root) => root === abs)) {
    return false;
  }
  return tempRoots.some((root) => isPathInside(root, abs));
}

const UNSAFE_METACHARACTERS = /[;&|`$]|\$\(|\$\{|<\(|\*|\?|\{|\}/;

/**
 * Light-weight shell word extractor.
 * Supports single/double quotes and basic backslash escaping inside quotes.
 * Returns `undefined` when the command contains shell metacharacters that make
 * path extraction unreliable (e.g. `;`, `&&`, `||`, `|`, backticks, `$(`,
 * variables, globs, etc.).
 */
export function extractShellWords(command: string): string[] | undefined {
  if (UNSAFE_METACHARACTERS.test(command)) {
    return undefined;
  }

  const words: string[] = [];
  let i = 0;

  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) {
      i++;
    }
    if (i >= command.length) {
      break;
    }
    if (command[i] === "#") {
      break;
    }

    let word = "";
    let quote: "'" | '"' | null = null;

    while (i < command.length) {
      const ch = command[i];
      if (quote) {
        if (ch === "\\" && quote === '"') {
          i++;
          word += command[i] ?? "";
        } else if (ch === quote) {
          quote = null;
        } else {
          word += ch;
        }
      } else {
        if (/\s/.test(ch)) {
          break;
        }
        if (ch === "'" || ch === '"') {
          quote = ch;
        } else if (ch === "\\") {
          i++;
          word += command[i] ?? "";
        } else {
          word += ch;
        }
      }
      i++;
    }
    words.push(word);
  }

  return words;
}
