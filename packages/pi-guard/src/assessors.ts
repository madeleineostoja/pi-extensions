import { existsSync } from "node:fs";
import { classifyGitRecoverability, hasDirtyWorktree } from "./git";
import { extractShellWords, toAbsolutePath } from "./paths";

export type GuardAction = {
  title: string;
  description: string;
  reason: string;
  allowKey: string;
  preview: string;
  severity: "medium" | "high";
};

function existsAsFile(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function isSessionCreated(
  path: string,
  sessionCreatedPaths: Set<string>,
): boolean {
  if (sessionCreatedPaths.has(path)) return true;
  for (const p of sessionCreatedPaths) {
    if (path === p || path.startsWith(p + "/")) return true;
  }
  return false;
}

function allTargetsSafe(
  targets: string[],
  cwd: string,
  sessionCreatedPaths: Set<string>,
): boolean {
  for (const t of targets) {
    const abs = toAbsolutePath(t, cwd);
    if (isSessionCreated(abs, sessionCreatedPaths)) continue;
    const rec = classifyGitRecoverability(cwd, abs);
    if (rec !== "tracked-clean") return false;
  }
  return true;
}

function targetExistsAndNotSafe(
  target: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): boolean {
  const abs = toAbsolutePath(target, cwd);
  if (!existsAsFile(abs)) return false;
  if (isSessionCreated(abs, sessionCreatedPaths)) return false;
  const rec = classifyGitRecoverability(cwd, abs);
  return rec !== "tracked-clean";
}

function makeAction(
  preview: string,
  allowKey: string,
  description: string,
): GuardAction {
  return {
    title: "Guard: confirm risky command?",
    description,
    reason: `Risky shell command detected: ${description}`,
    allowKey,
    preview,
    severity: "high",
  };
}

// ── File removal ──

const RM_LIKE = new Set(["rm", "rmdir", "unlink", "shred"]);

function assessRemoval(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words) {
    if (/\b(rm|rmdir|unlink|shred)\b/.test(command)) {
      return makeAction(
        command,
        "bash:rm-risky",
        "File removal with unparseable arguments",
      );
    }
    return undefined;
  }

  const cmd = words[0];
  if (!RM_LIKE.has(cmd)) return undefined;

  const targets: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) continue;
    if (w === "." || w === ".." || w === "/") {
      return makeAction(
        command,
        "bash:rm-risky",
        `Broad deletion target: ${w}`,
      );
    }
    targets.push(w);
  }

  if (targets.length === 0) return undefined;

  if (allTargetsSafe(targets, cwd, sessionCreatedPaths)) return undefined;

  return makeAction(
    command,
    "bash:rm-risky",
    `File removal: ${targets.join(" ")}`,
  );
}

// ── find -delete / -exec rm ──

function assessFindDelete(command: string): GuardAction | undefined {
  if (/\bfind\b/.test(command)) {
    if (command.includes(" -delete")) {
      return makeAction(command, "bash:find-delete", "find with -delete");
    }
    const execRe = /-exec\s+(rm|rmdir|unlink|shred)\b/;
    if (execRe.test(command)) {
      const m = command.match(execRe);
      return makeAction(
        command,
        "bash:find-delete",
        `find with -exec ${m?.[1] ?? "rm"}`,
      );
    }
  }

  const words = extractShellWords(command);
  if (!words || words[0] !== "find") return undefined;

  const joined = words.join(" ");
  if (joined.includes(" -delete")) {
    return makeAction(command, "bash:find-delete", "find with -delete");
  }

  const execIdx = words.indexOf("-exec");
  if (execIdx !== -1) {
    const execCmd = words[execIdx + 1];
    if (RM_LIKE.has(execCmd)) {
      return makeAction(
        command,
        "bash:find-delete",
        `find with -exec ${execCmd}`,
      );
    }
  }

  return undefined;
}

// ── Git local-loss ──

