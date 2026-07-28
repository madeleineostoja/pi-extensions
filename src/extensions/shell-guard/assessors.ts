import { resolve } from "node:path";
import { createRecoverability, isRecoverable } from "./recoverability";
import { executable, splitSegments, tokenize } from "./shell";

export type Risk = {
  category: string;
  severity: "medium" | "high";
  effect: string;
  segment: string;
  targets: string[];
  uncertainty?: string;
  segmentIndex: number;
};

type Draft = Omit<Risk, "segmentIndex"> & {
  filesystem?: "remove" | "follow" | "overwrite";
};
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
const destructiveMarkers: Array<[RegExp, string, string]> = [
  [
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:rm|rmdir|unlink|shred)(?:\s|$)/,
    "filesystem",
    "unparseable file removal",
  ],
  [
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*git\s+(?:clean\s+.*(?:-f|--force)|reset\s+--hard|push\s+.*(?:--force|--delete)|branch\s+-D)(?:\s|$)/,
    "git",
    "unparseable Git data loss",
  ],
  [
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:docker|podman)\s+(?:system\s+prune|volume\s+(?:rm|remove|prune))(?:\s|$)/,
    "container",
    "unparseable container deletion",
  ],
];

function risk(
  category: string,
  effect: string,
  segment: string,
  targets: string[] = [],
  filesystem?: Draft["filesystem"],
): Draft {
  return {
    category,
    severity:
      category === "filesystem" || category === "git" ? "high" : "medium",
    effect,
    segment,
    targets,
    filesystem,
  };
}

function direct(words: string[], segment: string): Draft[] {
  const command = executable(words);
  if (!command) {
    return [];
  }
  const { name, args } = command;
  const plain = args.filter(
    (arg) => !arg.startsWith("-") && arg !== ">" && arg !== ">>",
  );
  if (["rm", "rmdir", "unlink", "shred"].includes(name) && plain.length) {
    return [risk("filesystem", "file removal", segment, plain, "remove")];
  }
  if (name === "find" && args.includes("-delete")) {
    return [
      risk(
        "filesystem",
        "find deletion",
        segment,
        plain.length ? plain.slice(0, 1) : ["."],
        "remove",
      ),
    ];
  }
  if (["cp", "install", "mv"].includes(name) && plain.length >= 2) {
    const destination = plain.at(-1)!;
    return [
      risk(
        "filesystem",
        `${name} destination overwrite`,
        segment,
        [destination],
        "overwrite",
      ),
    ];
  }
  if (
    ["truncate", "dd", "sed", "perl"].includes(name) &&
    (args.some(
      (arg) =>
        arg === "-s" ||
        arg === "-i" ||
        arg.startsWith("-i") ||
        arg.startsWith("of=") ||
        arg.startsWith("--size=0"),
    ) ||
      name === "dd")
  ) {
    const target =
      name === "dd"
        ? args.find((arg) => arg.startsWith("of="))?.slice(3)
        : plain.at(-1);
    return target
      ? [
          risk(
            "filesystem",
            `${name} destructive overwrite`,
            segment,
            [target],
            "follow",
          ),
        ]
      : [];
  }
  const redirects = words.flatMap((word, index) =>
    word === ">" && typeof words[index + 1] === "string"
      ? [words[index + 1]]
      : [],
  );
  if (redirects.length) {
    return [
      risk(
        "filesystem",
        "truncating redirection",
        segment,
        redirects,
        "follow",
      ),
    ];
  }
  if ((name === "sh" || name === "bash") && args[0] === "-c" && args[1]) {
    return direct(tokenize(args[1]) ?? [], args[1]);
  }
  if (name === "git") {
    const text = args.join(" ");
    if (
      /\b(clean\b.*(?:-f|--force)|reset\s+--hard|checkout\s+.*(?:-f|--force)|restore\s+\.|stash\s+(?:drop|clear)|branch\s+-[dD]|tag\s+-d|push\b.*(?:--force|--delete|--prune)|gc\s+.*--prune=now)/.test(
        text,
      )
    ) {
      return [risk("git", "destructive Git operation", segment)];
    }
  }
  if (
    (name === "chmod" &&
      (args.some((arg) => arg.includes("R")) || args.includes("777"))) ||
    (name === "chown" && args.some((arg) => arg.includes("R")))
  ) {
    return [risk("permissions", "risky recursive permissions change", segment)];
  }
  if (name === "rsync" && args.some((arg) => arg.startsWith("--delete"))) {
    return [risk("filesystem", "rsync deletion", segment)];
  }
  if (
    ["docker", "podman"].includes(name) &&
    /\b(?:system\s+prune|volume\s+(?:rm|remove|prune)|image\s+prune|container\s+(?:rm|remove))\b/.test(
      args.join(" "),
    )
  ) {
    return [risk("container", "container data deletion", segment)];
  }
  if (
    [
      "npm",
      "pnpm",
      "yarn",
      "brew",
      "apt",
      "apt-get",
      "dnf",
      "yum",
      "pacman",
    ].includes(name) &&
    /\b(?:install|uninstall|remove|purge|upgrade|autoremove|global)\b/.test(
      args.join(" "),
    )
  ) {
    return [risk("package", "package or system mutation", segment)];
  }
  if (
    ["terraform", "tofu", "pulumi", "aws"].includes(name) &&
    /\b(?:destroy|apply|delete-|terminate-|remove-|up\s+--yes|sync\s+.*--delete)\b/.test(
      args.join(" "),
    )
  ) {
    return [risk("infrastructure", "infrastructure mutation", segment)];
  }
  if ((name === "npm" || name === "pnpm") && args[0] === "publish") {
    return [risk("publish", "package publish", segment)];
  }
  if (
    name === "gh" &&
    /\b(?:create|delete|close|merge|edit|POST|PUT|PATCH|DELETE)\b/.test(
      args.join(" "),
    )
  ) {
    return [risk("remote", "GitHub mutation", segment)];
  }
  if (
    name === "ssh" &&
    /\b(?:rm|docker\s+.*(?:prune|volume\s+rm)|git\s+(?:clean|reset))\b/.test(
      args.join(" "),
    )
  ) {
    return [risk("remote", "SSH destructive intent", segment, [], undefined)];
  }
  return [];
}

