import { open, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const supportedPlatforms = new Set(["darwin", "linux"]);
const supportedArchitectures = new Set(["arm64", "x64"]);
const retryIntervalMs = 25;

type NativeFileLeaseAddon = {
  tryLock(fd: number): boolean;
  unlock(fd: number): void;
};

type NativeLoad =
  | { kind: "loaded"; addon: NativeFileLeaseAddon }
  | { kind: "failed"; error: FileLeaseUnavailableError };

let nativeLoad: NativeLoad | undefined;
let testHooks: FileLeaseTestHooks | undefined;

type FileLeaseTestHooks = {
  addon: NativeFileLeaseAddon;
  openAnchor(anchorPath: string): Promise<FileHandle>;
};

export function setFileLeaseTestHooks(
  hooks: FileLeaseTestHooks | undefined,
): void {
  testHooks = hooks;
}

export type FileLease = {
  readonly anchorPath: string;
  release(): Promise<void>;
};

export type FileLeaseAcquireOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
};

export type FileLeaseProbe = "free" | "held";

export class FileLeaseUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileLeaseUnavailableError";
  }
}

export class FileLeaseTimeoutError extends Error {
  constructor(anchorPath: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms acquiring the file lease at ${anchorPath}.`,
    );
    this.name = "FileLeaseTimeoutError";
  }
}

export class FileLeaseAbortedError extends Error {
  constructor(anchorPath: string, options?: ErrorOptions) {
    super(`File lease acquisition was aborted for ${anchorPath}.`, options);
    this.name = "FileLeaseAbortedError";
  }
}

export async function tryAcquireFileLease(
  anchorPath: string,
): Promise<FileLease | undefined> {
  const addon = loadNativeAddon();
  const handle = await openPersistentAnchor(anchorPath);
  let locked = false;

  try {
    locked = addon.tryLock(handle.fd);
    if (!locked) {
      return undefined;
    }
    return createLease(anchorPath, handle, addon);
  } finally {
    if (!locked) {
      await handle.close();
    }
  }
}

export async function acquireFileLease(
  anchorPath: string,
  options: FileLeaseAcquireOptions,
): Promise<FileLease> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new RangeError(
      "File lease timeoutMs must be a non-negative finite number.",
    );
  }

  const deadline = performance.now() + options.timeoutMs;
  while (true) {
    throwIfAborted(anchorPath, options.signal);
    const lease = await tryAcquireFileLease(anchorPath);
    if (options.signal?.aborted) {
      if (lease) {
        await lease.release();
      }
      throw new FileLeaseAbortedError(anchorPath, {
        cause: options.signal.reason,
      });
    }
    if (lease) {
      if (performance.now() <= deadline) {
        return lease;
      }
      await lease.release();
      throw new FileLeaseTimeoutError(anchorPath, options.timeoutMs);
    }

    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      throw new FileLeaseTimeoutError(anchorPath, options.timeoutMs);
    }
    await waitForRetry(
      anchorPath,
      Math.min(retryIntervalMs, remainingMs),
      options.signal,
    );
  }
}

export async function probeFileLease(
  anchorPath: string,
): Promise<FileLeaseProbe> {
  const addon = loadNativeAddon();
  const handle = await openPersistentAnchor(anchorPath);
  let locked = false;
  let releaseError: unknown;
  let closeError: unknown;

  try {
    locked = addon.tryLock(handle.fd);
    if (locked) {
      addon.unlock(handle.fd);
    }
  } catch (error) {
    releaseError = error;
  }

  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }

  throwCleanupErrors(
    "Could not close the file lease probe descriptor.",
    releaseError,
    closeError,
  );
  return locked ? "free" : "held";
}

function createLease(
  anchorPath: string,
  handle: FileHandle,
  addon: NativeFileLeaseAddon,
): FileLease {
  let released = false;
  let releasePromise: Promise<void> | undefined;

  return {
    anchorPath,
    release() {
      if (released) {
        return releasePromise!;
      }
      released = true;
      releasePromise = releaseLease(handle, addon);
      return releasePromise;
    },
  };
}

async function releaseLease(
  handle: FileHandle,
  addon: NativeFileLeaseAddon,
): Promise<void> {
  let unlockError: unknown;
  let closeError: unknown;

  try {
    addon.unlock(handle.fd);
  } catch (error) {
    unlockError = error;
  }

  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }

  throwCleanupErrors(
    "Could not release the file lease descriptor.",
    unlockError,
    closeError,
  );
}

function throwCleanupErrors(
  message: string,
  firstError: unknown,
  secondError: unknown,
): void {
  if (firstError && secondError) {
    throw new AggregateError([firstError, secondError], message);
  }
  if (firstError) {
    throw firstError;
  }
  if (secondError) {
    throw secondError;
  }
}

async function openPersistentAnchor(anchorPath: string): Promise<FileHandle> {
  if (testHooks) {
    return testHooks.openAnchor(anchorPath);
  }
  const handle = await open(anchorPath, "a+");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`File lease anchor is not a regular file: ${anchorPath}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function loadNativeAddon(): NativeFileLeaseAddon {
  if (testHooks) {
    return testHooks.addon;
  }
  if (nativeLoad?.kind === "loaded") {
    return nativeLoad.addon;
  }
  if (nativeLoad?.kind === "failed") {
    throw nativeLoad.error;
  }

  if (
    !supportedPlatforms.has(process.platform) ||
    !supportedArchitectures.has(process.arch)
  ) {
    const error = new FileLeaseUnavailableError(
      `File leases require fs-native-extensions on macOS or Linux ARM64/x64; current platform is ${process.platform}/${process.arch}.`,
    );
    nativeLoad = { kind: "failed", error };
    throw error;
  }

  try {
    const candidate: unknown = require("fs-native-extensions");
    if (!isNativeFileLeaseAddon(candidate)) {
      throw new TypeError(
        "fs-native-extensions does not expose tryLock and unlock.",
      );
    }
    nativeLoad = { kind: "loaded", addon: candidate };
    return candidate;
  } catch (cause) {
    const error = new FileLeaseUnavailableError(
      "Could not load fs-native-extensions. File lease operations cannot run unlocked.",
      { cause },
    );
    nativeLoad = { kind: "failed", error };
    throw error;
  }
}

function isNativeFileLeaseAddon(value: unknown): value is NativeFileLeaseAddon {
  return (
    typeof value === "object" &&
    value !== null &&
    "tryLock" in value &&
    typeof value.tryLock === "function" &&
    "unlock" in value &&
    typeof value.unlock === "function"
  );
}

function throwIfAborted(
  anchorPath: string,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw new FileLeaseAbortedError(anchorPath, { cause: signal.reason });
  }
}

function waitForRetry(
  anchorPath: string,
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(anchorPath, signal);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const abortSignal = signal;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    abortSignal.addEventListener("abort", abort, { once: true });

    function done(): void {
      abortSignal.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      clearTimeout(timer);
      reject(
        new FileLeaseAbortedError(anchorPath, { cause: abortSignal.reason }),
      );
    }
  });
}