function assessGit(command: string, cwd: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (words && words[0] === "git") {
    let i = 1;
    let gitCwd = cwd;
    while (i < words.length) {
      const w = words[i];
      if (w === "--") {
        i++;
        break;
      }
      if (!w.startsWith("-")) break;
      if (w === "-C") {
        gitCwd = toAbsolutePath(words[i + 1] ?? ".", cwd);
        i += 2;
      } else if (
        ["-c", "--git-dir", "--work-tree", "--config-env"].includes(w)
      ) {
        i += 2;
      } else {
        i++;
      }
    }
    const sub = words[i];
    const rest = words.slice(i + 1);

    if (sub === "clean") {
      const flags = rest.join(" ");
      if (
        /-[dfx]/.test(flags) ||
        /--force/.test(flags) ||
        /--delete/.test(flags)
      ) {
        return makeAction(
          command,
          "bash:git-clean",
          "git clean (removes untracked files)",
        );
      }
    }

    if (sub === "reset") {
      if (rest.includes("--hard")) {
        if (hasDirtyWorktree(gitCwd)) {
          return makeAction(
            command,
            "bash:git-reset-hard",
            "git reset --hard with dirty worktree",
          );
        }
        return undefined;
      }
    }

    if (sub === "checkout") {
      const dashIdx = rest.indexOf("--");
      if (dashIdx !== -1) {
        const targetSet = new Set(rest.slice(dashIdx + 1));
        if (targetSet.has(".") || targetSet.has("*")) {
          if (hasDirtyWorktree(gitCwd)) {
            return makeAction(
              command,
              "bash:git-discard",
              "git checkout -- . with dirty worktree",
            );
          }
        }
      }
    }

    if (sub === "restore") {
      const targetSet = new Set(rest.filter((w) => !w.startsWith("-")));
      if (targetSet.has(".") || targetSet.has("*")) {
        if (hasDirtyWorktree(gitCwd)) {
          return makeAction(
            command,
            "bash:git-discard",
            "git restore . with dirty worktree",
          );
        }
      }
    }

    if (sub === "stash") {
      const stashSub = rest[0];
      if (stashSub === "drop" || stashSub === "clear") {
        return makeAction(
          command,
          "bash:git-stash-delete",
          `git stash ${stashSub}`,
        );
      }
    }

    if (sub === "branch") {
      const flagSet = new Set(rest);
      if (flagSet.has("-D") || flagSet.has("-d")) {
        return makeAction(command, "bash:git-ref-delete", "git branch delete");
      }
    }

    if (sub === "tag") {
      if (rest.includes("-d")) {
        return makeAction(command, "bash:git-ref-delete", "git tag delete");
      }
    }

    if (sub === "push") {
      const flags = rest.join(" ");
      if (
        /\s-f\b/.test(flags) ||
        /--force\b/.test(flags) ||
        /--force-with-lease\b/.test(flags) ||
        rest.some((w) => w.startsWith("+"))
      ) {
        return makeAction(command, "bash:git-force-push", "git force push");
      }
    }

    return undefined;
  }

  if (!words && /\bgit\s/.test(command)) {
    return assessGitUnparseable(command, cwd);
  }

  return undefined;
}

