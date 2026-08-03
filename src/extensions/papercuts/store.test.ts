import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  parsePapercutFile,
  type PapercutObservation,
} from "./store.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("./store-worker.cjs", import.meta.url),
);
const execFileAsync = promisify(execFile);

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-papercuts-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function observation(
  overrides: Partial<PapercutObservation> = {},
): PapercutObservation {
  return {
    key: "validation-convention",
    title: "Undocumented validation convention",
    task: "Implement the unrelated change",
    incident: "Validation convention required discovery.",
    evidence: "Package scripts and CI disagreed with the guide.",
    workarounds: ["Inspected scripts and CI.", "Ran the discovered command."],
    taskOutcome: "Validation completed safely.",
    suggestedDestination: "docs",
    ...overrides,
  };
}

async function worker(root: string, key: string, mode = "record") {
  await execFileAsync(process.execPath, [workerPath, mode, root, key]);
}

async function streamWhileReading(root: string, key: string): Promise<number> {
  const child = spawn(process.execPath, [workerPath, "stream", root, key]);
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("ready\n")) {
        resolve();
      }
    });
    child.once("error", reject);
    child.stderr.on("data", (chunk: Buffer) =>
      reject(new Error(chunk.toString())),
    );
  });
  const store = createPapercutStore(root);
  let reads = 0;
  while (child.exitCode === null) {
    await store.load();
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (child.exitCode !== 0) {
    throw new Error("Stream writer failed.");
  }
  return reads;
}

