import { existsSync } from "node:fs";

const SAFE_PSEUDO_DEVICES = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/urandom",
  "/dev/random",
]);
import {
  classifyGitRecoverability,
  gitWorktreeRoot,
  hasDirtyWorktree,
} from "./git";
import {
  expandKnownTempEnvVars,
  extractShellWords,
  isDisposableTempTarget,
  toAbsolutePath,
} from "./paths";

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
  if (sessionCreatedPaths.has(path)) {
    return true;
  }
  for (const p of sessionCreatedPaths) {
    if (path === p || path.startsWith(p + "/")) {
      return true;
    }
  }
  return false;
}

function protectedRootsFor(cwd: string): string[] {
  const root = gitWorktreeRoot(cwd);
  return root ? [cwd, root] : [cwd];
}

function isSafeDisposableTempTarget(target: string, cwd: string): boolean {
  return isDisposableTempTarget(target, cwd, protectedRootsFor(cwd));
}

function extractShellWordsWithTempEnv(command: string): string[] | undefined {
  const expanded = expandKnownTempEnvVars(command);
  if (expanded === undefined) {
    return undefined;
  }
  return extractShellWords(expanded);
}

function allTargetsSafe(
  targets: string[],
  cwd: string,
  sessionCreatedPaths: Set<string>,
): boolean {
  for (const t of targets) {
    const abs = toAbsolutePath(t, cwd);
    if (isSessionCreated(abs, sessionCreatedPaths)) {
      continue;
    }
    if (isSafeDisposableTempTarget(t, cwd)) {
      continue;
    }
    const rec = classifyGitRecoverability(cwd, abs);
    if (rec !== "tracked-clean") {
      return false;
    }
  }
  return true;
}