function assessGitUnparseable(
  command: string,
  _cwd: string,
): GuardAction | undefined {
  const gitRe =
    /(?:^|\s)git(?:\s+(?:-[Cc]\s+\S+|--git-dir\s+\S+|--work-tree\s+\S+))*\s+(\S+)/;
  const m = command.match(gitRe);
  if (!m) return undefined;
  const sub = m[1];

  if (sub === "clean") {
    const after = command.slice(command.indexOf("clean") + 5);
    if (
      /-[dfx]/.test(after) ||
      /--force/.test(after) ||
      /--delete/.test(after)
    ) {
      return makeAction(
        command,
        "bash:git-clean",
        "git clean (removes untracked files)",
      );
    }
  }

  if (sub === "reset" && /--hard/.test(command)) {
    return makeAction(command, "bash:git-reset-hard", "git reset --hard");
  }

  if (
    (sub === "checkout" && /\bcheckout\s+--\s*[.*]/.test(command)) ||
    (sub === "restore" && /\brestore\s+[.*]/.test(command))
  ) {
    return makeAction(command, "bash:git-discard", `git ${sub} .`);
  }

  if (sub === "stash" && /\bstash\s+(?:drop|clear)\b/.test(command)) {
    const which = /\bclear\b/.test(command) ? "clear" : "drop";
    return makeAction(command, "bash:git-stash-delete", `git stash ${which}`);
  }

  if (sub === "branch" && /\bbranch\s+(?:-[Dd])\b/.test(command)) {
    return makeAction(command, "bash:git-ref-delete", "git branch delete");
  }

  if (sub === "tag" && /\btag\s+(?:-[Dd])\b/.test(command)) {
    return makeAction(command, "bash:git-ref-delete", "git tag delete");
  }

  if (
    sub === "push" &&
    /\bpush\s+(?:-[f]|--force|--force-with-lease|\+\S)/.test(command)
  ) {
    return makeAction(command, "bash:git-force-push", "git force push");
  }

  return undefined;
}

// ── Shell overwrite / truncate ──

function assessRedirect(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const redirectRe =
    /(?:^|[;|&]|\s\|\||\s&&|\s)\s*(?:\d*)>(?!>)\s*(['"]?)([^'"\s;|&]+)\1/;
  const match = command.match(redirectRe);
  if (!match) return undefined;

  const target = match[2];
  if (targetExistsAndNotSafe(target, cwd, sessionCreatedPaths)) {
    return makeAction(
      command,
      "bash:redirect-overwrite",
      `Truncating redirect to existing file: ${target}`,
    );
  }
  return undefined;
}

function assessColonRedirect(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const re = /(?:^|\s)(?::|true)\s*>(?!>)\s*(["']?)([^"'\s;|&]+)\1/;
  const match = command.match(re);
  if (!match) return undefined;

  const target = match[2];
  if (targetExistsAndNotSafe(target, cwd, sessionCreatedPaths)) {
    return makeAction(
      command,
      "bash:redirect-overwrite",
      `Truncating redirect to existing file: ${target}`,
    );
  }
  return undefined;
}

function assessTruncate(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "truncate") return undefined;

  let isZeroSize = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-s" || w === "--size") {
      const val = words[i + 1];
      if (val && val.startsWith("0")) isZeroSize = true;
      i++;
    } else if (w.startsWith("-s0") || w.startsWith("--size=0")) {
      isZeroSize = true;
    }
  }
  if (!isZeroSize) return undefined;

  const targets: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      if (w === "-s" || w === "--size") i++;
      continue;
    }
    targets.push(w);
  }
  if (targets.length === 0) return undefined;

  const risky = targets.filter((t) =>
    targetExistsAndNotSafe(t, cwd, sessionCreatedPaths),
  );
  if (risky.length > 0) {
    return makeAction(
      command,
      "bash:truncate-zero",
      `truncate -s 0 on existing file(s): ${risky.join(" ")}`,
    );
  }
  return undefined;
}

function assessDd(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "dd") return undefined;

  const ofArg = words.find((w) => w.startsWith("of="));
  if (!ofArg) return undefined;
  const target = ofArg.slice(3);

  if (targetExistsAndNotSafe(target, cwd, sessionCreatedPaths)) {
    return makeAction(
      command,
      "bash:dd-output",
      `dd overwrite of existing file: ${target}`,
    );
  }
  return undefined;
}