function persistedRecord(overrides: Record<string, unknown> = {}) {
  return {
    key: "validation-convention",
    title: "Undocumented validation convention",
    task: "Implement the unrelated change",
    incident: "Validation convention required discovery.",
    evidence: "Package scripts and CI disagreed with the guide.",
    workarounds: ["Inspected scripts and CI."],
    taskOutcome: "Validation completed safely.",
    status: "open",
    occurrences: 1,
    firstSeenAt: "2025-01-01T00:00:00.000Z",
    lastSeenAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function persistedFile(records = [persistedRecord()]) {
  return JSON.stringify({ version: 2, records });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("papercut incident store", () => {
  it("rejects every unsupported bounded persisted-state shape", () => {
    const cases = [
      "{",
      JSON.stringify({ version: 1, records: [] }),
      JSON.stringify({ version: 3, records: [] }),
      JSON.stringify({ version: 2, records: [], unexpected: true }),
      persistedFile([
        persistedRecord(),
        persistedRecord({ key: "validation-convention" }),
      ]),
      persistedFile([persistedRecord({ unexpected: true })]),
      persistedFile(
        Array.from({ length: 257 }, (_, index) =>
          persistedRecord({ key: `finding-${index}` }),
        ),
      ),
      persistedFile([persistedRecord({ key: "Invalid-key" })]),
      persistedFile([persistedRecord({ title: " " })]),
      persistedFile([persistedRecord({ title: "x".repeat(121) })]),
      persistedFile([persistedRecord({ task: "x".repeat(1_001) })]),
      persistedFile([persistedRecord({ incident: "x".repeat(2_001) })]),
      persistedFile([persistedRecord({ evidence: "x".repeat(2_001) })]),
      persistedFile([persistedRecord({ workarounds: [] })]),
      persistedFile([persistedRecord({ workarounds: [" "] })]),
      persistedFile([persistedRecord({ workarounds: ["x".repeat(1_001)] })]),
      persistedFile([persistedRecord({ workarounds: Array(6).fill("done") })]),
      persistedFile([persistedRecord({ taskOutcome: "x".repeat(1_001) })]),
      persistedFile([persistedRecord({ guardrailCandidate: " " })]),
      persistedFile([persistedRecord({ status: "resolved" })]),
      persistedFile([persistedRecord({ occurrences: 0 })]),
      persistedFile([persistedRecord({ occurrences: 2_147_483_648 })]),
      persistedFile([persistedRecord({ firstSeenAt: "2025-01-01T00:00:00Z" })]),
      persistedFile([persistedRecord({ suggestedDestination: "other" })]),
    ];
    for (const text of cases) {
      expect(() => parsePapercutFile(text)).toThrow();
    }
  });

  it("persists version 2 incidents and merges a closed recurrence", async () => {
    const store = createPapercutStore(repo());
    expect(await store.record(observation())).toMatchObject({
      kind: "created",
      record: { status: "open", occurrences: 1 },
    });
    await store.close("validation-convention");
    const result = await store.record(
      observation({
        incident: "The convention was still undocumented.",
        guardrailCandidate: "Document the command.",
      }),
    );
    expect(result).toMatchObject({
      kind: "reopened",
      record: {
        key: "validation-convention",
        title: "Undocumented validation convention",
        status: "open",
        occurrences: 2,
        incident: "The convention was still undocumented.",
      },
    });
    expect((await store.load()).records[0]).not.toHaveProperty("sources");
  });

  it("replaces the latest open observation and clears omitted optionals", async () => {
    const store = createPapercutStore(repo());
    const first = await store.record(
      observation({ guardrailCandidate: "Document it." }),
    );
    const result = await store.record(
      observation({
        key: "  validation-convention  ",
        title: "A replacement title is retained only as evidence of merge",
        task: "A later task",
        incident: "A later observed incident.",
        evidence: "Later concrete evidence.",
        workarounds: ["Used a different detour."],
        taskOutcome: "Later task continued.",
        suggestedDestination: undefined,
      }),
    );
    expect(result).toMatchObject({
      kind: "merged",
      record: {
        key: "validation-convention",
        title: "Undocumented validation convention",
        task: "A later task",
        incident: "A later observed incident.",
        workarounds: ["Used a different detour."],
        occurrences: 2,
        firstSeenAt: (first as any).record.firstSeenAt,
      },
    });
    expect((await store.load()).records[0]).not.toHaveProperty(
      "guardrailCandidate",
    );
    expect((await store.load()).records[0]).not.toHaveProperty(
      "suggestedDestination",
    );
  });

  it("leaves valid state unchanged when record or occurrence capacity is exhausted", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    const records = Array.from({ length: 256 }, (_, index) =>
      persistedRecord({ key: `finding-${index}` }),
    );
    writeFileSync(store.registryPath, persistedFile(records));
    const beforeRecords = readFileSync(store.registryPath, "utf8");
    await expect(
      store.record(observation({ key: "overflow" })),
    ).rejects.toThrow("record limit");
    expect(readFileSync(store.registryPath, "utf8")).toBe(beforeRecords);

    writeFileSync(
      store.registryPath,
      persistedFile([persistedRecord({ occurrences: 2_147_483_647 })]),
    );
    const beforeOccurrences = readFileSync(store.registryPath, "utf8");
    await expect(store.record(observation())).rejects.toThrow(
      "occurrence limit",
    );
    expect(readFileSync(store.registryPath, "utf8")).toBe(beforeOccurrences);
  });

  it("leaves a valid near-limit registry unchanged when a mutation exceeds bytes", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    const records: ReturnType<typeof persistedRecord>[] = [];
    const large = (key: string) =>
      persistedRecord({
        key,
        title: "t".repeat(120),
        task: "t".repeat(1_000),
        incident: "i".repeat(2_000),
        evidence: "e".repeat(2_000),
        workarounds: ["w".repeat(1_000)],
        taskOutcome: "o".repeat(1_000),
      });
    while (
      Buffer.byteLength(
        persistedFile([...records, large(`finding-${records.length}`)]),
        "utf8",
      ) <= 1_047_500
    ) {
      records.push(large(`finding-${records.length}`));
    }
    writeFileSync(store.registryPath, persistedFile(records));
    const before = readFileSync(store.registryPath, "utf8");
    await expect(
      store.record(
        observation({
          key: "one-more",
          title: "t".repeat(120),
          task: "t".repeat(1_000),
          incident: "i".repeat(2_000),
          evidence: "e".repeat(2_000),
          workarounds: ["w".repeat(1_000)],
          taskOutcome: "o".repeat(1_000),
        }),
      ),
    ).rejects.toThrow("size limit");
    expect(readFileSync(store.registryPath, "utf8")).toBe(before);
  });

  it("serializes in-process observations without losing records", async () => {
    const store = createPapercutStore(repo());
    await Promise.all(
      ["one", "two", "three"].map((key) => store.record(observation({ key }))),
    );
    expect((await store.load()).records.map((record) => record.key)).toEqual([
      "one",
      "three",
      "two",
    ]);
  });

  it("never exposes partial state while an atomic process writer publishes", async () => {
    expect(await streamWhileReading(repo(), "stream")).toBeGreaterThan(0);
  });

  it("serializes primary and linked process writers through one registry", async () => {
    const root = repo();
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, "add", "README.md");
    git(
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "initial",
    );
    const linked = mkdtempSync(
      join(tmpdir(), "pipkin-papercuts-process-linked-"),
    );
    rmSync(linked, { recursive: true });
    roots.push(linked);
    git(root, "worktree", "add", "-qb", "process-linked", linked);

    await Promise.all([
      worker(root, "primary-process"),
      worker(linked, "linked-process", "record-cwd"),
    ]);
    expect(
      (await createPapercutStore(root).load()).records.map(
        (record) => record.key,
      ),
    ).toEqual(["linked-process", "primary-process"]);
  });

  it("uses one primary-worktree registry for linked worktrees", async () => {
    const root = repo();
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd: root },
    );
    const linked = mkdtempSync(join(tmpdir(), "pipkin-papercuts-linked-"));
    rmSync(linked, { recursive: true });
    roots.push(linked);
    execFileSync("git", ["worktree", "add", "-qb", "linked", linked], {
      cwd: root,
    });
    const store = await createPapercutStoreForCwd(linked);
    await store.record(observation());
    await store.initialize();
    expect(store.registryPath).toBe(
      join(realpathSync(root), ".pi", "pipkin", "papercuts.json"),
    );
    expect(existsSync(join(linked, ".pi"))).toBe(false);
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/\/.pi\/pipkin\/papercuts\.json/g)).toHaveLength(1);
    expect(exclude.match(/\/.pi\/pipkin\/papercuts\.lock/g)).toHaveLength(1);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(git(linked, "status", "--porcelain")).toBe("");
    git(root, "worktree", "remove", "--force", linked);
    expect((await createPapercutStore(root).load()).records).toHaveLength(1);
  });

  it("rejects malformed or oversized state without overwriting it", async () => {
    const root = repo();
    const store = createPapercutStore(root);
    await store.initialize();
    writeFileSync(store.registryPath, '{"version":1,"records":[]}');
    await expect(store.record(observation())).rejects.toThrow("unsupported");
    expect(readFileSync(store.registryPath, "utf8")).toBe(
      '{"version":1,"records":[]}',
    );
    expect(() => parsePapercutFile("x".repeat(1_048_577))).toThrow(
      "size limit",
    );
  });

  it("serializes independent process observations", async () => {
    const root = repo();
    await Promise.all(["one", "two", "three"].map((key) => worker(root, key)));
    expect(
      (await createPapercutStore(root).load()).records.map(
        (record) => record.key,
      ),
    ).toEqual(["one", "three", "two"]);
  });
});