function uncertain(segment: string): Draft[] {
  return destructiveMarkers.flatMap(([marker, category, effect]) =>
    marker.test(segment)
      ? [
          {
            ...risk(category, effect, segment),
            uncertainty:
              "Unsupported shell syntax; this warning is based only on an exact destructive marker.",
          },
        ]
      : [],
  );
}

export async function assessBashCommand(
  command: string,
  cwd: string,
): Promise<Risk[]> {
  const recovery = createRecoverability(cwd);
  let effectiveCwd = cwd;
  const risks: Risk[] = [];
  for (const segment of splitSegments(command)) {
    const words = tokenize(segment.text);
    const drafts = words
      ? direct(words, segment.text)
      : uncertain(segment.text);
    for (const draft of drafts) {
      if (
        draft.filesystem &&
        draft.targets.length &&
        (await Promise.all(
          draft.targets.map((target) =>
            isRecoverable(
              resolve(effectiveCwd, target),
              draft.filesystem!,
              recovery,
            ),
          ),
        ).then((answers) => answers.every(Boolean)))
      ) {
        continue;
      }
      risks.push({
        ...draft,
        targets: draft.targets.map((target) => resolve(effectiveCwd, target)),
        segmentIndex: segment.index,
      });
    }
    const commandInfo = words && executable(words);
    if (
      commandInfo?.name === "cd" &&
      commandInfo.args[0] &&
      ["&&", ";", "\n", null].includes(segment.separator)
    ) {
      effectiveCwd = resolve(effectiveCwd, commandInfo.args[0]);
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