function assessSedInPlace(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "sed") return undefined;

  const hasInPlace = words.some((w) => w === "-i" || w.startsWith("-i"));
  if (!hasInPlace) return undefined;

  const targets = words.filter(
    (w, i) => i > 0 && !w.startsWith("-") && !w.startsWith("'"),
  );
  if (targets.length === 0) return undefined;

  const risky = targets.filter((t) =>
    targetExistsAndNotSafe(t, cwd, sessionCreatedPaths),
  );
  if (risky.length > 0) {
    return makeAction(
      command,
      "bash:sed-in-place",
      `sed -i on existing file(s): ${risky.join(" ")}`,
    );
  }
  return undefined;
}

function assessPerlInPlace(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "perl") return undefined;

  const hasInPlace = words.some(
    (w) => w === "-pi" || w === "-p" || w.startsWith("-pi"),
  );
  if (!hasInPlace) return undefined;

  const targets = words.filter((w, i) => i > 0 && !w.startsWith("-"));
  if (targets.length === 0) return undefined;

  const risky = targets.filter((t) =>
    targetExistsAndNotSafe(t, cwd, sessionCreatedPaths),
  );
  if (risky.length > 0) {
    return makeAction(
      command,
      "bash:perl-in-place",
      `perl -pi on existing file(s): ${risky.join(" ")}`,
    );
  }
  return undefined;
}

function assessMvCp(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words) return undefined;
  const cmd = words[0];
  if (cmd !== "mv" && cmd !== "cp") return undefined;

  const targets = words.filter((w, i) => i > 0 && !w.startsWith("-"));
  if (targets.length < 2) return undefined;
  const dest = targets[targets.length - 1];

  if (targetExistsAndNotSafe(dest, cwd, sessionCreatedPaths)) {
    return makeAction(
      command,
      cmd === "mv" ? "bash:mv-overwrite" : "bash:cp-overwrite",
      `${cmd} overwrite of existing file: ${dest}`,
    );
  }
  return undefined;
}

function assessInstall(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "install") return undefined;

  const targets = words.filter((w, i) => i > 0 && !w.startsWith("-"));
  if (targets.length < 2) return undefined;
  const dest = targets[targets.length - 1];

  if (targetExistsAndNotSafe(dest, cwd, sessionCreatedPaths)) {
    return makeAction(
      command,
      "bash:install-overwrite",
      `install overwrite of existing file: ${dest}`,
    );
  }
  return undefined;
}

// ── Permissions damage ──

function assessPermissions(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words) return undefined;
  const cmd = words[0];
  if (cmd !== "chmod" && cmd !== "chown") return undefined;

  if (cmd === "chmod") {
    const flags = words.slice(1).filter((w) => w.startsWith("-"));
    const args = words.slice(1).filter((w) => !w.startsWith("-"));
    const hasRecursive = flags.some((f) => f.includes("R"));
    const has777 = args.includes("777");
    if (hasRecursive || has777) {
      return makeAction(
        command,
        "bash:permissions-risky",
        `chmod ${hasRecursive ? "-R " : ""}${has777 ? "777" : ""}`,
      );
    }
  }

  if (cmd === "chown") {
    const flags = words.slice(1).filter((w) => w.startsWith("-"));
    const hasRecursive = flags.some((f) => f.includes("R"));
    if (hasRecursive) {
      return makeAction(command, "bash:permissions-risky", "chown -R");
    }
  }

  return undefined;
}

// ── rsync --delete ──

function assessRsync(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "rsync") return undefined;

  const flags = words.slice(1);
  const hasDelete = flags.some(
    (f) =>
      f === "--delete" ||
      f.startsWith("--delete") ||
      f === "--delete-excluded" ||
      f.startsWith("--delete-excluded"),
  );
  if (hasDelete) {
    const dest = flags.filter((f) => !f.startsWith("-")).at(-1);
    return makeAction(
      command,
      "bash:rsync-delete",
      `rsync --delete${dest ? ` to ${dest}` : ""}`,
    );
  }
  return undefined;
}

// ── Inline interpreter escape hatches ──

