import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type AtomicJsonWriteHooks = {
  beforeRename?: (temporaryPath: string, destinationPath: string) => void;
};

export function writeAtomicJson(
  path: string,
  value: unknown,
  hooks: AtomicJsonWriteHooks = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp.${randomBytes(12).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hooks.beforeRename?.(temporaryPath, path);
    renameSync(temporaryPath, path);
    syncDirectory(dirname(path));
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
