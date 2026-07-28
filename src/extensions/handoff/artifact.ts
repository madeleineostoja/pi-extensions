import { randomUUID } from "node:crypto";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  deliveryFromEntry,
  draftFromEntry,
  DRAFT_TYPE,
  sameModel,
  type DraftData,
  type ModelIdentity,
} from "./state";

export type ChildArtifact = {
  path: string;
  sessionId: string;
  draftEntryId: string;
};

type ChildSessionView = Pick<SessionManager, "getHeader" | "getEntries">;

function isInside(directory: string, path: string): boolean {
  const relation = relative(directory, path);
  return (
    relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".."
  );
}

export function assertChildPath(sessionDir: string, childPath: string): void {
  const directory = resolve(sessionDir);
  const path = resolve(childPath);
  if (!isInside(directory, path) || dirname(path) !== directory) {
    throw new Error("Handoff child path escapes its session directory.");
  }
}

function sameDraft(a: DraftData, b: DraftData): boolean {
  return (
    a.version === b.version &&
    a.transitionId === b.transitionId &&
    a.prompt === b.prompt &&
    sameModel(a.source, b.source) &&
    sameModel(a.target, b.target)
  );
}

export function validateChildArtifact(options: {
  manager: ChildSessionView;
  path: string;
  sessionDir: string;
  parentPath: string;
  cwd: string;
  target: ModelIdentity;
  childSessionId?: string;
  draftEntryId?: string;
  draft?: DraftData;
}): ChildArtifact & { draft: DraftData; delivered: boolean } {
  assertChildPath(options.sessionDir, options.path);
  const header = options.manager.getHeader();
  const entries = options.manager.getEntries();
  if (
    !header ||
    header.version !== CURRENT_SESSION_VERSION ||
    header.cwd !== options.cwd ||
    resolve(header.parentSession ?? "") !== resolve(options.parentPath) ||
    (options.childSessionId !== undefined &&
      header.id !== options.childSessionId)
  ) {
    throw new Error("Handoff child session header is invalid.");
  }
  const modelChange = entries[0];
  const draft = draftFromEntry(entries[1] as SessionEntry);
  if (
    !modelChange ||
    modelChange.type !== "model_change" ||
    modelChange.provider !== options.target.provider ||
    modelChange.modelId !== options.target.id ||
    !draft ||
    !sameModel(draft.data.target, options.target) ||
    (options.draftEntryId !== undefined &&
      draft.entry.id !== options.draftEntryId) ||
    (options.draft !== undefined && !sameDraft(draft.data, options.draft))
  ) {
    throw new Error("Handoff child entries are invalid.");
  }
  if (entries.length > 3) {
    throw new Error("Handoff child contains unexpected entries.");
  }
  const delivery = entries[2] && deliveryFromEntry(entries[2]);
  if (
    (entries.length === 3 &&
      (!delivery ||
        delivery.data.transitionId !== draft.data.transitionId ||
        delivery.data.draftEntryId !== draft.entry.id ||
        !sameModel(delivery.data.target, options.target))) ||
    (entries.length === 2 && delivery)
  ) {
    throw new Error("Handoff child delivery state is invalid.");
  }
  return {
    path: options.path,
    sessionId: header.id,
    draftEntryId: draft.entry.id,
    draft: draft.data,
    delivered: entries.length === 3,
  };
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
  const path = manager.getSessionFile();
  if (!path) {
    throw new Error("Handoff child session path is unavailable.");
  }
  const validated = validateChildArtifact({
    manager,
    path,
    sessionDir: options.sessionDir,
    parentPath: options.parentPath,
    cwd: options.cwd,
    target: options.target,
    draftEntryId,
    draft: options.draft,
  });

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
  cwd: string;
  childSessionId: string;
  childDraftEntryId: string;
  target: ModelIdentity;
  draft: DraftData;
}): Promise<void> {
  const manager = SessionManager.open(options.path, options.sessionDir);
  validateChildArtifact({
    manager,
    ...options,
    draftEntryId: options.childDraftEntryId,
  });
  await rm(options.path);
  try {
    await access(options.path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("Handoff child removal could not be verified.");
}
