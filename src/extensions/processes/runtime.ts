import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";
import {
  startSandboxManagedExecution,
  type SandboxExecutionLease,
} from "#sandbox/bash";

const MAX_ACTIVE = 8;
const MAX_RECORDS = 32;
const MAX_WAITERS = 16;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROJECTION_LINES = 200;
const MAX_PROJECTION_BYTES = 20 * 1024;
const MAX_WAIT_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export type ProcessStatus = "running" | "completed" | "failed" | "stopped";
export type ProcessWaitOutcome =
  | "snapshot"
  | "terminal"
  | "timed_out"
  | "cancelled";

export type ProcessSnapshot = Readonly<{
  id: string;
  status: ProcessStatus;
  description: string;
  command: string;
  cwd: string;
  pid: number;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt?: string;
  retainedBytes: number;
  droppedBytes: number;
  outputComplete: boolean;
}>;

export type ProcessSubscription = (
  snapshot: ProcessSnapshot | undefined,
) => void;

type OutputPart = { stream: "stdout" | "stderr"; text: string; bytes: number };
type RecordState = {
  snapshot: ProcessSnapshot;
  output: OutputPart[];
};
type Record = RecordState & {
  lease: SandboxExecutionLease;
  stdout: StringDecoder;
  stderr: StringDecoder;
  waiters: Set<(forced?: ProcessWaitOutcome) => void>;
};

function copy(snapshot: ProcessSnapshot): ProcessSnapshot {
  return { ...snapshot };
}

export function normalizeProcessDescription(description: string): string {
  const normalized = Array.from(description, (character) =>
    /\p{C}/u.test(character) ? " " : character,
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if ([...normalized].length < 1 || [...normalized].length > 120) {
    throw new Error(
      "start_process: description must normalize to 1–120 Unicode code points",
    );
  }
  return normalized;
}

function terminal(status: ProcessStatus): boolean {
  return status !== "running";
}

function sanitiseLine(text: string): string {
  return Array.from(text, (character) =>
    character === "\t" || !/\p{C}/u.test(character) ? character : "�",
  ).join("");
}

function suffixAtUtf8Boundary(text: string, maxBytes: number): string {
  let bytes = 0;
  let start = text.length;
  for (const character of Array.from(text).reverse()) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maxBytes) {
      break;
    }
    bytes += length;
    start -= character.length;
  }
  return text.slice(start);
}

function trimPartPrefix(part: OutputPart, bytes: number): number {
  if (bytes <= 0) {
    return 0;
  }
  if (bytes >= part.bytes) {
    const removed = part.bytes;
    part.text = "";
    part.bytes = 0;
    return removed;
  }
  const retained = suffixAtUtf8Boundary(part.text, part.bytes - bytes);
  const removed = part.bytes - Buffer.byteLength(retained);
  part.text = retained;
  part.bytes -= removed;
  return removed;
}

export class ProcessRuntime {
  #records = new Map<string, Record>();
  #reservations = 0;
  #nextId = 1;
  #disposed = false;
  #staging = new Set<AbortController>();
  #stagingSettlements = new Set<Promise<void>>();
  #subscribers = new Set<(snapshots: readonly ProcessSnapshot[]) => void>();
  #recordSubscribers = new Map<string, Set<ProcessSubscription>>();

  constructor(
    private readonly host: object,
    private readonly bashActive: () => boolean,
  ) {}

  snapshots(): readonly ProcessSnapshot[] {
    return [...this.#records.values()].map((record) => copy(record.snapshot));
  }

  subscribe(
    listener: (snapshots: readonly ProcessSnapshot[]) => void,
  ): () => void {
    if (this.#disposed) {
      return () => undefined;
    }
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  subscribeRecord(id: string, listener: ProcessSubscription): () => void {
    if (this.#disposed) {
      return () => undefined;
    }
    const listeners = this.#recordSubscribers.get(id) ?? new Set();
    listeners.add(listener);
    this.#recordSubscribers.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#recordSubscribers.delete(id);
      }
    };
  }

  async start(input: {
    command: string;
    description: string;
    cwd: string;
    ctx: ExtensionContext;
    signal: AbortSignal | undefined;
    toolCallId?: string;
  }): Promise<ProcessSnapshot> {
    if (this.#disposed) {
      throw new Error("Processes: session is shutting down.");
    }
    if (!this.bashActive()) {
      throw new Error("start_process: bash is inactive");
    }
    if (!input.command.trim()) {
      throw new Error("start_process: command must not be empty");
    }
    const description = normalizeProcessDescription(input.description);
    if (this.#reservations + this.activeCount() >= MAX_ACTIVE) {
      throw new Error("start_process: maximum of 8 active processes reached");
    }

    this.#reservations += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted) {
      controller.abort();
    } else {
      input.signal?.addEventListener("abort", abort, { once: true });
    }
    this.#staging.add(controller);
    let finishStaging: () => void = () => undefined;
    const stagingSettlement = new Promise<void>((resolve) => {
      finishStaging = resolve;
    });
    this.#stagingSettlements.add(stagingSettlement);