function targetExistsAndNotSafe(
  target: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): boolean {
  const abs = toAbsolutePath(target, cwd);
  if (SAFE_PSEUDO_DEVICES.has(abs)) {
    return false;
  }
  if (!existsAsFile(abs)) {
    return false;
  }
  if (isSessionCreated(abs, sessionCreatedPaths)) {
    return false;
  }
  if (isSafeDisposableTempTarget(target, cwd)) {
    return false;
  }
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

function withPreview(
  action: GuardAction | undefined,
  preview: string,
): GuardAction | undefined {
  return action ? { ...action, preview } : undefined;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let i = 0;
  let quote: "'" | '"' | null = null;

  while (i < command.length) {
    const ch = command[i];
    if (!quote && ch === "\\") {
      i += 2;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }

    if (ch === ";" || ch === "|") {
      const segment = command.slice(start, i).trim();
      if (segment) {
        segments.push(segment);
      }
      i += command[i + 1] === ch ? 2 : 1;
      start = i;
      continue;
    }

    if (ch === "\n") {
      const segment = command.slice(start, i).trim();
      if (segment) {
        segments.push(segment);
      }
      i++;
      start = i;
      continue;
    }

    if (ch === "&" && command[i + 1] === "&") {
      const segment = command.slice(start, i).trim();
      if (segment) {
        segments.push(segment);
      }
      i += 2;
      start = i;
      continue;
    }

    if (ch === "&") {
      // Skip bash redirection operators &> and >& — these contain &
      // but are not job separators.
      if (command[i + 1] === ">" || command[i - 1] === ">") {
        i++;
        continue;
      }
      const segment = command.slice(start, i).trim();
      if (segment) {
        segments.push(segment);
      }
      i++;
      start = i;
      continue;
    }

    i++;
  }

  const tail = command.slice(start).trim();
  if (tail) {
    segments.push(tail);
  }
  return segments;
}

function isShellAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function shellQuote(word: string): string {
  if (word !== "" && !/\s/.test(word)) {
    return word;
  }
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function stripCommandWrappers(words: string[]): string[] {
  let i = 0;

  while (i < words.length) {
    while (isShellAssignment(words[i] ?? "")) {
      i++;
    }

    const cmd = words[i];
    if (!cmd) {
      return [];
    }

    if (cmd === "sudo" || cmd === "doas") {
      i++;
      while (i < words.length && words[i].startsWith("-")) {
        const flag = words[i];
        i++;
        if (["-u", "-g", "-h", "-p", "-C", "-T"].includes(flag)) {
          i++;
        }
        if (flag === "--") {
          break;
        }
      }
      continue;
    }

    if (cmd === "env") {
      i++;
      while (i < words.length) {
        const w = words[i];
        if (isShellAssignment(w)) {
          i++;
          continue;
        }
        if (w === "-i" || w === "--ignore-environment") {
          i++;
          continue;
        }
        if (w === "-u" || w === "--unset") {
          i += 2;
          continue;
        }
        if (w.startsWith("-u")) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }

    if (["command", "builtin", "noglob", "exec"].includes(cmd)) {
      i++;
      continue;
    }

    if (cmd === "time") {
      i++;
      while (i < words.length && words[i].startsWith("-")) {
        i++;
      }
      continue;
    }

    break;
  }

  return words.slice(i);
}

function normalizedCommand(command: string): string | undefined {
  const words = extractShellWords(command);
  if (!words) {
    return undefined;
  }
  const stripped = stripCommandWrappers(words);
  if (stripped.length === 0 || stripped.length === words.length) {
    return undefined;
  }
  return stripped.map(shellQuote).join(" ");
}

function commandCandidates(command: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    const trimmed = candidate?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      candidates.push(trimmed);
    }
  };

  add(command);
  add(normalizedCommand(command));
  for (const segment of splitShellSegments(command)) {
    add(segment);
    add(normalizedCommand(segment));
  }

  return candidates;
}

// ── File removal ──

const RM_LIKE = new Set(["rm", "rmdir", "unlink", "shred"]);

function extractRemovalWords(command: string): string[] | undefined {
  return extractShellWords(command) ?? extractShellWordsWithTempEnv(command);
}

function mktempAssignedVars(command: string): string[] {
  const vars = new Set<string>();
  const re =
    /(?:^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*)=(?:"\$\(\s*mktemp\b[^)]*\)"|\$\(\s*mktemp\b[^)]*\)|`\s*mktemp\b[^`]*`)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    vars.add(match[1]);
  }
  return [...vars];
}

function regexEscape(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mktempSafeRemovalPattern(vars: string[]): RegExp {
  const refs = vars
    .flatMap((name) => {
      const escaped = regexEscape(name);
      return [
        `"\\$${escaped}"`,
        `'\\$${escaped}'`,
        `\\$${escaped}`,
        `"\\$\\{${escaped}\\}"`,
        `'\\$\\{${escaped}\\}'`,
        `\\$\\{${escaped}\\}`,
      ];
    })
    .join("|");
  return new RegExp(
    `\\b(?:rm|rmdir|unlink|shred)\\b(?:\\s+(?:--|-[A-Za-z0-9-]+))*\\s+(?:${refs})(?:\\s+(?:${refs}))*` +
      `(?=\\s*(?:[;&|]|$|['"]))`,
    "g",
  );
}

function stripMktempCleanups(command: string): string {
  const vars = mktempAssignedVars(command);
  if (vars.length === 0) {
    return command;
  }
  return command.replace(mktempSafeRemovalPattern(vars), "");
}

function isSafeMktempCleanup(command: string): boolean {
  const vars = mktempAssignedVars(command);
  if (vars.length === 0) {
    return false;
  }
  const remaining = command.replace(mktempSafeRemovalPattern(vars), "");
  return !/\b(rm|rmdir|unlink|shred)\b/.test(remaining);
}

function assessRemoval(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  if (
    /^\s*find\b/.test(command) &&
    (/\s-delete(?:\s|[;&|]|$)/.test(command) ||
      /-exec\s+(rm|rmdir|unlink|shred)\b/.test(command))
  ) {
    return undefined;
  }
  const words = extractRemovalWords(command);
  if (!words) {
    // Only fire when the segment itself starts with an rm-like command
    // (allowing leading `VAR=value` assignments). A blanket `/\brm\b/` test
    // produces false positives because `rm` also appears as a subcommand of
    // other tools (e.g. `docker volume rm`); those tools have their own
    // assessors which run at the segment level.
    const startsWithRm =
      /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:rm|rmdir|unlink|shred)\b/.test(
        command,
      );
    if (startsWithRm) {
      if (isSafeMktempCleanup(command)) {
        return undefined;
      }
      return makeAction(
        command,
        "bash:rm-risky",
        "File removal with unparseable arguments",
      );
    }
    return undefined;
  }

  const cmd = words[0];
  if (!RM_LIKE.has(cmd)) {
    return undefined;
  }

  const targets: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      continue;
    }
    if (w === "." || w === ".." || w === "/") {
      return makeAction(
        command,
        "bash:rm-risky",
        `Broad deletion target: ${w}`,
      );
    }
    targets.push(w);
  }

  if (targets.length === 0) {
    return undefined;
  }

  if (allTargetsSafe(targets, cwd, sessionCreatedPaths)) {
    return undefined;
  }

  return makeAction(
    command,
    "bash:rm-risky",
    `File removal: ${targets.join(" ")}`,
  );
}

// ── find -delete / -exec rm ──

function extractFindRoots(words: string[]): string[] | undefined {
  if (words[0] !== "find") {
    return undefined;
  }

  let i = 1;
  while (i < words.length) {
    const word = words[i];
    if (["-H", "-L", "-P"].includes(word) || /^-O\d*$/.test(word)) {
      i++;
      continue;
    }
    if (word === "-D") {
      i += 2;
      continue;
    }
    break;
  }

  const roots: string[] = [];
  while (i < words.length) {
    const word = words[i];
    if (word.startsWith("-") || word === "!" || word === "(" || word === ")") {
      break;
    }
    roots.push(word);
    i++;
  }

  return roots.length > 0 ? roots : ["."];
}

