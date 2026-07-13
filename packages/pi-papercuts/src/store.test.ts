import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPapercutStore,
  createPapercutStoreForCwd,
  normalizeKey,
  parsePapercutFile,
  type PapercutProposal,
} from "./store.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-papercuts-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function proposal(overrides: Partial<PapercutProposal> = {}): PapercutProposal {
  return {
    key: "devcontainer-validation",
    title: "Validation needs the devcontainer",
    trigger: "Ruby validation runs on the host",
    impact: "Future sessions waste time before finding the container",
    currentGap: "The project has no preflight instruction",
    proposedResolution: "Add a validation preflight",
    suggestedDestination: "agents",
    ...overrides,
  };
}

async function runWorker(
  root: string,
  key: string,
  expectation = "created",
  resultPath?: string,
): Promise<void> {
  const worker = new URL("./store-worker.test.ts", import.meta.url);
  const config = new URL("../vitest.config.ts", import.meta.url);
  const vitest = new URL(
    "../../../node_modules/vitest/vitest.mjs",
    import.meta.url,
  );
  await execFileAsync(
    process.execPath,
    [vitest.pathname, "run", worker.pathname, "--config", config.pathname],
    {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env,
        PAPERCUT_WORKER_ROOT: root,
        PAPERCUT_WORKER_KEY: key,
        PAPERCUT_WORKER_EXPECT: expectation,
        PAPERCUT_WORKER_RESULT: resultPath,
      },
    },
  );
}

function lockOwner(id: string, pid: number, host = hostname()): string {
  return `${JSON.stringify({
    id,
    pid,
    at: "2020-01-01T00:00:00.000Z",
    host,
  })}\n`;
}

function writeLockDirectory(path: string, owner: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner.json"), owner);
}