    const id = `process-${this.#nextId++}`;
    try {
      const stdout = new StringDecoder("utf8");
      const stderr = new StringDecoder("utf8");
      const staging: RecordState = {
        snapshot: {
          id,
          status: "running",
          description,
          command: input.command,
          cwd: input.cwd,
          pid: 0,
          exitCode: null,
          signal: null,
          startedAt: new Date().toISOString(),
          retainedBytes: 0,
          droppedBytes: 0,
          outputComplete: true,
        },
        output: [],
      };
      const lease = await startSandboxManagedExecution(this.host as never, {
        toolCallId: input.toolCallId ?? id,
        command: input.command,
        cwd: input.cwd,
        ctx: input.ctx,
        signal: controller.signal,
        onOutput: ({ stream, data }) => {
          const decoder = stream === "stdout" ? stdout : stderr;
          this.append(staging, stream, decoder.write(data));
        },
      });
      if (this.#disposed) {
        await lease.stop();
        throw new Error("Processes: session is shutting down.");
      }
      const record: Record = {
        ...staging,
        lease,
        stdout,
        stderr,
        waiters: new Set(),
      };
      record.snapshot = { ...record.snapshot, pid: lease.pid };
      this.#reservations -= 1;
      this.evictForSuccessfulLaunch();
      this.#records.set(id, record);
      const settled = lease.completion.then((result) =>
        this.settle(record, result),
      );
      void settled.catch(() => undefined);
      await Promise.resolve();
      this.emit(record);
      return copy(record.snapshot);
    } catch (error) {
      this.#reservations -= 1;
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.#staging.delete(controller);
      this.#stagingSettlements.delete(stagingSettlement);
      finishStaging();
    }
  }

  snapshot(id: string): ProcessSnapshot {
    return copy(this.require(id).snapshot);
  }

  async result(
    id: string,
    wait: boolean,
    timeoutSeconds: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{
    snapshot: ProcessSnapshot;
    waitOutcome: ProcessWaitOutcome;
    output: string;
  }> {
    this.validateWait(wait, timeoutSeconds);
    const record = this.require(id);
    let outcome: ProcessWaitOutcome = "snapshot";
    if (wait) {
      outcome = signal?.aborted
        ? "cancelled"
        : terminal(record.snapshot.status)
          ? "terminal"
          : await this.wait(record, timeoutSeconds, signal);
    }
    return {
      snapshot: copy(record.snapshot),
      waitOutcome: outcome,
      output: this.project(record),
    };
  }

  async stop(
    id: string,
  ): Promise<{ snapshot: ProcessSnapshot; output: string }> {
    const record = this.require(id);
    if (!terminal(record.snapshot.status)) {
      await record.lease.stop();
      await Promise.resolve();
    }
    return { snapshot: copy(record.snapshot), output: this.project(record) };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const controller of this.#staging) {
      controller.abort();
    }
    await Promise.allSettled(this.#stagingSettlements);
    await Promise.allSettled(
      [...this.#records.values()]
        .filter((record) => !terminal(record.snapshot.status))
        .map((record) => record.lease.stop()),
    );
    for (const record of this.#records.values()) {
      for (const notify of record.waiters) {
        notify("cancelled");
      }
      record.waiters.clear();
    }
    this.#records.clear();
    this.#subscribers.clear();
    this.#recordSubscribers.clear();
  }

  private activeCount(): number {
    return [...this.#records.values()].filter(
      (record) => !terminal(record.snapshot.status),
    ).length;
  }

  private require(id: string): Record {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`Processes: unknown or evicted process ${id}`);
    }
    return record;
  }

  private validateWait(
    wait: boolean,
    timeoutSeconds: number | undefined,
  ): void {
    if (!wait && timeoutSeconds !== undefined) {
      throw new Error("get_process_result: timeoutSeconds requires wait:true");
    }
    if (
      timeoutSeconds !== undefined &&
      (!Number.isFinite(timeoutSeconds) ||
        timeoutSeconds <= 0 ||
        timeoutSeconds > MAX_WAIT_TIMEOUT_SECONDS)
    ) {
      throw new Error("get_process_result: invalid timeoutSeconds");
    }
  }

  private evictForSuccessfulLaunch(): void {
    while (this.#records.size >= MAX_RECORDS) {
      const oldest = [...this.#records.values()].find((record) =>
        terminal(record.snapshot.status),
      );
      if (!oldest) {
        throw new Error(
          "start_process: record capacity is occupied by active processes",
        );
      }
      this.#records.delete(oldest.snapshot.id);
      this.emit(undefined, oldest.snapshot.id);
    }
  }

  private append(
    record: RecordState,
    stream: "stdout" | "stderr",
    text: string,
  ): void {
    if (!text) {
      return;
    }
    const part: OutputPart = { stream, text, bytes: Buffer.byteLength(text) };
    record.output.push(part);
    let retained = record.snapshot.retainedBytes + part.bytes;
    let dropped = record.snapshot.droppedBytes;
    while (retained > MAX_OUTPUT_BYTES && record.output.length > 0) {
      const first = record.output[0]!;
      const removed = trimPartPrefix(first, retained - MAX_OUTPUT_BYTES);
      retained -= removed;
      dropped += removed;
      if (first.bytes === 0) {
        record.output.shift();
      }
    }
    record.snapshot = {
      ...record.snapshot,
      retainedBytes: retained,
      droppedBytes: dropped,
    };
    if (this.#records.has(record.snapshot.id)) {
      this.emit(record as Record);
    }
  }

  private settle(
    record: Record,
    result: Awaited<SandboxExecutionLease["completion"]>,
  ): void {
    this.append(record, "stdout", record.stdout.end());
    this.append(record, "stderr", record.stderr.end());
    const status: ProcessStatus =
      result.termination === "natural"
        ? result.exitCode === 0 && result.signal === null
          ? "completed"
          : "failed"
        : "stopped";
    record.snapshot = {
      ...record.snapshot,
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      outputComplete: result.outputComplete,
      endedAt: new Date().toISOString(),
    };
    const waiters = Array.from(record.waiters);
    for (const notify of waiters) {
      notify();
    }
    this.emit(record);
  }

  private wait(
    record: Record,
    timeoutSeconds: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ProcessWaitOutcome> {
    if (record.waiters.size >= MAX_WAITERS) {
      return Promise.reject(
        new Error("get_process_result: maximum of 16 waiters reached"),
      );
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let done = false;
      const finish = (outcome: ProcessWaitOutcome) => {
        if (done) {
          return;
        }
        done = true;
        if (timer) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", abort);
        record.waiters.delete(check);
        resolve(outcome);
      };
      const check = (forced?: ProcessWaitOutcome) => {
        if (forced) {
          finish(forced);
        } else if (terminal(record.snapshot.status)) {
          finish("terminal");
        }
      };
      const abort = () => finish("cancelled");
      record.waiters.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutSeconds !== undefined) {
        timer = setTimeout(() => finish("timed_out"), timeoutSeconds * 1000);
      }
      check();
    });
  }

  private emit(record: Record | undefined, evictedId?: string): void {
    const snapshots = this.snapshots();
    const subscribers = Array.from(this.#subscribers);
    for (const listener of subscribers) {
      try {
        listener(snapshots);
      } catch {}
    }
    const id = evictedId ?? record?.snapshot.id;
    if (!id) {
      return;
    }
    const recordSubscribers = Array.from(this.#recordSubscribers.get(id) ?? []);
    for (const listener of recordSubscribers) {
      try {
        listener(record ? copy(record.snapshot) : undefined);
      } catch {}
    }
  }

  private project(record: Record): string {
    const lines: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    for (const part of record.output) {
      const pieces = part.text.split("\n");
      for (let index = 0; index < pieces.length; index += 1) {
        const text = sanitiseLine(pieces[index]!);
        const previous = lines.at(-1);
        if (
          index === 0 &&
          previous?.stream === part.stream &&
          !previous.text.endsWith("\n")
        ) {
          previous.text += text;
        } else {
          lines.push({ stream: part.stream, text });
        }
      }
    }
    const notices = [
      ...(record.snapshot.droppedBytes > 0
        ? [`Older output dropped: ${record.snapshot.droppedBytes} bytes.`]
        : []),
      ...(!record.snapshot.outputComplete
        ? ["Final output may be incomplete."]
        : []),
    ];
    const rendered = lines
      .slice(-80)
      .map(({ stream, text }) => `[${stream}] ${text}`);
    const selected: string[] = [];
    let bytes = Buffer.byteLength(notices.join("\n"));
    for (const line of rendered.reverse()) {
      const lineBytes =
        Buffer.byteLength(line) + (selected.length || notices.length ? 1 : 0);
      if (
        selected.length >= MAX_PROJECTION_LINES - notices.length ||
        bytes + lineBytes > MAX_PROJECTION_BYTES
      ) {
        continue;
      }
      selected.unshift(line);
      bytes += lineBytes;
    }
    if (selected.length < rendered.length) {
      const notice = "Output projection truncated.";
      if (
        notices.length + selected.length < MAX_PROJECTION_LINES &&
        bytes + Buffer.byteLength(notice) + 1 <= MAX_PROJECTION_BYTES
      ) {
        notices.push(notice);
      }
    }
    return [...notices, ...selected].join("\n");
  }
}
