import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type AtomicFileWriteHooks = {
  beforeRename?: (temporaryPath: string, destinationPath: string) => void;
};

export function writeAtomicFile(
  path: string,
  content: string,
  hooks: AtomicFileWriteHooks = {},
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${path}.tmp.${randomBytes(12).toString("hex")}`;
  const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, content, "utf-8");
    chmodSync(temporaryPath, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hooks.beforeRename?.(temporaryPath, path);
    renameSync(temporaryPath, path);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}
