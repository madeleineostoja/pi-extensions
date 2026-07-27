import { execa } from "execa";
import PQueue from "p-queue";

export type ProcessFailureKind =
  | "lock_busy"
  | "conflict"
  | "hook_failed"
  | "target_moved"
  | "dirty_checkout"
  | "active_operation"
  | "missing_object"
  | "ownership_mismatch"
  | "cancelled"
  | "timed_out"
  | "unknown";

export type GitProcessResult = {
  command: string;
  cwd: string;
  exitCode: number;
  signal?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  failureKind?: ProcessFailureKind;
  cause?: unknown;
  stdout: string;
  stderr: string;
  startedAt: string;
  durationMs: number;
};

export type GitProcessFailure = GitProcessResult & {
  kind: ProcessFailureKind;
  cause: unknown;
};

export class GitProcessError extends Error {
  constructor(readonly failure: GitProcessFailure) {
    super(
      `${failure.command} failed (${failure.kind}): ${failure.stderr || failure.stdout}`,
      { cause: failure.cause },
    );
    this.name = "GitProcessError";
  }
}

export type ProcessOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  signal?: AbortSignal;
  shell?: boolean;
};

export type GitProcessOptions = ProcessOptions & {
  allowFailure?: boolean;
  retry?: "idempotent";
  scope?: "checkout" | "repository";
};

type RepositoryIdentity = {
  checkoutGitDir: string;
  commonGitDir: string;
};

const checkoutQueues = new Map<string, PQueue>();
const repositoryQueues = new Map<string, PQueue>();

function queueFor(queues: Map<string, PQueue>, key: string): PQueue {
  let queue = queues.get(key);
  if (!queue) {
    queue = new PQueue({ concurrency: 1 });
    queues.set(key, queue);
  }
  return queue;
}

export async function runCommand(
  file: string,
  args: string[],
  options: ProcessOptions,
): Promise<GitProcessResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const result = await execa(file, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    input: options.input,
    timeout: options.timeout,
    cancelSignal: options.signal,
    killDescendants: true,
    shell: options.shell,
    reject: false,
    stripFinalNewline: false,
    all: false,
    buffer: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    command: [file, ...args].join(" "),
    cwd: options.cwd,
    exitCode: result.exitCode ?? 1,
    signal: result.signal,
    timedOut: result.timedOut || undefined,
    cancelled: result.isCanceled || undefined,
    cause: result.exitCode === 0 ? undefined : result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    startedAt,
    durationMs: Date.now() - started,
  };
}

export type GitProcessHooks = {
  retryDelay?: (milliseconds: number) => Promise<void>;
};

export class GitProcess {
  private identityPromise: Promise<RepositoryIdentity> | undefined;

  constructor(
    private readonly cwd: string,
    private readonly hooks: GitProcessHooks = {},
  ) {}

  async run(
    args: string[],
    options: GitProcessOptions,
  ): Promise<GitProcessResult> {
    const identity = await this.identity();
    const queue =
      options.scope === "repository"
        ? queueFor(repositoryQueues, identity.commonGitDir)
        : queueFor(checkoutQueues, identity.checkoutGitDir);
    return queue.add(() =>
      this.runWithRetry(args, options),
    ) as Promise<GitProcessResult>;
  }

  async onIdle(): Promise<void> {
    const identity = await this.identity();
    await Promise.all([
      queueFor(checkoutQueues, identity.checkoutGitDir).onIdle(),
      queueFor(repositoryQueues, identity.commonGitDir).onIdle(),
    ]);
  }

  async inRepository<T>(
    operation: (commonGitDir: string) => Promise<T> | T,
  ): Promise<T> {
    const identity = await this.identity();
    return queueFor(repositoryQueues, identity.commonGitDir).add(() =>
      operation(identity.commonGitDir),
    ) as Promise<T>;
  }

  private async identity(): Promise<RepositoryIdentity> {
    this.identityPromise ??= (async () => {
      const result = await this.execute(
        [
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
          "--git-common-dir",
        ],
        { cwd: this.cwd },
      );
      if (result.exitCode !== 0) {
        throw new GitProcessError({
          ...result,
          kind: classifyFailure(result),
          cause:
            result.cause ??
            new Error(result.stderr || result.stdout || "Git command failed"),
        });
      }
      const [checkoutGitDir, commonGitDir] = result.stdout.trim().split("\n");
      if (!checkoutGitDir || !commonGitDir) {
        throw new Error(
          "git did not return checkout and common directory identities",
        );
      }
      return { checkoutGitDir, commonGitDir };
    })();
    return this.identityPromise;
  }

  private async runWithRetry(
    args: string[],
    options: GitProcessOptions,
  ): Promise<GitProcessResult> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.execute(args, options);
      if (result.exitCode === 0) {
        return result;
      }
      const kind = classifyFailure(result);
      if (options.allowFailure) {
        return {
          ...result,
          failureKind: kind,
          cause:
            result.cause ??
            new Error(result.stderr || result.stdout || "Git command failed"),
        };
      }
      if (
        options.retry === "idempotent" &&
        kind === "lock_busy" &&
        attempt < 2
      ) {
        await (this.hooks.retryDelay ?? delay)(25 * (attempt + 1));
        continue;
      }
      throw new GitProcessError({
        ...result,
        kind,
        cause:
          result.cause ??
          new Error(result.stderr || result.stdout || "Git command failed"),
      });
    }
  }

  private async execute(
    args: string[],
    options: Pick<
      GitProcessOptions,
      "cwd" | "env" | "input" | "timeout" | "signal"
    >,
  ): Promise<GitProcessResult> {
    return runCommand("git", args, options);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function classifyFailure(
  result: Pick<
    GitProcessResult,
    "stderr" | "stdout" | "signal" | "timedOut" | "cancelled"
  >,
): ProcessFailureKind {
  const evidence = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (result.timedOut) {
    return "timed_out";
  }
  if (result.cancelled || result.signal) {
    return "cancelled";
  }
  if (
    /index\.lock|another git process|cannot lock ref|unable to create .*\.lock/.test(
      evidence,
    )
  ) {
    return "lock_busy";
  }
  if (
    /would be overwritten by checkout|local changes.*overwritten|dirty/.test(
      evidence,
    )
  ) {
    return "dirty_checkout";
  }
  if (/would be overwritten|merge conflict|conflict/.test(evidence)) {
    return "conflict";
  }
  if (/hook .* failed|hook declined/.test(evidence)) {
    return "hook_failed";
  }
  if (/not a valid object name|bad object|unknown revision/.test(evidence)) {
    return "missing_object";
  }
  if (/not possible to fast-forward|non-fast-forward/.test(evidence)) {
    return "target_moved";
  }
  if (
    /cherry-pick.*in progress|merge.*in progress|rebase.*in progress/.test(
      evidence,
    )
  ) {
    return "active_operation";
  }
  return "unknown";
}