function extractFindRootsFromCommand(command: string): string[] | undefined {
  const expanded = expandKnownTempEnvVars(command);
  if (expanded === undefined) {
    return undefined;
  }
  const match = expanded.match(
    /^\s*find\s+(.+?)(?=\s+(?:-[A-Za-z]|!|\(|\))|$)/,
  );
  if (!match) {
    return ["."];
  }
  const rootWords = extractShellWords(`find ${match[1]}`);
  if (!rootWords) {
    return undefined;
  }
  return rootWords.slice(1).length > 0 ? rootWords.slice(1) : ["."];
}

function hasUnescapedControlOperator(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      return true;
    }
  }
  return false;
}

function assessFindDelete(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const deleteMatch = /\s-delete(?:\s|[;&|]|$)/.test(command);
  const execMatch = command.match(/-exec\s+(rm|rmdir|unlink|shred)\b/);
  if (!/^\s*find\b/.test(command) || (!deleteMatch && !execMatch)) {
    return undefined;
  }

  const words =
    extractShellWords(command) ?? extractShellWordsWithTempEnv(command);
  const roots = words
    ? extractFindRoots(words)
    : extractFindRootsFromCommand(command);
  if (
    roots &&
    allTargetsSafe(roots, cwd, sessionCreatedPaths) &&
    !hasUnescapedControlOperator(command)
  ) {
    return undefined;
  }

  if (deleteMatch) {
    return makeAction(command, "bash:find-delete", "find with -delete");
  }
  return makeAction(
    command,
    "bash:find-delete",
    `find with -exec ${execMatch?.[1] ?? "rm"}`,
  );
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
      if (!w.startsWith("-")) {
        break;
      }
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

    if (sub === "checkout" || sub === "switch") {
      if (rest.some((w) => w === "-f" || w === "--force")) {
        if (hasDirtyWorktree(gitCwd)) {
          return makeAction(
            command,
            "bash:git-discard",
            `git ${sub} --force with dirty worktree`,
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
        rest.some((w) => w.startsWith("+")) ||
        rest.includes("--mirror")
      ) {
        return makeAction(command, "bash:git-force-push", "git force push");
      }
      if (
        rest.includes("--delete") ||
        rest.includes("--prune") ||
        rest.some((w) => /^:[^\s]+/.test(w))
      ) {
        return makeAction(
          command,
          "bash:git-remote-delete",
          "git remote ref deletion",
        );
      }
    }

    if (sub === "worktree" && rest[0] === "remove") {
      if (rest.some((w) => w === "-f" || w === "--force")) {
        return makeAction(
          command,
          "bash:git-worktree-remove",
          "git worktree remove --force",
        );
      }
    }

    if (sub === "update-ref" && rest.includes("-d")) {
      return makeAction(command, "bash:git-ref-delete", "git update-ref -d");
    }

    if (sub === "reflog" && rest[0] === "expire") {
      if (rest.includes("--expire=now") && rest.includes("--all")) {
        return makeAction(
          command,
          "bash:git-reflog-expire",
          "git reflog expire --expire=now --all",
        );
      }
    }

    if (sub === "gc" && rest.includes("--prune=now")) {
      return makeAction(command, "bash:git-gc-prune", "git gc --prune=now");
    }

    if (sub === "lfs" && rest[0] === "prune") {
      return makeAction(command, "bash:git-lfs-prune", "git lfs prune");
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
  if (!m) {
    return undefined;
  }
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
    /\bpush\s+(?:-[f]|--force|--force-with-lease|--mirror|\+\S)/.test(command)
  ) {
    return makeAction(command, "bash:git-force-push", "git force push");
  }

  if (sub === "push" && /\bpush\b.*(?:--delete|--prune|\s:\S+)/.test(command)) {
    return makeAction(
      command,
      "bash:git-remote-delete",
      "git remote ref deletion",
    );
  }

  if (sub === "checkout" && /\bcheckout\b.*(?:\s-f\b|--force)/.test(command)) {
    return makeAction(command, "bash:git-discard", "git checkout --force");
  }

  if (sub === "switch" && /\bswitch\b.*(?:\s-f\b|--force)/.test(command)) {
    return makeAction(command, "bash:git-discard", "git switch --force");
  }

  if (
    sub === "worktree" &&
    /\bworktree\s+remove\b.*(?:\s-f\b|--force)/.test(command)
  ) {
    return makeAction(
      command,
      "bash:git-worktree-remove",
      "git worktree remove --force",
    );
  }

  if (sub === "update-ref" && /\bupdate-ref\b.*\s-d\b/.test(command)) {
    return makeAction(command, "bash:git-ref-delete", "git update-ref -d");
  }

  if (
    sub === "reflog" &&
    /\breflog\s+expire\b.*--expire=now\b.*--all\b/.test(command)
  ) {
    return makeAction(
      command,
      "bash:git-reflog-expire",
      "git reflog expire --expire=now --all",
    );
  }

  if (sub === "gc" && /\bgc\b.*--prune=now\b/.test(command)) {
    return makeAction(command, "bash:git-gc-prune", "git gc --prune=now");
  }

  if (sub === "lfs" && /\blfs\s+prune\b/.test(command)) {
    return makeAction(command, "bash:git-lfs-prune", "git lfs prune");
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
  if (!match) {
    return undefined;
  }

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
  if (!match) {
    return undefined;
  }

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
  if (!words || words[0] !== "truncate") {
    return undefined;
  }

  let isZeroSize = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-s" || w === "--size") {
      const val = words[i + 1];
      if (val && val.startsWith("0")) {
        isZeroSize = true;
      }
      i++;
    } else if (w.startsWith("-s0") || w.startsWith("--size=0")) {
      isZeroSize = true;
    }
  }
  if (!isZeroSize) {
    return undefined;
  }

  const targets: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      if (w === "-s" || w === "--size") {
        i++;
      }
      continue;
    }
    targets.push(w);
  }
  if (targets.length === 0) {
    return undefined;
  }

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
  if (!words || words[0] !== "dd") {
    return undefined;
  }

  const ofArg = words.find((w) => w.startsWith("of="));
  if (!ofArg) {
    return undefined;
  }
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
  if (!words || words[0] !== "sed") {
    return undefined;
  }

  const hasInPlace = words.some((w) => w === "-i" || w.startsWith("-i"));
  if (!hasInPlace) {
    return undefined;
  }

  const targets = words.filter(
    (w, i) => i > 0 && !w.startsWith("-") && !w.startsWith("'"),
  );
  if (targets.length === 0) {
    return undefined;
  }

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
  if (!words || words[0] !== "perl") {
    return undefined;
  }

  const hasInPlace = words.some(
    (w) => w === "-pi" || w === "-p" || w.startsWith("-pi"),
  );
  if (!hasInPlace) {
    return undefined;
  }

  const targets = words.filter((w, i) => i > 0 && !w.startsWith("-"));
  if (targets.length === 0) {
    return undefined;
  }

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
  if (!words) {
    return undefined;
  }
  const cmd = words[0];
  if (cmd !== "mv" && cmd !== "cp") {
    return undefined;
  }

  const targets = words.filter((w, i) => i > 0 && !w.startsWith("-"));
  if (targets.length < 2) {
    return undefined;
  }
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
  if (!words || words[0] !== "install") {
    return undefined;
  }

  const targets = words.filter((w, i) => i > 0 && !w.startsWith("-"));
  if (targets.length < 2) {
    return undefined;
  }
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
  if (!words) {
    return undefined;
  }
  const cmd = words[0];
  if (cmd !== "chmod" && cmd !== "chown") {
    return undefined;
  }

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
  if (!words || words[0] !== "rsync") {
    return undefined;
  }

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
  if (!m) {
    return undefined;
  }

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