function readLockDirectory(path: string): string {
  return readFileSync(join(path, "owner.json"), "utf-8");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("papercut store", () => {
  it("creates deterministic checkout-local state and one exact local exclusion", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    await store.initialize();

    expect(
      JSON.parse(readFileSync(join(root, ".pi", "papercuts.json"), "utf-8")),
    ).toEqual({ version: 1, records: [] });
    expect(
      readFileSync(join(root, ".git", "info", "exclude"), "utf-8")
        .split("\n")
        .filter((line) => line === "/.pi/papercuts.json"),
    ).toHaveLength(1);
  });

  it("routes linked worktrees to their own checkout-local registry", async () => {
    const root = repo();
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Papercuts",
        "-c",
        "user.email=papercuts@example.test",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd: root },
    );
    const linked = mkdtempSync(join(tmpdir(), "pi-papercuts-linked-"));
    rmSync(linked, { recursive: true });
    roots.push(linked);
    execFileSync(
      "git",
      ["worktree", "add", "-qb", "papercuts-linked", linked],
      {
        cwd: root,
      },
    );

    const store = await createPapercutStoreForCwd(linked);
    await store.propose(proposal(), { kind: "agent" });

    expect(store.registryPath).toBe(
      join(realpathSync(linked), ".pi", "papercuts.json"),
    );
    expect(existsSync(join(root, ".pi", "papercuts.json"))).toBe(false);
    expect(
      readFileSync(join(root, ".git", "info", "exclude"), "utf-8"),
    ).toContain("/.pi/papercuts.json\n");
  });

  it("merges pending duplicates and preserves ignored and resolved tombstones", async () => {
    const store = createPapercutStore(repo());
    const first = await store.propose(proposal(), {
      kind: "agent",
      sessionId: "one",
    });
    expect(first.kind).toBe("created");
    const merged = await store.propose(proposal(), {
      kind: "agent",
      sessionId: "two",
    });
    expect(merged).toMatchObject({
      kind: "merged",
      record: {
        occurrences: 2,
        sources: [{ sessionId: "one" }, { sessionId: "two" }],
      },
    });

    await store.transition("devcontainer-validation", "ignored", {
      note: "not planned",
    });
    expect((await store.propose(proposal(), { kind: "agent" })).kind).toBe(
      "ignored",
    );
    await store.transition("devcontainer-validation", "pending");
    await store.transition("devcontainer-validation", "resolved", {
      target: "AGENTS.md",
    });
    expect((await store.propose(proposal(), { kind: "agent" })).kind).toBe(
      "resolved",
    );
  });

  it("serializes in-process proposals without losing records", async () => {
    const store = createPapercutStore(repo());
    await Promise.all([
      store.propose(
        proposal({ key: "first-gap", title: "First", trigger: "A" }),
        { kind: "agent" },
      ),
      store.propose(
        proposal({ key: "second-gap", title: "Second", trigger: "B" }),
        { kind: "agent" },
      ),
    ]);
    expect((await store.load()).records.map((record) => record.key)).toEqual([
      "first-gap",
      "second-gap",
    ]);
  });

  it("refuses malformed persistence instead of overwriting it", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    const path = join(root, ".pi", "papercuts.json");
    await store.initialize();
    writeFileSync(path, "not json\n");
    await expect(store.propose(proposal(), { kind: "agent" })).rejects.toThrow(
      "invalid JSON",
    );
    expect(readFileSync(path, "utf-8")).toBe("not json\n");
  });

  it("normalizes stable keys and rejects normalized title-trigger collisions", async () => {
    expect(normalizeKey(" Ruby validation / Devcontainer ")).toBe(
      "ruby-validation-devcontainer",
    );
    expect(() => parsePapercutFile('{"version":2,"records":[]}')).toThrow(
      "unsupported",
    );
    const store = createPapercutStore(repo());
    const created = await store.propose(
      proposal({ key: " Devcontainer Validation " }),
      { kind: "agent" },
    );
    expect(created).toMatchObject({
      kind: "created",
      record: { key: "devcontainer-validation" },
    });
    const result = await store.propose(
      proposal({
        key: "other-key",
        title: " validation needs  the devcontainer ",
        trigger: " ruby validation runs on the host ",
      }),
      { kind: "agent" },
    );
    expect(result.kind).toBe("merged");
  });

  it("canonicalizes persisted keys but rejects persisted duplicate identities", async () => {
    const root = repo();
    const path = join(root, ".pi", "papercuts.json");
    await createPapercutStore(root).initialize();
    const record = {
      ...proposal({ key: " Devcontainer Validation " }),
      status: "pending" as const,
      occurrences: 1,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      sources: [{ kind: "agent" as const }],
    };
    writeFileSync(path, JSON.stringify({ version: 1, records: [record] }));
    expect((await createPapercutStore(root).load()).records[0]?.key).toBe(
      "devcontainer-validation",
    );

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        records: [record, { ...record, key: "other-key" }],
      }),
    );
    await expect(createPapercutStore(root).load()).rejects.toThrow(
      "duplicate title and trigger",
    );
  });

  it("rejects edit collisions and invalid runtime mutation input before persistence", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.propose(proposal(), { kind: "agent" });
    await store.propose(
      proposal({ key: "other", title: "Other", trigger: "Other trigger" }),
      { kind: "user" },
    );
    const before = readFileSync(join(root, ".pi", "papercuts.json"), "utf-8");

    await expect(
      store.edit("other", proposal({ key: "other" })),
    ).rejects.toThrow("already belong");
    await expect(store.transition("other", "invalid")).rejects.toThrow(
      "status must be",
    );
    await expect(store.delete("other", "true")).rejects.toThrow(
      "requires confirmation",
    );
    expect(readFileSync(join(root, ".pi", "papercuts.json"), "utf-8")).toBe(
      before,
    );
    await expect(
      store.propose(proposal(), { kind: "invalid" }),
    ).resolves.toMatchObject({ kind: "rejected" });
  });

  it("persists transitions, edits, and confirmed deletes across store instances", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.propose(proposal(), { kind: "agent" });

    const ignored = await store.transition(
      "devcontainer-validation",
      "ignored",
      {
        note: "Not actionable",
        target: "backlog",
      },
    );
    expect(ignored).toMatchObject({
      status: "ignored",
      disposition: { note: "Not actionable", target: "backlog" },
    });
    const reopened = await store.transition(
      "devcontainer-validation",
      "pending",
    );
    expect(reopened).toMatchObject({
      status: "pending",
      disposition: undefined,
    });
    await store.edit(
      "devcontainer-validation",
      proposal({ title: "Updated validation guidance" }),
    );
    expect((await createPapercutStore(root).load()).records).toMatchObject([
      { key: "devcontainer-validation", title: "Updated validation guidance" },
    ]);
    await store.delete("devcontainer-validation", true);
    expect((await createPapercutStore(root).load()).records).toEqual([]);
  });

  it("serializes independent processes with atomic durable writes", async () => {
    const root = repo();
    await Promise.all(
      ["first", "second", "third", "fourth"].map((key) => runWorker(root, key)),
    );

    const serialized = readFileSync(
      join(root, ".pi", "papercuts.json"),
      "utf-8",
    );
    expect(
      JSON.parse(serialized).records.map(
        (record: { key: string }) => record.key,
      ),
    ).toEqual(["first", "fourth", "second", "third"]);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("serializes competing cross-process takeovers of one dead-owner lock", async () => {
    const root = repo();
    const lockPath = join(root, ".pi", "papercuts.json.lock");
    await createPapercutStore(root).initialize();
    writeLockDirectory(lockPath, lockOwner("dead-owner", 999_999_999));

    await Promise.all([
      runWorker(root, "recovered-first"),
      runWorker(root, "recovered-second"),
      runWorker(root, "recovered-third"),
    ]);

    expect(existsSync(lockPath)).toBe(false);
    expect(
      (await createPapercutStore(root).load()).records.map(
        (record) => record.key,
      ),
    ).toEqual(["recovered-first", "recovered-second", "recovered-third"]);
  });

  it("recovers dead recovery and main locks across concurrent processes", async () => {
    const root = repo();
    const lockPath = join(root, ".pi", "papercuts.json.lock");
    const recoveryPath = `${lockPath}.recovery`;
    const claimPath = `${lockPath}.claim`;
    const store = createPapercutStore(root);
    await store.propose(
      proposal({
        key: "already-present",
        title: "Already present",
        trigger: "Existing record must survive recovery",
      }),
      { kind: "agent" },
    );
    writeLockDirectory(lockPath, lockOwner("dead-main", 999_999_999));
    writeLockDirectory(recoveryPath, lockOwner("dead-recovery", 999_999_998));
    writeLockDirectory(claimPath, lockOwner("dead-claim", 999_999_997));

    await Promise.all(
      ["handoff-first", "handoff-second", "handoff-third"].map((key) =>
        runWorker(root, key),
      ),
    );

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
    expect((await store.load()).records.map((record) => record.key)).toEqual([
      "already-present",
      "handoff-first",
      "handoff-second",
      "handoff-third",
    ]);
  });

  it("does not steal live or unverifiable locks in another process", async () => {
    const liveRoot = repo();
    const malformedRoot = repo();
    const foreignRoot = repo();
    await Promise.all(
      [liveRoot, malformedRoot, foreignRoot].map((root) =>
        createPapercutStore(root).initialize(),
      ),
    );
    writeLockDirectory(
      join(liveRoot, ".pi", "papercuts.json.lock"),
      lockOwner("live-owner", process.pid),
    );
    writeFileSync(
      join(malformedRoot, ".pi", "papercuts.json.lock"),
      "not lock metadata",
    );
    writeLockDirectory(
      join(foreignRoot, ".pi", "papercuts.json.lock"),
      lockOwner("foreign-owner", 999_999_999, "another-host"),
    );

    await Promise.all(
      [liveRoot, malformedRoot, foreignRoot].map((root, index) =>
        runWorker(root, `blocked-${index}`, "blocked"),
      ),
    );

    expect(
      readLockDirectory(join(liveRoot, ".pi", "papercuts.json.lock")),
    ).toContain("live-owner");
    expect(
      readFileSync(join(malformedRoot, ".pi", "papercuts.json.lock"), "utf-8"),
    ).toBe("not lock metadata");
    expect(
      readLockDirectory(join(foreignRoot, ".pi", "papercuts.json.lock")),
    ).toContain("foreign-owner");
  });

  it("does not replace a lock while another process owns recovery or claim", async () => {
    const recoveryRoot = repo();
    const claimRoot = repo();
    const recoveryLockPath = join(recoveryRoot, ".pi", "papercuts.json.lock");
    const claimLockPath = join(claimRoot, ".pi", "papercuts.json.lock");
    await Promise.all([
      createPapercutStore(recoveryRoot).initialize(),
      createPapercutStore(claimRoot).initialize(),
    ]);
    writeLockDirectory(recoveryLockPath, lockOwner("dead-owner", 999_999_999));
    writeLockDirectory(
      `${recoveryLockPath}.recovery`,
      lockOwner("live-recovery", process.pid),
    );
    writeLockDirectory(claimLockPath, lockOwner("dead-owner", 999_999_999));
    writeLockDirectory(
      `${claimLockPath}.claim`,
      lockOwner("live-claim", process.pid),
    );

    await Promise.all([
      runWorker(recoveryRoot, "recovery-contender", "blocked"),
      runWorker(claimRoot, "claim-contender", "blocked"),
    ]);

    expect(readLockDirectory(recoveryLockPath)).toContain("dead-owner");
    expect(readLockDirectory(`${recoveryLockPath}.recovery`)).toContain(
      "live-recovery",
    );
    expect(readLockDirectory(claimLockPath)).toContain("dead-owner");
    expect(readLockDirectory(`${claimLockPath}.claim`)).toContain("live-claim");
  });

  it("bounds cross-process acquisition when another process owns the lock", async () => {
    const root = repo();
    const lockPath = join(root, ".pi", "papercuts.json.lock");
    const resultPath = join(root, "elapsed");
    await createPapercutStore(root).initialize();
    writeLockDirectory(lockPath, lockOwner("live-owner", process.pid));

    await runWorker(root, "blocked", "blocked", resultPath);

    const elapsed = Number(readFileSync(resultPath, "utf-8"));
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(5_000);
    expect(readLockDirectory(lockPath)).toContain("live-owner");
  });

  it("serializes cross-process recovery of an orphaned marker without stealing a live one", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    const recoveryPath = join(root, ".pi", "papercuts.json.lock.recovery");
    writeLockDirectory(recoveryPath, lockOwner("dead-recovery", 999_999_999));

    await Promise.all([
      runWorker(root, "marker-first"),
      runWorker(root, "marker-second"),
      runWorker(root, "marker-third"),
    ]);
    expect(() => readFileSync(recoveryPath, "utf-8")).toThrow();
    expect((await store.load()).records.map((record) => record.key)).toEqual([
      "marker-first",
      "marker-second",
      "marker-third",
    ]);

    writeLockDirectory(recoveryPath, lockOwner("live-recovery", process.pid));
    await expect(
      store.propose(
        proposal({
          key: "blocked-recovery",
          title: "Blocked recovery",
          trigger: "Blocked",
        }),
        { kind: "agent" },
      ),
    ).rejects.toThrow("active or unverifiable");
    expect(readLockDirectory(recoveryPath)).toContain("live-recovery");
  });
});
