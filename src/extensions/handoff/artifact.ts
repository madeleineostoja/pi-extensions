import { randomUUID } from "node:crypto";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { DRAFT_TYPE, type DraftData, type ModelIdentity } from "./state";

export type ChildArtifact = {
  path: string;
  sessionId: string;
  draftEntryId: string;
};

function isInside(directory: string, path: string): boolean {
  const relation = relative(directory, path);
  return (
    relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".."
  );
}

function assertChildPath(sessionDir: string, childPath: string): void {
  const directory = resolve(sessionDir);
  const path = resolve(childPath);
  if (!isInside(directory, path) || dirname(path) !== directory) {
    throw new Error("Handoff child path escapes its session directory.");
  }
}

function validateChild(
  manager: SessionManager,
  parentPath: string,
  cwd: string,
  target: ModelIdentity,
  draft: DraftData,
): { path: string; sessionId: string; draftEntryId: string } {
  const path = manager.getSessionFile();
  const header = manager.getHeader();
  const entries = manager.getEntries();
  if (!path || !header || header.version !== CURRENT_SESSION_VERSION) {
    throw new Error("Handoff child session header is invalid.");
  }
  if (
    header.cwd !== cwd ||
    resolve(header.parentSession ?? "") !== resolve(parentPath)
  ) {
    throw new Error("Handoff child lineage is invalid.");
  }
  const modelChange = entries[0];
  const draftEntry = entries[1];
  if (
    entries.length !== 2 ||
    modelChange?.type !== "model_change" ||
    modelChange.provider !== target.provider ||
    modelChange.modelId !== target.id ||
    draftEntry?.type !== "custom" ||
    draftEntry.customType !== DRAFT_TYPE ||
    draftEntry.data !== draft
  ) {
    throw new Error("Handoff child entries are invalid.");
  }
  return { path, sessionId: header.id, draftEntryId: draftEntry.id };
}

export async function createChildArtifact(options: {
  cwd: string;
  sessionDir: string;
  parentPath: string;
  target: ModelIdentity;
  draft: DraftData;
}): Promise<ChildArtifact> {
  const manager = SessionManager.create(options.cwd, options.sessionDir, {
    parentSession: options.parentPath,
  });
  manager.appendModelChange(options.target.provider, options.target.id);
  const draftEntryId = manager.appendCustomEntry(DRAFT_TYPE, options.draft);
  const validated = validateChild(
    manager,
    options.parentPath,
    options.cwd,
    options.target,
    options.draft,
  );
  if (validated.draftEntryId !== draftEntryId) {
    throw new Error("Handoff child draft identity is invalid.");
  }
  assertChildPath(options.sessionDir, validated.path);

  const destination = resolve(validated.path);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(temporary, "wx", 0o600);
  try {
    const serialized = [manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await handle.writeFile(`${serialized}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  return validated;
}

export async function removeChildArtifact(options: {
  path: string;
  sessionDir: string;
  parentPath: string;
  childSessionId: string;
}): Promise<void> {
  assertChildPath(options.sessionDir, options.path);
  const manager = SessionManager.open(options.path, options.sessionDir);
  const header = manager.getHeader();
  if (
    !header ||
    header.id !== options.childSessionId ||
    resolve(header.parentSession ?? "") !== resolve(options.parentPath)
  ) {
    throw new Error("Refusing to remove an unrelated handoff child.");
  }
  await rm(options.path);
  try {
    await access(options.path);
  } catch {
    return;
  }
  throw new Error("Handoff child removal could not be verified.");
}

export function childDraftEntries(entries: SessionEntry[]) {
  return entries.filter(
    (entry): entry is Extract<SessionEntry, { type: "custom" }> =>
      entry.type === "custom" && entry.customType === DRAFT_TYPE,
  );
}
