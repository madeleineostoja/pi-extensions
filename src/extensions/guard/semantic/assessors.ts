import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalCandidates,
  createRecoverability,
  isRecoverable,
} from "./recoverability.js";
import {
  executable,
  redirectTargets,
  splitSegments,
  tokenize,
} from "./shell.js";

export type Risk = {
  category: string;
  severity: "medium" | "high";
  effect: string;
  segment: string;
  targets: string[];
  uncertainty?: string;
  segmentIndex: number;
};
type Operation = "remove" | "follow" | "overwrite";
type Draft = Omit<Risk, "segmentIndex" | "targets"> & {
  targets?: string[];
  filesystem?: Operation;
};
type Marker = { marker: RegExp; category: string; effect: string };

const categoryOrder = [
  "filesystem",
  "git",
  "permissions",
  "remote",
  "container",
  "package",
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
    marker: /(?:^|\s)find\b[\s\S]*?(?:-delete|-exec(?:dir)?)(?=\s|$)/,
    category: "filesystem",
    effect: "find destructive execution",
  },
  {
    marker: /(?:^|\s)xargs\b[\s\S]*?(?:rm|rmdir|unlink|shred|sh|bash)(?=\s|$)/,
    category: "filesystem",
    effect: "xargs destructive execution",
  },
  {
    marker: /(?:^|\s)(?:ssh|scp)\b[\s\S]+/,
    category: "remote",
    effect: "remote command requires confirmation",
  },
  {
    marker: /(?:^|\s)(?:curl|wget)\b[\s\S]*?(?:\||sh|bash|python|node)(?=\s|$)/,
    category: "remote",
    effect: "remote script execution",
  },
  {
    marker:
      /(?:^|\s)git\s+(?:clean|reset|restore|push|branch|tag|gc|reflog)(?=\s|$)/,
    category: "git",
    effect: "unparseable Git data loss",
  },
  {
    marker:
      /(?:^|\s)(?:docker|podman)\s+(?:system|volume|image|container)(?=\s|$)/,
    category: "container",
    effect: "unparseable container mutation",
  },
  {
    marker:
      /(?:^|\s)(?:terraform|tofu|pulumi|aws)\s+(?:apply|destroy|delete|terminate|remove)(?=\s|$)/,
    category: "infrastructure",
    effect: "unparseable infrastructure mutation",
  },
  {
    marker: /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:publish|unpublish)(?=\s|$)/,
    category: "publish",
    effect: "unparseable package publish",
  },
];