// ── Remote scripts, wrappers, and CLI mutations ──

const REMOTE_FETCHER_RE = "(?:curl|wget)";
const REMOTE_INTERPRETER_RE = "(?:sh|bash|zsh|python3?|ruby|perl|node)";
const WRAPPER_RE = "(?:(?:sudo|doas|env|command)\\s+(?:\\S+\\s+)*)?";
const REMOTE_SCRIPT_PATTERNS = [
  new RegExp(
    `\\b${WRAPPER_RE}${REMOTE_FETCHER_RE}\\b[^|;]*\\|\\s*${WRAPPER_RE}${REMOTE_INTERPRETER_RE}\\b`,
  ),
  new RegExp(
    `(?:^|\\s)(?:source|\\.|${REMOTE_INTERPRETER_RE})\\s+<\\(\\s*${WRAPPER_RE}${REMOTE_FETCHER_RE}\\b`,
  ),
  new RegExp(
    `\\b(?:eval|${REMOTE_INTERPRETER_RE}\\s+-c)\\s+['"]?\\$\\(\\s*${WRAPPER_RE}${REMOTE_FETCHER_RE}\\b`,
  ),
];

function assessRemoteScriptExecution(command: string): GuardAction | undefined {
  if (REMOTE_SCRIPT_PATTERNS.some((pattern) => pattern.test(command))) {
    return makeAction(
      command,
      "bash:remote-script-exec",
      "remote HTTP response executed by shell/interpreter",
    );
  }
  return undefined;
}

function destructiveShellSnippet(command: string): string | undefined {
  if (/\b(?:rm|rmdir|unlink|shred)\b/.test(command)) {
    return "file deletion";
  }
  if (
    /\bgit\s+(?:clean|reset\s+--hard|checkout\b.*(?:\s-f\b|--force)|switch\b.*(?:\s-f\b|--force))\b/.test(
      command,
    )
  ) {
    return "git data-loss command";
  }
  if (
    /\b(?:docker|podman)\s+.*(?:prune|volume\s+(?:rm|remove)|compose\s+down\b.*(?:-v|--volumes))\b/.test(
      command,
    )
  ) {
    return "container data-loss command";
  }
  if (
    /\baws\s+\S+\s+(?:delete-|terminate-|remove-|deregister-|detach-|disable-|revoke-|s3\s+(?:rm|rb|sync\b.*--delete))/.test(
      command,
    )
  ) {
    return "AWS destructive command";
  }
  return undefined;
}