const PYTHON_DELETE_RE =
  /\b(os\.remove\(|os\.unlink\(|os\.rmdir\(|shutil\.rmtree\(|\.unlink\(|\.rmdir\(|open\([^)]*,\s*['"]w['"]\)|\.write_text\()/;
const PYTHON_LOOP_RE = /\b(glob|rglob|os\.walk|for\s+\w+\s+in)\b/;

const NODE_DELETE_RE =
  /\b(fs\.rm\(|fs\.rmSync\(|fs\.unlink\(|fs\.unlinkSync\(|fs\.rmdir\(|fs\.rmdirSync\(|fs\.writeFileSync\()|(\.rm\(|\.rmSync\(|\.unlink\(|\.unlinkSync\(|\.rmdir\(|\.rmdirSync\(|\.writeFileSync\()/;
const NODE_LOOP_RE = /\b(glob|readdir|for\s*\(|for\s+\w+\s+of)\b/;

const RUBY_DELETE_RE =
  /\b(File\.delete\(|FileUtils\.rm\(|FileUtils\.rm_rf\(|File\.write\()/;
const PERL_DELETE_RE = /\b(unlink\s|rmdir\s|remove_tree\()/;

function assessInterpreter(command: string): GuardAction | undefined {
  const m = command.match(
    /^(python3?|node|ruby|perl)\s+(?:-[ec]\s+(['"])|<<\s*['"]?\w+['"]?)/,
  );
  if (!m) return undefined;

  const interpreter = m[1];
  const body = command;

  if (interpreter.startsWith("python")) {
    const hasDelete = PYTHON_DELETE_RE.test(body);
    const hasLoop = PYTHON_LOOP_RE.test(body);
    if (hasDelete && hasLoop) {
      return makeAction(
        command,
        "bash:inline-interpreter-delete",
        "Python inline script with filesystem deletion in a loop",
      );
    }
    if (hasDelete) {
      return makeAction(
        command,
        "bash:inline-interpreter-delete",
        "Python inline script with filesystem deletion",
      );
    }
  }

  if (interpreter === "node") {
    const hasDelete = NODE_DELETE_RE.test(body);
    const hasLoop = NODE_LOOP_RE.test(body);
    if (hasDelete && hasLoop) {
      return makeAction(
        command,
        "bash:inline-interpreter-delete",
        "Node inline script with filesystem deletion in a loop",
      );
    }
    if (hasDelete) {
      return makeAction(
        command,
        "bash:inline-interpreter-delete",
        "Node inline script with filesystem deletion",
      );
    }
  }

  if (interpreter === "ruby") {
    if (RUBY_DELETE_RE.test(body)) {
      return makeAction(
        command,
        "bash:inline-interpreter-delete",
        "Ruby inline script with filesystem deletion",
      );
    }
  }

  if (interpreter === "perl") {
    if (PERL_DELETE_RE.test(body)) {
      return makeAction(
        command,
        "bash:inline-interpreter-delete",
        "Perl inline script with filesystem deletion",
      );
    }
  }

  return undefined;
}

// ── Main entrypoint ──

export function assessBashCommand(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  return (
    assessFindDelete(trimmed) ??
    assessGit(trimmed, cwd) ??
    assessRemoval(trimmed, cwd, sessionCreatedPaths) ??
    assessColonRedirect(trimmed, cwd, sessionCreatedPaths) ??
    assessRedirect(trimmed, cwd, sessionCreatedPaths) ??
    assessTruncate(trimmed, cwd, sessionCreatedPaths) ??
    assessDd(trimmed, cwd, sessionCreatedPaths) ??
    assessSedInPlace(trimmed, cwd, sessionCreatedPaths) ??
    assessPerlInPlace(trimmed, cwd, sessionCreatedPaths) ??
    assessMvCp(trimmed, cwd, sessionCreatedPaths) ??
    assessInstall(trimmed, cwd, sessionCreatedPaths) ??
    assessPermissions(trimmed) ??
    assessRsync(trimmed) ??
    assessInterpreter(trimmed) ??
    undefined
  );
}