function draft(
  category: string,
  effect: string,
  segment: string,
  targets: string[] = [],
  filesystem?: Operation,
  uncertainty?: string,
): Draft {
  return {
    category,
    effect,
    segment,
    targets,
    filesystem,
    uncertainty,
    severity:
      category === "filesystem" || category === "git" ? "high" : "medium",
  };
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
        [],
        undefined,
        "Unsupported shell syntax; this warning is based only on an exact destructive marker.",
      ),
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
    add("filesystem", "file removal", segment, plain, "remove");
  }
  if (name === "find" && args.includes("-delete")) {
    add(
      "filesystem",
      "find deletion",
      segment,
      plain.slice(0, 1).length ? plain.slice(0, 1) : ["."],
      undefined,
      "find search roots are not fully interpreted; confirmation covers the exact invocation.",
    );
  }
  if (
    name === "find" &&
    (args.includes("-exec") || args.includes("-execdir"))
  ) {
    add(
      "filesystem",
      "find destructive execution",
      segment,
      plain.slice(0, 1).length ? plain.slice(0, 1) : ["."],
      undefined,
      "find -exec is not interpreted; confirmation covers the exact invocation.",
    );
  }
  if (
    name === "xargs" &&
    args.some((arg) =>
      ["rm", "rmdir", "unlink", "shred", "sh", "bash"].includes(arg),
    )
  ) {
    add(
      "filesystem",
      "xargs destructive execution",
      segment,
      [],
      undefined,
      "xargs input is not interpreted; confirmation covers the exact invocation.",
    );
  }

  if (["cp", "install", "mv"].includes(name) && plain.length >= 2) {
    const destination = plain.at(-1)!;
    const ambiguous =
      plain.length > 2 || args.some((arg) => arg.startsWith("-"));
    add(
      "filesystem",
      `${name} destination replacement`,
      segment,
      name === "mv" ? [plain.at(-2)!, destination] : [destination],
      name === "mv" ? undefined : "overwrite",
      ambiguous
        ? `${name} destination semantics are ambiguous; confirmation covers the exact invocation.`
        : undefined,
    );
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
        [target],
        "follow",
      );
    }
  }
  const redirects = redirectTargets(words);
  if (redirects.length) {
    add("filesystem", "truncating redirection", segment, redirects, "follow");
  }

  if (name === "git") {
    const text = args.join(" ");
    if (
      /\bclean\b.*(?:-f|--force)|\breset\s+--hard|\brestore\b(?:\s|$)|\bcheckout\b.*(?:-f|--force|\s+--(?:\s|$))|\bstash\s+(?:drop|clear)|\bbranch\s+-[dD]|\btag\s+-d|\bpush\b.*(?:-[A-Za-z]*f[A-Za-z]*\b|--force|--delete|--prune|--mirror)|\bpush\b.*(?:\s:\S|\s\+\S)|\bgc\b.*--prune|\breflog\s+expire/.test(
        text,
      )
    ) {
      add("git", "destructive Git operation", segment);
    }
  }
  if (
    (name === "chmod" &&
      (args.some((arg) => /R/.test(arg)) || args.includes("777"))) ||
    (name === "chown" && args.some((arg) => /R/.test(arg)))
  ) {
    add("permissions", "risky recursive permissions change", segment);
  }
  if (
    name === "rsync" &&
    args.some((arg) => arg === "--delete" || arg.startsWith("--delete="))
  ) {
    add(
      "filesystem",
      "rsync deletion",
      segment,
      plain.at(-1) ? [plain.at(-1)!] : [],
      undefined,
      plain.at(-1) ? undefined : "rsync destination is unknown.",
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
    ["apt", "apt-get", "dnf", "yum", "pacman", "brew"].includes(name) &&
    /\b(?:install|uninstall|remove|purge|upgrade|autoremove)\b/.test(
      args.join(" "),
    )
  ) {
    add("package", "system package mutation", segment);
  }
  if (
    ["npm", "pnpm", "yarn"].includes(name) &&
    /(?:^|\s)(?:uninstall|remove|global)(?:\s|$)|(?:^|\s)(?:--global|-g)(?:\s|$)/.test(
      args.join(" "),
    )
  ) {
    add("package", "global package mutation", segment);
  }
  if (
    ["terraform", "tofu", "pulumi", "aws", "kubectl"].includes(name) &&
    /\b(?:destroy|apply|delete(?:-|\b)|terminate-|remove-|up\s+--yes|sync\s+.*--delete)\b/.test(
      args.join(" "),
    )
  ) {
    add("infrastructure", "infrastructure mutation", segment);
  }
  if (
    (["npm", "pnpm"].includes(name) &&
      ["publish", "unpublish"].includes(args[0] ?? "")) ||
    (name === "yarn" && args[0] === "npm" && args[1] === "publish") ||
    (["vercel", "netlify", "fly", "gh"].includes(name) &&
      /\b(?:deploy|publish|create|delete|destroy|merge)\b/.test(args.join(" ")))
  ) {
    add("publish", "remote deploy or publish", segment);
  }
  if (
    name === "gh" &&
    /\b(?:create|delete|close|merge|edit|POST|PUT|PATCH|DELETE)\b/.test(
      args.join(" "),
    )
  ) {
    add("remote", "GitHub mutation", segment);
  }
  if (name === "ssh" && args.length > 1) {
    add(
      "remote",
      "remote command requires confirmation",
      segment,
      [],
      undefined,
      "SSH command tails are not interpreted; confirmation covers the exact invocation.",
    );
  }
  if (
    ["python", "python3", "node", "perl", "ruby"].includes(name) &&
    args.some((arg) => ["-c", "-e"].includes(arg))
  ) {
    add(
      "remote",
      "inline interpreter execution",
      segment,
      [],
      undefined,
      "Inline interpreter content is not interpreted; confirmation covers the exact invocation.",
    );
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

export async function assessBashCommand(
  command: string,
  cwd: string,
): Promise<Risk[]> {
  const recovery = createRecoverability(cwd);
  let effectiveCwd = cwd;
  const risks: Risk[] = [];
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
      const targets = item.targets ?? [];
      const directoryDestination =
        item.effect.endsWith(" destination replacement") &&
        targets.length === 1 &&
        (() => {
          try {
            return statSync(resolve(effectiveCwd, targets[0]!)).isDirectory();
          } catch {
            return false;
          }
        })();
      const uncertainty =
        item.uncertainty ??
        (directoryDestination
          ? "Destination is a directory; replacement semantics are ambiguous."
          : undefined);
      const absoluteTargets = await Promise.all(
        targets.map(async (target) => {
          const candidates = item.filesystem
            ? await canonicalCandidates(
                resolve(effectiveCwd, target),
                item.filesystem,
                recovery,
              )
            : [];
          return candidates.at(-1) ?? resolve(effectiveCwd, target);
        }),
      );
      if (
        item.filesystem &&
        !uncertainty &&
        targets.length &&
        (
          await Promise.all(
            targets.map((target) =>
              isRecoverable(
                resolve(effectiveCwd, target),
                item.filesystem!,
                recovery,
              ),
            ),
          )
        ).every(Boolean)
      ) {
        continue;
      }
      risks.push({
        ...item,
        uncertainty,
        targets: absoluteTargets,
        segmentIndex: segment.index,
      });
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