function assessShellExecDestructive(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (words && ["sh", "bash", "zsh"].includes(words[0] ?? "")) {
    const cIndex = words.findIndex((w) => w === "-c");
    const script = cIndex === -1 ? undefined : words[cIndex + 1];
    const description = script ? destructiveShellSnippet(script) : undefined;
    if (description) {
      return makeAction(
        command,
        "bash:shell-c-destructive",
        `${words[0]} -c ${description}`,
      );
    }
  }

  const findShellExec =
    /\bfind\b.*(?:^|\s)-exec\s+(?:sh|bash|zsh)\s+-c\s+(['"])(.*?)\1/s.exec(
      command,
    );
  const description = findShellExec
    ? destructiveShellSnippet(findShellExec[2] ?? "")
    : undefined;
  if (description) {
    return makeAction(
      command,
      "bash:find-delete",
      `find -exec shell ${description}`,
    );
  }
  return undefined;
}

function assessXargsDestructive(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "xargs") {
    if (/\bxargs\b.*\b(?:rm|rmdir|unlink|shred)\b/.test(command)) {
      return makeAction(
        command,
        "bash:xargs-delete",
        "xargs invoking file deletion",
      );
    }
    return undefined;
  }

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (["-I", "-L", "-n", "-P", "-s", "-E"].includes(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-")) {
      continue;
    }
    if (["rm", "rmdir", "unlink", "shred"].includes(w)) {
      return makeAction(command, "bash:xargs-delete", `xargs invoking ${w}`);
    }
    if (
      ["sh", "bash", "zsh"].includes(w) &&
      words
        .slice(i + 1)
        .some((arg) => /\b(?:rm|rmdir|unlink|shred)\b/.test(arg))
    ) {
      return makeAction(
        command,
        "bash:xargs-delete",
        "xargs invoking shell deletion",
      );
    }
    break;
  }

  return undefined;
}

// OpenSSH options that take an argument in the following word. Sourced from
// `man ssh`. Single-letter flag options (e.g. -v, -A, -C) are not listed and
// are skipped by default as zero-arg flags.
const SSH_OPTS_WITH_ARGS = new Set([
  "-B",
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-P",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

function extractSshRemoteCommand(words: string[]): string {
  let i = 1; // skip 'ssh'
  while (i < words.length) {
    const w = words[i];
    if (!w.startsWith("-")) {
      i++; // consume [user@]host
      break;
    }
    i += SSH_OPTS_WITH_ARGS.has(w) ? 2 : 1;
  }
  return words.slice(i).join(" ");
}

function assessSshRemoteDestructive(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "ssh") {
    return undefined;
  }

  const remote = extractSshRemoteCommand(words);
  if (!remote) {
    return undefined;
  }
  // Check tool-specific destructive patterns first so that e.g.
  // `docker volume rm` is categorised as ssh-destructive rather than
  // ssh-delete (the latter is for shell `rm`-family commands only).
  if (
    /\b(?:git\s+(?:clean|reset\s+--hard)|docker\s+.*(?:prune|volume\s+rm)|aws\s+\S+\s+delete-)\b/.test(
      remote,
    )
  ) {
    return makeAction(
      command,
      "bash:ssh-destructive",
      "ssh remote destructive command",
    );
  }
  if (/\b(?:rm|rmdir|unlink|shred)\b/.test(remote)) {
    return makeAction(
      command,
      "bash:ssh-delete",
      "ssh remote command with file deletion",
    );
  }
  return undefined;
}

function hasFlag(words: string[], ...flags: string[]): boolean {
  return words.some((w) => flags.includes(w));
}

// Returns the index of the first non-flag word starting from `startAt`,
// advancing past leading `-flag` / `--flag` tokens. If a flag is listed in
// `optsWithArgs`, the following word is treated as its argument and skipped.
// Used to locate a tool's subcommand when global options precede it
// (e.g. `docker --context prod system prune`).
function skipLeadingFlags(
  words: string[],
  startAt: number,
  optsWithArgs: ReadonlySet<string> = new Set(),
): number {
  let i = startAt;
  while (i < words.length) {
    const w = words[i];
    if (!w.startsWith("-")) {
      break;
    }
    i += optsWithArgs.has(w) ? 2 : 1;
  }
  return i;
}

const DOCKER_OPTS_WITH_ARGS: ReadonlySet<string> = new Set([
  "--context",
  "-c",
  "-H",
  "--host",
  "--log-level",
  "-l",
  "--config",
]);

function assessDocker(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words) {
    return undefined;
  }

  let tool = words[0];
  let rest = words.slice(1);
  if (tool === "docker-compose" || tool === "podman-compose") {
    tool = tool.startsWith("podman") ? "podman" : "docker";
    rest = ["compose", ...rest];
  } else {
    // Skip leading global options (e.g. `docker --context prod system prune`)
    // so `sub`/`sub2` point at the actual subcommand.
    const subIdx = skipLeadingFlags(words, 1, DOCKER_OPTS_WITH_ARGS);
    rest = words.slice(subIdx);
  }
  if (tool !== "docker" && tool !== "podman") {
    return undefined;
  }

  const [sub, sub2] = rest;
  if (sub === "system" && sub2 === "prune") {
    return makeAction(command, `bash:${tool}-prune`, `${tool} system prune`);
  }
  if (
    sub === "volume" &&
    (sub2 === "rm" || sub2 === "remove" || sub2 === "prune")
  ) {
    return makeAction(
      command,
      `bash:${tool}-volume-delete`,
      `${tool} volume ${sub2}`,
    );
  }
  if (
    sub === "compose" &&
    sub2 === "down" &&
    hasFlag(rest, "-v", "--volumes")
  ) {
    return makeAction(
      command,
      `bash:${tool}-compose-volumes`,
      `${tool} compose down --volumes`,
    );
  }
  if (sub === "image" && sub2 === "prune" && hasFlag(rest, "-a", "--all")) {
    return makeAction(
      command,
      `bash:${tool}-image-prune-all`,
      `${tool} image prune --all`,
    );
  }
  if (
    sub === "container" &&
    (sub2 === "rm" || sub2 === "remove") &&
    hasFlag(rest, "-f", "--force")
  ) {
    return makeAction(
      command,
      `bash:${tool}-container-rm-force`,
      `${tool} container rm --force`,
    );
  }
  if ((sub === "rm" || sub === "remove") && hasFlag(rest, "-f", "--force")) {
    return makeAction(
      command,
      `bash:${tool}-container-rm-force`,
      `${tool} rm --force`,
    );
  }
  if (sub === "builder" && sub2 === "prune") {
    return makeAction(
      command,
      `bash:${tool}-builder-prune`,
      `${tool} builder prune`,
    );
  }
  return undefined;
}

