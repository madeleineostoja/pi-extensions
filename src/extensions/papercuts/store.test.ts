import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const children: ChildProcess[] = [];
const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(
  new URL("./store-worker.cjs", import.meta.url),
);

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

async function runWorker(root: string, key: string): Promise<void> {
  await execFileAsync(process.execPath, [workerPath, "propose", root, key]);
}

async function startLockHolder(anchorPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [workerPath, "hold", anchorPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Lock holder did not start for ${anchorPath}.`)),
      2_000,
    );
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf-8").includes("ready\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      reject(new Error(`Lock holder failed: ${chunk.toString("utf-8")}`));
    });
  });
  return child;
}

async function stop(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill(signal);
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Lock holder did not exit.")), 2_000),
    ),
  ]);
}

async function startStreamingWriter(root: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [workerPath, "stream", root, "stream"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Streaming writer did not start for ${root}.`)),
      2_000,
    );
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf-8").includes("ready\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      reject(new Error(`Streaming writer failed: ${chunk.toString("utf-8")}`));
    });
  });
  return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
  if (child.exitCode !== 0) {
    throw new Error(
      `Worker exited with ${child.exitCode ?? child.signalCode}.`,
    );
  }
}

function excludeEntries(root: string, pattern: string): string[] {
  return readFileSync(join(root, ".git", "info", "exclude"), "utf-8")
    .split("\n")
    .filter((line) => line === pattern);
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stop(child)));
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("papercut store", () => {
  it("creates idempotent checkout-local state and exclusions", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    await store.initialize();

    expect(
      JSON.parse(readFileSync(join(root, ".pi", "papercuts.json"), "utf-8")),
    ).toEqual({ version: 1, records: [] });
    expect(statSync(join(root, ".pi", "papercuts.lock")).isFile()).toBe(true);
    expect(excludeEntries(root, "/.pi/papercuts.json")).toHaveLength(1);
    expect(excludeEntries(root, "/.pi/papercuts.lock")).toHaveLength(1);
  });

  it("routes linked worktrees to independent checkout-local state", async () => {
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
    expect(existsSync(join(linked, ".pi", "papercuts.lock"))).toBe(true);
    expect(excludeEntries(root, "/.pi/papercuts.json")).toHaveLength(1);
    expect(excludeEntries(root, "/.pi/papercuts.lock")).toHaveLength(1);
  });

  it("merges duplicates and preserves status changes across store instances", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    expect(
      await store.propose(proposal(), { kind: "agent", sessionId: "one" }),
    ).toMatchObject({ kind: "created" });
    expect(
      await store.propose(proposal(), { kind: "agent", sessionId: "two" }),
    ).toMatchObject({
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
    await store.edit(
      "devcontainer-validation",
      proposal({ title: "Updated validation guidance" }),
    );
    expect((await createPapercutStore(root).load()).records).toMatchObject([
      { key: "devcontainer-validation", title: "Updated validation guidance" },
    ]);
    await store.delete("devcontainer-validation", true);
    expect((await store.load()).records).toEqual([]);
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

  it("rejects invalid persistence and mutation input without overwriting data", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    const path = join(root, ".pi", "papercuts.json");
    await store.initialize();
    writeFileSync(path, "not json\n");
    await expect(store.propose(proposal(), { kind: "agent" })).rejects.toThrow(
      "invalid JSON",
    );
    expect(readFileSync(path, "utf-8")).toBe("not json\n");
    expect(normalizeKey(" Ruby validation / Devcontainer ")).toBe(
      "ruby-validation-devcontainer",
    );
    expect(() => parsePapercutFile('{"version":2,"records":[]}')).toThrow(
      "unsupported",
    );
  });

  it("preserves valid records when runtime mutation input is rejected", async () => {
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
  });

  it("serializes independent processes without losing records", async () => {
    const root = repo();
    await Promise.all(
      ["first", "second", "third", "fourth"].map((key) => runWorker(root, key)),
    );

    expect(
      (await createPapercutStore(root).load()).records.map(
        (record) => record.key,
      ),
    ).toEqual(["first", "fourth", "second", "third"]);
  });

  it("loads only complete registries while a concurrent writer publishes", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    const writer = await startStreamingWriter(root);
    let reads = 0;

    while (writer.exitCode === null && writer.signalCode === null) {
      await expect(store.load()).resolves.toMatchObject({ version: 1 });
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await waitForExit(writer);
    expect(reads).toBeGreaterThan(0);
  });

  it("bounds a live contender with the shared file lease", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    const holder = await startLockHolder(join(root, ".pi", "papercuts.lock"));

    const startedAt = Date.now();
    await expect(runWorker(root, "blocked")).rejects.toThrow(
      /Timed out.*file lease/,
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await stop(holder);
  });

  it("releases after a killed owner without replacing the persistent anchor", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    const anchorPath = join(root, ".pi", "papercuts.lock");
    const inode = statSync(anchorPath).ino;
    const holder = await startLockHolder(anchorPath);

    await stop(holder, "SIGKILL");
    await runWorker(root, "after-crash");

    expect(statSync(anchorPath).ino).toBe(inode);
    expect((await store.load()).records.map((record) => record.key)).toEqual([
      "after-crash",
    ]);
  });
});
