import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SessionManager,
  type ExtensionContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const LOOKUP_TIMEOUT_MS = 700;
const MAX_RECENT_SESSIONS = 3;
const MAX_RECENT_COMMITS = 3;
const MAX_TEXT_LENGTH = 120;

export type RecentSession = {
  title: string;
  modified: Date;
};

export type RecentCommit = {
  subject: string;
  timestamp: Date;
};

export type PersonalityContext = {
  branch: string | undefined;
  changedFileCount: number;
  changedAreas: string[];
  recentSessions: RecentSession[];
  recentCommits: RecentCommit[];
};

const EMPTY_CONTEXT: PersonalityContext = {
  branch: undefined,
  changedFileCount: 0,
  changedAreas: [],
  recentSessions: [],
  recentCommits: [],
};

export async function collectPersonalityContext(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<PersonalityContext> {
  if (signal?.aborted || !ctx.cwd || !ctx.sessionManager) {
    return EMPTY_CONTEXT;
  }
  const lookup = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, lookup.signal])
    : lookup.signal;
  const timeout = setTimeout(() => lookup.abort(), LOOKUP_TIMEOUT_MS);
  let sessions: RecentSession[] | undefined;
  let branch: string | undefined;
  let status: string | undefined;
  let commits: string | undefined;
  try {
    [sessions, branch, status, commits] = await Promise.all([
      settled(() => recentSessions(ctx), combinedSignal),
      settled(() => git(ctx.cwd, ["branch", "--show-current"], combinedSignal)),
      settled(() =>
        git(ctx.cwd, ["status", "--porcelain=v1", "-z"], combinedSignal),
      ),
      settled(() =>
        git(ctx.cwd, ["log", "-3", "--format=%s%x1f%cI%x1e"], combinedSignal),
      ),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  const changed = changedFiles(status ?? "");
  return {
    branch: normalizeText(branch ?? ""),
    changedFileCount: changed.count,
    changedAreas: changed.areas,
    recentSessions: sessions ?? [],
    recentCommits: parseRecentCommits(commits ?? ""),
  };
}

async function recentSessions(ctx: ExtensionContext): Promise<RecentSession[]> {
  const currentId = ctx.sessionManager.getSessionId?.();
  const sessions = await SessionManager.list(ctx.cwd);
  return sessions
    .filter((session) => !currentId || session.id !== currentId)
    .sort((left, right) => right.modified.getTime() - left.modified.getTime())
    .map(toRecentSession)
    .filter((session): session is RecentSession => session !== undefined)
    .slice(0, MAX_RECENT_SESSIONS);
}

function toRecentSession(session: SessionInfo): RecentSession | undefined {
  const title = normalizeText(session.name || session.firstMessage);
  if (!title || !Number.isFinite(session.modified.getTime())) {
    return undefined;
  }
  return { title, modified: session.modified };
}

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16_384,
    signal,
  });
  return stdout;
}

async function settled<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) {
    return undefined;
  }
  let timeout: number | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(resolve, LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function changedFiles(output: string): {
  count: number;
  areas: string[];
} {
  const entries = output.split("\0");
  let count = 0;
  const areas: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    count++;
    addArea(areas, path);
    if (
      status[0] === "R" ||
      status[0] === "C" ||
      status[1] === "R" ||
      status[1] === "C"
    ) {
      index++;
    }
  }
  return { count, areas: areas.slice(0, 3) };
}

function addArea(areas: string[], path: string): void {
  const normalized = normalizeText(path);
  if (!normalized) {
    return;
  }
  const [first, second] = normalized.split("/");
  const area = second ? `${first}/${second}` : first;
  if (area && !areas.includes(area)) {
    areas.push(area);
  }
}

export function parseRecentCommits(output: string): RecentCommit[] {
  return output
    .split("\x1e")
    .map((record) => record.split("\x1f"))
    .map(([subject, timestamp]) => ({
      subject: normalizeText(subject ?? ""),
      timestamp: new Date(timestamp ?? ""),
    }))
    .filter(
      (commit): commit is RecentCommit =>
        Boolean(commit.subject) && Number.isFinite(commit.timestamp.getTime()),
    )
    .slice(0, MAX_RECENT_COMMITS);
}

export function normalizeText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, MAX_TEXT_LENGTH).trimEnd();
}

export function compactRelativeTime(timestamp: Date, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp.getTime()) / 60_000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