function assessGlobalPackageManager(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words) {
    return undefined;
  }

  const cmd = words[0];
  const rest = words.slice(1);
  // `rest` keeps the full tail so flag detection still sees globals wherever
  // they sit. `subRest` skips leading flags so [0]/[1] point at the actual
  // subcommand (e.g. `npm --global uninstall foo`).
  const subRest = words.slice(skipLeadingFlags(words, 1));
  const hasGlobal =
    hasFlag(rest, "-g", "--global") ||
    rest.some((w) => w.startsWith("--location=global"));

  if (
    cmd === "npm" &&
    hasGlobal &&
    [
      "install",
      "i",
      "add",
      "uninstall",
      "remove",
      "rm",
      "un",
      "update",
      "upgrade",
    ].includes(subRest[0] ?? "")
  ) {
    return makeAction(
      command,
      "bash:global-package-manager",
      `npm ${subRest[0]} --global`,
    );
  }
  if (
    cmd === "pnpm" &&
    hasGlobal &&
    ["add", "install", "remove", "rm", "update", "upgrade"].includes(
      subRest[0] ?? "",
    )
  ) {
    return makeAction(
      command,
      "bash:global-package-manager",
      `pnpm ${subRest[0]} --global`,
    );
  }
  if (
    cmd === "yarn" &&
    subRest[0] === "global" &&
    ["add", "remove", "upgrade"].includes(subRest[1] ?? "")
  ) {
    return makeAction(
      command,
      "bash:global-package-manager",
      `yarn global ${subRest[1]}`,
    );
  }
  if (
    cmd === "bun" &&
    hasGlobal &&
    ["install", "add", "remove", "update"].includes(subRest[0] ?? "")
  ) {
    return makeAction(
      command,
      "bash:global-package-manager",
      `bun ${subRest[0]} --global`,
    );
  }
  if (
    cmd === "brew" &&
    [
      "install",
      "uninstall",
      "remove",
      "upgrade",
      "reinstall",
      "tap",
      "untap",
    ].includes(subRest[0] ?? "")
  ) {
    return makeAction(
      command,
      "bash:system-package-manager",
      `brew ${subRest[0]}`,
    );
  }
  if (
    ["apt", "apt-get"].includes(cmd) &&
    [
      "install",
      "remove",
      "purge",
      "upgrade",
      "dist-upgrade",
      "full-upgrade",
      "autoremove",
    ].includes(subRest[0] ?? "")
  ) {
    return makeAction(
      command,
      "bash:system-package-manager",
      `${cmd} ${subRest[0]}`,
    );
  }
  if (
    ["dnf", "yum"].includes(cmd) &&
    ["install", "remove", "erase", "upgrade"].includes(subRest[0] ?? "")
  ) {
    return makeAction(
      command,
      "bash:system-package-manager",
      `${cmd} ${subRest[0]}`,
    );
  }
  if (cmd === "pacman" && rest.some((w) => /^-S|^-R/.test(w))) {
    return makeAction(
      command,
      "bash:system-package-manager",
      "pacman package mutation",
    );
  }
  if (
    cmd === "nix" &&
    subRest[0] === "profile" &&
    ["install", "remove", "upgrade"].includes(subRest[1] ?? "")
  ) {
    return makeAction(
      command,
      "bash:system-package-manager",
      `nix profile ${subRest[1]}`,
    );
  }
  return undefined;
}

