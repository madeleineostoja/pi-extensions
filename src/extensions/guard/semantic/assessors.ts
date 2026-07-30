import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  canonicalCandidates,
  createRecoverability,
  hasUnrecoverableData,
  type FilesystemOperation,
} from "./recoverability.js";
import {
  executable,
  redirectTargets,
  splitSegments,
  tokenize,
} from "./shell.js";

export type Risk = {
  category: string;
  effect: string;
  segment: string;
  targets: string[];
  uncertainty?: string;
  segmentIndex: number;
};
type FilesystemEffect = {
  operation: FilesystemOperation;
  targets: string[];
  sources?: string[];
  targetDirectory?: boolean;
};
type Draft = Omit<Risk, "segmentIndex" | "targets"> & {
  filesystem?: FilesystemEffect;
};
type Marker = { marker: RegExp; category: string; effect: string };

const categoryOrder = [
  "filesystem",
  "git",
  "remote",
  "container",
  "infrastructure",
  "publish",
];
const uncertainMarkers: Marker[] = [
  {
    marker: /(?:^|[\s(`$=])(?:rm|rmdir|unlink|shred)(?:\s|$)/,
    category: "filesystem",
    effect: "unparseable file removal",
  },
  {
    marker:
      /(?:^|\s)find\b[\s\S]*?(?:-delete|-exec(?:dir)?\s+(?:rm|rmdir|unlink|shred))(?=\s|$)/,
    category: "filesystem",
    effect: "find destructive execution",
  },
  {
    marker: /(?:^|\s)xargs\b[\s\S]*?(?:rm|rmdir|unlink|shred)(?=\s|$)/,
    category: "filesystem",
    effect: "xargs destructive execution",
  },
  {
    marker: /(?:^|\s)(?:curl|wget)\b[\s\S]*?(?:\||sh|bash)(?=\s|$)/,
    category: "remote",
    effect: "remote script execution",
  },
  {
    marker:
      /(?:^|\s)git\s+(?:clean\b[\s\S]*?(?:-f|--force)|reset\s+--hard|restore\b|checkout\b[\s\S]*?(?:-f|--force|\s+--)|stash\s+(?:drop|clear)|branch\s+-D|push\b[\s\S]*?(?:-[A-Za-z]*f[A-Za-z]*\b|--force|--delete|--prune|--mirror|\s:\S|\s\+\S)|gc\b[\s\S]*?--prune|reflog\s+expire)(?=\s|$)/,
    category: "git",
    effect: "unparseable destructive Git operation",
  },
  {
    marker:
      /(?:^|\s)(?:docker|podman)\s+(?:system\s+prune|volume\s+(?:rm|remove|prune)|image\s+(?:rm|remove|prune)|container\s+(?:rm|remove))(?=\s|$)/,
    category: "container",
    effect: "unparseable container data deletion",
  },
  {
    marker:
      /(?:^|\s)(?:terraform|tofu|pulumi|aws|kubectl)\s+(?:destroy|delete(?:-|\b)|terminate-|remove-)(?=\s|$)/,
    category: "infrastructure",
    effect: "unparseable infrastructure destruction",
  },
  {
    marker: /(?:^|\s)(?:npm|pnpm)\s+unpublish(?=\s|$)/,
    category: "publish",
    effect: "unparseable package unpublish",
  },
];

function draft(
  category: string,
  effect: string,
  segment: string,
  filesystem?: FilesystemEffect,
  uncertainty?: string,
): Draft {
  return { category, effect, segment, filesystem, uncertainty };
}
function filesystem(
  operation: FilesystemOperation,
  targets: string[],
  sources?: string[],
  targetDirectory?: boolean,
): FilesystemEffect {
  return { operation, targets, sources, targetDirectory };
}
function plainArgs(args: string[]): string[] {
  return args.filter(
    (arg) =>
      !arg.startsWith("-") &&
      !/^(?:\d*>{1,2}|\d*[<>].*)$/.test(arg) &&
      !arg.startsWith("&"),
  );
}
function uncertain(segment: string): Draft[] {
  return uncertainMarkers
    .filter(({ marker }) => marker.test(segment))
    .map(({ category, effect }) =>
      draft(
        category,
        effect,
        segment,
        undefined,
        "Unsupported shell syntax; this warning is based only on an exact destructive marker.",
      ),
    );
}

function transferEffect(
  name: string,
  args: string[],
): FilesystemEffect | undefined {
  const operands: string[] = [];
  let targetDirectory: string | undefined;
  const optionsWithValue = new Set(
    name === "install"
      ? ["-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]
      : ["-t", "--target-directory", "-S", "--suffix"],
  );
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-t" || arg === "--target-directory") {
      targetDirectory = args[++index];
      continue;
    }
    if (arg.startsWith("--target-directory=")) {
      targetDirectory = arg.slice("--target-directory=".length);
      continue;
    }
    if (optionsWithValue.has(arg)) {
      index++;
      continue;
    }
    if (!arg.startsWith("-")) {
      operands.push(arg);
    }
  }
  if (targetDirectory) {
    return operands.length
      ? filesystem(
          name === "mv" ? "replace-entry" : "replace-content",
          [targetDirectory],
          operands,
          true,
        )
      : undefined;
  }
  if (operands.length < 2) {
    return undefined;
  }
  return filesystem(
    name === "mv" ? "replace-entry" : "replace-content",
    [operands.at(-1)!],
    operands.slice(0, -1),
  );
}

function direct(words: string[], segment: string, depth = 0): Draft[] {
  const command = executable(words);
  if (!command) {
    return [];
  }
  const { name, args } = command;
  const plain = plainArgs(args);
  const risks: Draft[] = [];
  const add = (...value: Parameters<typeof draft>) =>
    risks.push(draft(...value));

  if (["rm", "rmdir", "unlink", "shred"].includes(name) && plain.length) {
    add("filesystem", "file removal", segment, filesystem("remove", plain));
  }
  if (name === "find" && args.includes("-delete")) {
    add(
      "filesystem",
      "find deletion",
      segment,
      undefined,
      "find search roots are not fully interpreted; confirmation covers the exact invocation.",
    );
  }
  const findExecutable = args.findIndex(
    (arg) => arg === "-exec" || arg === "-execdir",
  );
  if (
    name === "find" &&
    ["rm", "rmdir", "unlink", "shred"].includes(args[findExecutable + 1] ?? "")
  ) {
    add(
      "filesystem",
      "find destructive execution",
      segment,
      undefined,
      "find -exec targets are not fully interpreted; confirmation covers the exact invocation.",
    );
  }
  if (
    name === "xargs" &&
    args.some((arg) => ["rm", "rmdir", "unlink", "shred"].includes(arg))
  ) {
    add(
      "filesystem",
      "xargs destructive execution",
      segment,
      undefined,
      "xargs input is not interpreted; confirmation covers the exact invocation.",
    );
  }

  if (["cp", "install", "mv"].includes(name)) {
    const effect = transferEffect(name, args);
    if (effect) {
      add("filesystem", `${name} destination replacement`, segment, effect);
    }
  }
  if (
    ["truncate", "dd", "sed", "perl"].includes(name) &&
    (name === "dd" ||
      args.some(
        (arg) =>
          arg === "-s" ||
          arg === "-i" ||
          arg.startsWith("-i") ||
          arg.startsWith("of=") ||
          arg.startsWith("--size="),
      ))
  ) {
    const target =
      name === "dd"
        ? args.find((arg) => arg.startsWith("of="))?.slice(3)
        : plain.at(-1);
    if (target) {
      add(
        "filesystem",
        `${name} destructive overwrite`,
        segment,
        filesystem("replace-content", [target]),
      );
    }
  }
  const redirects = redirectTargets(words);
  if (redirects.length) {
    add(
      "filesystem",
      "truncating redirection",
      segment,
      filesystem("replace-content", redirects),
    );
  }

  if (name === "git") {
    const text = args.join(" ");
    if (
      /\bclean\b.*(?:-f|--force)|\breset\s+--hard|\brestore\b(?:\s|$)|\bcheckout\b.*(?:-f|--force|\s+--(?:\s|$))|\bstash\s+(?:drop|clear)|\bbranch\s+-D|\bpush\b.*(?:-[A-Za-z]*f[A-Za-z]*\b|--force|--delete|--prune|--mirror)|\bpush\b.*(?:\s:\S|\s\+\S)|\bgc\b.*--prune|\breflog\s+expire/.test(
        text,
      )
    ) {
      add("git", "destructive Git operation", segment);
    }
  }
  if (
    name === "rsync" &&
    args.some((arg) => arg === "--delete" || arg.startsWith("--delete="))
  ) {
    add(
      "filesystem",
      "rsync deletion",
      segment,
      undefined,
      "rsync deletion targets are not fully interpreted; confirmation covers the exact invocation.",
    );
  }
  if (
    ["docker", "podman"].includes(name) &&
    /\b(?:system\s+prune|volume\s+(?:rm|remove|prune)|image\s+(?:rm|remove|prune)|container\s+(?:rm|remove)|compose\b[\s\S]*?\bdown\b.*(?:-v|--volumes))\b/.test(
      args.join(" "),
    )
  ) {
    add("container", "container data deletion", segment);
  }
  if (
    ["terraform", "tofu", "pulumi", "aws", "kubectl"].includes(name) &&
    /\b(?:destroy|delete(?:-|\b)|terminate-|remove-)\b/.test(args.join(" "))
  ) {
    add("infrastructure", "infrastructure destruction", segment);
  }
  if (
    (["npm", "pnpm"].includes(name) && args[0] === "unpublish") ||
    (name === "yarn" && args[0] === "npm" && args[1] === "unpublish")
  ) {
    add("publish", "package unpublish", segment);
  }
  const sshHost =
    name === "ssh" ? args.findIndex((arg) => !arg.startsWith("-")) : -1;
  const sshCommand = args.slice(sshHost + 1);
  if (
    name === "ssh" &&
    ["rm", "rmdir", "unlink", "shred"].includes(
      sshCommand[0]?.split(/\s/, 1)[0] ?? "",
    )
  ) {
    add("remote", "remote file removal", segment);
  }
  if (
    name === "gh" &&
    (/\brepo\s+delete\b|\brelease\s+delete\b/.test(args.join(" ")) ||
      (args[0] === "api" &&
        /(?:-X|--method)\s*=?\s*DELETE\b/i.test(args.join(" "))))
  ) {
    add("remote", "destructive GitHub operation", segment);
  }
  if (name === "eval") {
    risks.push(...uncertain(args.join(" ")));
  }
  if ((name === "sh" || name === "bash") && depth === 0) {
    const index = args.indexOf("-c");
    const payload = index >= 0 ? args[index + 1] : undefined;
    if (payload) {
      for (const nested of splitSegments(payload)) {
        const nestedWords = tokenize(nested.text);
        risks.push(
          ...(nestedWords
            ? direct(nestedWords, nested.text, 1)
            : uncertain(nested.text)),
        );
      }
    }
  }
  return risks;
}

function concreteTargets(effect: FilesystemEffect, cwd: string): string[] {
  const destination = effect.targets[0];
  if (!destination || !effect.sources?.length || effect.targets.length !== 1) {
    return effect.targets;
  }
  try {
    if (!statSync(resolve(cwd, destination)).isDirectory()) {
      return effect.sources.length === 1 && !effect.targetDirectory
        ? [destination]
        : [];
    }
    return effect.sources.map((source) =>
      resolve(cwd, destination, basename(source)),
    );
  } catch {
    return effect.targetDirectory
      ? []
      : effect.sources.length === 1
        ? [destination]
        : [];
  }
}

export async function assessBashCommand(
  command: string,
  cwd: string,
): Promise<Risk[]> {
  const recovery = createRecoverability(cwd);
  let effectiveCwd = cwd;
  const risks: Risk[] = [];
  const movedUnrecoverableData = new Set<string>();
  const segments = splitSegments(command);
  for (const segment of segments) {
    const words = tokenize(segment.text);
    const drafts = words
      ? direct(words, segment.text)
      : uncertain(segment.text);
    if (words && (/^\s*\(/.test(segment.text) || /[`$]/.test(segment.text))) {
      drafts.push(...uncertain(segment.text));
    }
    const commandInfo = words && executable(words);
    const nextWords = tokenize(segments[segment.index + 1]?.text ?? "");
    const next = nextWords && executable(nextWords);
    if (
      commandInfo &&
      ["curl", "wget"].includes(commandInfo.name) &&
      segment.separator === "|" &&
      next &&
      ["sh", "bash", "python", "python3", "node", "perl", "ruby"].includes(
        next.name,
      )
    ) {
      drafts.push(draft("remote", "remote script execution", segment.text));
    }
    for (const item of drafts) {
      const effect = item.filesystem;
      const targets = effect ? concreteTargets(effect, effectiveCwd) : [];
      const absoluteTargets = await Promise.all(
        targets.map(async (target) => {
          const candidates = effect
            ? await canonicalCandidates(
                resolve(effectiveCwd, target),
                effect.operation,
                recovery,
              )
            : [];
          return candidates.at(-1) ?? resolve(effectiveCwd, target);
        }),
      );
      const overwritesMovedData = absoluteTargets.some((target) =>
        movedUnrecoverableData.has(target),
      );
      if (!effect || !targets.length) {
        if (!effect) {
          risks.push({
            ...item,
            targets: absoluteTargets,
            segmentIndex: segment.index,
          });
        }
        continue;
      }
      if (
        !overwritesMovedData &&
        !(
          await Promise.all(
            targets.map((target) =>
              hasUnrecoverableData(
                resolve(effectiveCwd, target),
                effect.operation,
                recovery,
              ),
            ),
          )
        ).some(Boolean)
      ) {
        continue;
      }
      risks.push({
        ...item,
        targets: absoluteTargets,
        segmentIndex: segment.index,
      });
    }
    for (const item of drafts) {
      const effect = item.filesystem;
      if (
        item.effect !== "mv destination replacement" ||
        !effect?.sources?.length
      ) {
        continue;
      }
      const targets = concreteTargets(effect, effectiveCwd);
      for (const [index, source] of effect.sources.entries()) {
        const target = targets[index];
        if (
          target &&
          (await hasUnrecoverableData(
            resolve(effectiveCwd, source),
            "remove",
            recovery,
          ))
        ) {
          const candidates = await canonicalCandidates(
            resolve(effectiveCwd, target),
            effect.operation,
            recovery,
          );
          movedUnrecoverableData.add(
            candidates.at(-1) ?? resolve(effectiveCwd, target),
          );
        }
      }
    }
    const cdTarget =
      words?.[0] === "cd"
        ? commandInfo?.args.find((arg) => arg !== "--")
        : undefined;
    if (
      cdTarget &&
      !cdTarget.startsWith("-") &&
      ["&&", ";", "\n", null].includes(segment.separator)
    ) {
      effectiveCwd = resolve(effectiveCwd, cdTarget);
    }
  }
  return risks
    .filter(
      (item, index, all) =>
        all.findIndex(
          (other) =>
            other.segmentIndex === item.segmentIndex &&
            other.category === item.category &&
            other.effect === item.effect &&
            other.targets.join("\0") === item.targets.join("\0"),
        ) === index,
    )
    .sort(
      (a, b) =>
        a.segmentIndex - b.segmentIndex ||
        categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) ||
        a.effect.localeCompare(b.effect),
    );
}
