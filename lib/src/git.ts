import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  return stdout.trim();
}

export async function ensureGitInfoExclude(
  cwd: string,
  pattern: string,
): Promise<void> {
  const commonDir = await gitCommonDir(cwd);
  const infoDir = join(commonDir, "info");
  const excludePath = join(infoDir, "exclude");
  if (!existsSync(excludePath)) {
    mkdirSync(infoDir, { recursive: true });
    writeFileSync(excludePath, `${pattern}\n`, "utf-8");
    return;
  }

  const content = readFileSync(excludePath, "utf-8");
  if (content.split("\n").includes(pattern)) {
    return;
  }
  writeFileSync(
    excludePath,
    `${content.endsWith("\n") ? content : `${content}\n`}${pattern}\n`,
    "utf-8",
  );
}