function skipGhGlobalFlags(words: string[]): string[] {
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (["-R", "--repo", "--hostname"].includes(w)) {
      i += 2;
      continue;
    }
    if (w.startsWith("--repo=") || w.startsWith("--hostname=")) {
      i++;
      continue;
    }
    if (w.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function assessGh(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "gh") {
    if (/\bgh\s+api\b.*\bmutation\b/i.test(command)) {
      return makeAction(command, "bash:gh-mutation", "gh api GraphQL mutation");
    }
    return undefined;
  }

  const rest = skipGhGlobalFlags(words);
  const [sub, action] = rest;
  if (!sub) {
    return undefined;
  }

  if (sub === "api") {
    for (let i = 1; i < rest.length; i++) {
      const w = rest[i];
      const method =
        w === "-X" || w === "--method"
          ? rest[i + 1]
          : w.startsWith("-X") && w.length > 2
            ? w.slice(2)
            : w.startsWith("--method=")
              ? w.slice("--method=".length)
              : undefined;
      if (
        method &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())
      ) {
        return makeAction(
          command,
          "bash:gh-mutation",
          `gh api ${method.toUpperCase()}`,
        );
      }
    }
    if (/\bmutation\b/i.test(command)) {
      return makeAction(command, "bash:gh-mutation", "gh api GraphQL mutation");
    }
  }

  const mutating: Record<string, Set<string>> = {
    repo: new Set([
      "create",
      "delete",
      "archive",
      "rename",
      "transfer",
      "edit",
    ]),
    pr: new Set([
      "create",
      "merge",
      "close",
      "reopen",
      "edit",
      "ready",
      "review",
      "comment",
    ]),
    issue: new Set([
      "create",
      "close",
      "reopen",
      "edit",
      "comment",
      "delete",
      "transfer",
    ]),
    release: new Set(["create", "edit", "delete", "upload"]),
    workflow: new Set(["enable", "disable", "run"]),
    run: new Set(["cancel", "delete", "rerun"]),
    secret: new Set(["set", "delete", "remove"]),
    variable: new Set(["set", "delete", "remove"]),
    codespace: new Set(["delete", "stop", "rebuild"]),
  };

  if (mutating[sub]?.has(action ?? "")) {
    return makeAction(command, "bash:gh-mutation", `gh ${sub} ${action}`);
  }
  return undefined;
}

function assessInfra(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words) {
    return undefined;
  }

  const cmd = words[0];
  const rest = words.slice(1);
  if (cmd === "terraform" || cmd === "tofu") {
    // Handle global options before the subcommand, e.g. `terraform -chdir=./infra apply`.
    // Terraform's leading globals (-chdir=, -help, -version, -no-color) use the
    // `=` form or take no separate argument, so the default opts-with-args
    // (none) is correct here.
    const subRest = words.slice(skipLeadingFlags(words, 1));
    const sub = subRest[0];
    if (sub === "destroy") {
      return makeAction(command, `bash:${cmd}-destroy`, `${cmd} destroy`);
    }
    if (
      sub === "apply" &&
      (rest.includes("-destroy") ||
        rest.includes("--destroy") ||
        rest.includes("-auto-approve") ||
        rest.includes("--auto-approve"))
    ) {
      return makeAction(
        command,
        `bash:${cmd}-apply-risky`,
        `${cmd} apply destructive/auto-approved`,
      );
    }
    if (sub === "state" && ["rm", "mv"].includes(subRest[1] ?? "")) {
      return makeAction(
        command,
        `bash:${cmd}-state-mutation`,
        `${cmd} state ${subRest[1]}`,
      );
    }
    if (sub === "workspace" && subRest[1] === "delete") {
      return makeAction(
        command,
        `bash:${cmd}-workspace-delete`,
        `${cmd} workspace delete`,
      );
    }
  }

  if (cmd === "pulumi") {
    const sub = rest[0];
    if (sub === "destroy") {
      return makeAction(command, "bash:pulumi-destroy", "pulumi destroy");
    }
    if (sub === "up" && hasFlag(rest, "--yes", "-y")) {
      return makeAction(command, "bash:pulumi-up-yes", "pulumi up --yes");
    }
    if (sub === "stack" && ["rm", "remove"].includes(rest[1] ?? "")) {
      return makeAction(
        command,
        "bash:pulumi-stack-rm",
        `pulumi stack ${rest[1]}`,
      );
    }
  }

  return undefined;
}

const AWS_DESTRUCTIVE_PREFIXES = [
  "delete-",
  "terminate-",
  "remove-",
  "deregister-",
  "detach-",
  "disable-",
  "revoke-",
];

