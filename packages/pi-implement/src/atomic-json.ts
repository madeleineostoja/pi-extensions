import { writeAtomicFile, type AtomicFileWriteHooks } from "./atomic-file.js";

export type AtomicJsonWriteHooks = AtomicFileWriteHooks;

export function writeAtomicJson(
  path: string,
  value: unknown,
  hooks: AtomicJsonWriteHooks = {},
): void {
  writeAtomicFile(path, `${JSON.stringify(value, null, 2)}\n`, hooks);
}