function skipAwsGlobalOptions(words: string[]): string[] {
  const optionsWithValues = new Set([
    "--profile",
    "--region",
    "--endpoint-url",
    "--output",
    "--query",
    "--ca-bundle",
    "--cli-input-json",
    "--cli-input-yaml",
  ]);
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (optionsWithValues.has(w)) {
      i += 2;
      continue;
    }
    if ([...optionsWithValues].some((opt) => w.startsWith(`${opt}=`))) {
      i++;
      continue;
    }
    if (["--debug", "--no-paginate", "--no-cli-pager"].includes(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function assessAws(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words || words[0] !== "aws") {
    return undefined;
  }
  const rest = skipAwsGlobalOptions(words);
  const [service, operation] = rest;
  if (!service || !operation) {
    return undefined;
  }

  if (service === "s3" && ["rm", "rb"].includes(operation)) {
    return makeAction(command, "bash:aws-destructive", `aws s3 ${operation}`);
  }
  if (service === "s3" && operation === "sync" && rest.includes("--delete")) {
    return makeAction(command, "bash:aws-destructive", "aws s3 sync --delete");
  }
  if (AWS_DESTRUCTIVE_PREFIXES.some((prefix) => operation.startsWith(prefix))) {
    return makeAction(
      command,
      "bash:aws-destructive",
      `aws ${service} ${operation}`,
    );
  }
  return undefined;
}

function assessDeployPublish(command: string): GuardAction | undefined {
  const words = extractShellWords(command);
  if (!words) {
    return undefined;
  }

  const cmd = words[0];
  const rest = words.slice(1);
  if (cmd === "npm" && ["publish", "unpublish"].includes(rest[0] ?? "")) {
    return makeAction(command, "bash:publish", `npm ${rest[0]}`);
  }
  if (cmd === "pnpm" && rest[0] === "publish") {
    return makeAction(command, "bash:publish", "pnpm publish");
  }
  if (cmd === "yarn" && rest[0] === "npm" && rest[1] === "publish") {
    return makeAction(command, "bash:publish", "yarn npm publish");
  }
  if (cmd === "gem" && ["push", "yank"].includes(rest[0] ?? "")) {
    return makeAction(command, "bash:publish", `gem ${rest[0]}`);
  }
  if ((cmd === "docker" || cmd === "podman") && rest[0] === "push") {
    return makeAction(command, "bash:publish", `${cmd} push`);
  }
  if (cmd === "vercel" && rest.includes("--prod")) {
    return makeAction(command, "bash:deploy-prod", "vercel deploy --prod");
  }
  if (
    cmd === "wrangler" &&
    ["deploy", "publish", "delete"].includes(rest[0] ?? "")
  ) {
    return makeAction(command, "bash:deploy-prod", `wrangler ${rest[0]}`);
  }
  return undefined;
}

// ── Main entrypoint ──

function assessSingleCommand(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  return (
    assessRemoteScriptExecution(command) ??
    assessShellExecDestructive(command) ??
    assessXargsDestructive(command) ??
    assessSshRemoteDestructive(command) ??
    assessFindDelete(command, cwd, sessionCreatedPaths) ??
    assessGit(command, cwd) ??
    assessRemoval(command, cwd, sessionCreatedPaths) ??
    assessColonRedirect(command, cwd, sessionCreatedPaths) ??
    assessRedirect(command, cwd, sessionCreatedPaths) ??
    assessTruncate(command, cwd, sessionCreatedPaths) ??
    assessDd(command, cwd, sessionCreatedPaths) ??
    assessSedInPlace(command, cwd, sessionCreatedPaths) ??
    assessPerlInPlace(command, cwd, sessionCreatedPaths) ??
    assessMvCp(command, cwd, sessionCreatedPaths) ??
    assessInstall(command, cwd, sessionCreatedPaths) ??
    assessPermissions(command) ??
    assessRsync(command) ??
    assessInterpreter(command) ??
    assessDocker(command) ??
    assessGlobalPackageManager(command) ??
    assessGh(command) ??
    assessInfra(command) ??
    assessAws(command) ??
    assessDeployPublish(command) ??
    undefined
  );
}

export function assessBashCommand(
  command: string,
  cwd: string,
  sessionCreatedPaths: Set<string>,
): GuardAction | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  // Strip rm/rmdir/unlink/shred operations that only target mktemp-assigned
  // vars from the command before splitting into candidates. This avoids both
  // (a) false positives where a segment like `rm "$TMP"` is assessed without
  // knowing $TMP came from mktemp, and (b) false negatives where a safe
  // mktemp cleanup short-circuits assessment of other risky operations in
  // the same compound command (e.g. a trailing `docker rmi --force`).
  const commandToAssess = stripMktempCleanups(trimmed);

  for (const candidate of commandCandidates(commandToAssess)) {
    const action = assessSingleCommand(candidate, cwd, sessionCreatedPaths);
    if (action) {
      return withPreview(action, trimmed);
    }
  }

  return undefined;
}
