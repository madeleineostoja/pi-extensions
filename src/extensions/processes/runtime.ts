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
const MAX_PROJECTION_BYTES = 18 * 1024;
const MAX_WAIT_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const DEFAULT_TAIL_LINES = 80;
const SEARCH_CONTEXT_LINES = 3;
const SEARCH_MATCH_LIMIT = 10;

type Stream = "stdout" | "stderr";

export type ProcessStatus = "running" | "completed" | "failed" | "stopped";
export type ProcessWaitOutcome =
  | "snapshot"
  | "ready"
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
export type ProcessResultSelection = Readonly<{
  tailLines?: number;
  find?: string;
}>;
export type ProcessProjection = Readonly<{
  output: string;
  selector: Readonly<{
    type: "tail" | "find";
    requestedLines?: number;
    sourceLines: number;
    totalMatches?: number;
    selectedMatchAnchors?: number;
    omittedMatches?: number;
    windows?: number;
    outputTruncated: boolean;
  }>;
}>;

type OutputPart = { stream: Stream; text: string; bytes: number };
type RecordState = {
  snapshot: ProcessSnapshot;
  output: OutputPart[];
  firstRetainedLine: number;
};
type Waiter = {
  finish: (outcome: ProcessWaitOutcome) => void;
  literal?: string;
  suffixes?: Record<Stream, string>;
};
type ProcessRecord = RecordState & {
  lease: SandboxExecutionLease;
  stdout: StringDecoder;
  stderr: StringDecoder;
  waiters: Set<Waiter>;
};
type LogicalLine = { stream: Stream; text: string; number: number };
type SearchWindow = { start: number; end: number };

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

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maxBytes) {
      return `${result}…`;
    }
    bytes += length;
    result += character;
  }
  return result;
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

function literalBytes(value: string, tool: string, trimmed: boolean): string {
  const literal = trimmed ? value.trim() : value;
  const bytes = Buffer.byteLength(literal);
  if (bytes < 1 || bytes > 256) {
    throw new Error(`${tool}: literal must contain 1–256 UTF-8 bytes`);
  }
  return literal;
}

function mergeWindows(windows: SearchWindow[]): SearchWindow[] {
  const merged: SearchWindow[] = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

export class ProcessRuntime {
  #records = new Map<string, ProcessRecord>();
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
    const stagingSettlement = new Promise<void>(
      (resolve) => (finishStaging = resolve),
    );
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
        firstRetainedLine: 1,
      };
      let observed: RecordState = staging;
      const lease = await startSandboxManagedExecution(this.host as never, {
        toolCallId: input.toolCallId ?? id,
        command: input.command,
        cwd: input.cwd,
        ctx: input.ctx,
        signal: controller.signal,
        onOutput: ({ stream, data }) =>
          this.append(
            observed,
            stream,
            (stream === "stdout" ? stdout : stderr).write(data),
          ),
      });
      if (this.#disposed) {
        await lease.stop();
        throw new Error("Processes: session is shutting down.");
      }
      const record: ProcessRecord = {
        ...staging,
        lease,
        stdout,
        stderr,
        waiters: new Set(),
      };
      observed = record;
      record.snapshot = { ...record.snapshot, pid: lease.pid };
      this.#reservations -= 1;
      this.evictForSuccessfulLaunch();
      this.#records.set(id, record);
      void lease.completion
        .then((result) => this.settle(record, result))
        .catch(() =>
          this.settle(record, {
            exitCode: null,
            signal: null,
            termination: "natural",
            outputComplete: false,
          }),
        );
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
    untilContains?: string,
    selection: ProcessResultSelection = {},
  ): Promise<{
    snapshot: ProcessSnapshot;
    waitOutcome: ProcessWaitOutcome;
    output: string;
    selector: ProcessProjection["selector"];
  }> {
    this.validateResult(wait, timeoutSeconds, untilContains, selection);
    const record = this.require(id);
    let waitOutcome: ProcessWaitOutcome = "snapshot";
    if (wait) {
      waitOutcome = signal?.aborted
        ? "cancelled"
        : untilContains !== undefined &&
            this.retainedContains(record, untilContains)
          ? "ready"
          : terminal(record.snapshot.status)
            ? "terminal"
            : await this.wait(record, timeoutSeconds, signal, untilContains);
    }
    const projection = this.project(record, selection);
    return { snapshot: copy(record.snapshot), waitOutcome, ...projection };
  }

  async stop(
    id: string,
    selection: ProcessResultSelection = {},
  ): Promise<{
    snapshot: ProcessSnapshot;
    output: string;
    selector: ProcessProjection["selector"];
  }> {
    const record = this.require(id);
    if (!terminal(record.snapshot.status)) {
      await record.lease.stop();
      await Promise.resolve();
    }
    return {
      snapshot: copy(record.snapshot),
      ...this.project(record, selection),
    };
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
      for (const waiter of record.waiters) {
        waiter.finish("cancelled");
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

  private require(id: string): ProcessRecord {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`Processes: unknown or evicted process ${id}`);
    }
    return record;
  }

  private validateResult(
    wait: boolean,
    timeoutSeconds: number | undefined,
    untilContains: string | undefined,
    selection: ProcessResultSelection,
  ): void {
    if (!wait && timeoutSeconds !== undefined) {
      throw new Error("get_process_result: timeoutSeconds requires wait:true");
    }
    if (!wait && untilContains !== undefined) {
      throw new Error("get_process_result: untilContains requires wait:true");
    }
    if (
      timeoutSeconds !== undefined &&
      (!Number.isFinite(timeoutSeconds) ||
        timeoutSeconds <= 0 ||
        timeoutSeconds > MAX_WAIT_TIMEOUT_SECONDS)
    ) {
      throw new Error("get_process_result: invalid timeoutSeconds");
    }
    if (untilContains !== undefined) {
      literalBytes(untilContains, "get_process_result: untilContains", false);
    }
    if (
      selection.tailLines !== undefined &&
      (!Number.isInteger(selection.tailLines) ||
        selection.tailLines < 1 ||
        selection.tailLines > MAX_PROJECTION_LINES)
    ) {
      throw new Error(
        "get_process_result: tailLines must be an integer from 1 through 200",
      );
    }
    if (selection.tailLines !== undefined && selection.find !== undefined) {
      throw new Error(
        "get_process_result: tailLines and find are mutually exclusive",
      );
    }
    if (selection.find !== undefined) {
      literalBytes(selection.find, "get_process_result: find", true);
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

  private append(record: RecordState, stream: Stream, text: string): void {
    if (!text) {
      return;
    }
    const part: OutputPart = { stream, text, bytes: Buffer.byteLength(text) };
    record.output.push(part);
    let retained = record.snapshot.retainedBytes + part.bytes;
    let dropped = record.snapshot.droppedBytes;
    while (retained > MAX_OUTPUT_BYTES && record.output.length > 0) {
      const first = record.output[0]!;
      const before = first.text;
      const removed = trimPartPrefix(first, retained - MAX_OUTPUT_BYTES);
      const removedText = before.slice(0, before.length - first.text.length);
      const completedLines = [...removedText].filter(
        (character) => character === "\n",
      ).length;
      const removedWholePart = first.bytes === 0;
      const continuesInRetainedOutput = record.output
        .slice(1)
        .some((part) => part.stream === first.stream);
      record.firstRetainedLine +=
        completedLines +
        (removedWholePart &&
        !before.endsWith("\n") &&
        !continuesInRetainedOutput
          ? 1
          : 0);
      retained -= removed;
      dropped += removed;
      if (removedWholePart) {
        record.output.shift();
      }
    }
    record.snapshot = {
      ...record.snapshot,
      retainedBytes: retained,
      droppedBytes: dropped,
    };
    if (this.#records.has(record.snapshot.id)) {
      this.ready(record as ProcessRecord, stream, text);
      this.emit(record as ProcessRecord);
    }
  }

  private settle(
    record: ProcessRecord,
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
    for (const waiter of Array.from(record.waiters)) {
      waiter.finish("terminal");
    }
    this.emit(record);
  }

  private wait(
    record: ProcessRecord,
    timeoutSeconds: number | undefined,
    signal: AbortSignal | undefined,
    untilContains: string | undefined,
  ): Promise<ProcessWaitOutcome> {
    if (record.waiters.size >= MAX_WAITERS) {
      return Promise.reject(
        new Error("get_process_result: maximum of 16 waiters reached"),
      );
    }
    if (untilContains && this.retainedContains(record, untilContains)) {
      return Promise.resolve("ready");
    }
    if (terminal(record.snapshot.status)) {
      return Promise.resolve("terminal");
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let done = false;
      const waiter: Waiter = {
        ...(untilContains === undefined
          ? {}
          : {
              literal: untilContains,
              suffixes: this.readinessSuffixes(record, untilContains),
            }),
        finish: (outcome) => {
          if (done) {
            return;
          }
          done = true;
          if (timer) {
            clearTimeout(timer);
          }
          signal?.removeEventListener("abort", abort);
          record.waiters.delete(waiter);
          resolve(outcome);
        },
      };
      const abort = () => waiter.finish("cancelled");
      record.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutSeconds !== undefined) {
        timer = setTimeout(
          () => waiter.finish("timed_out"),
          timeoutSeconds * 1000,
        );
      }
      if (terminal(record.snapshot.status)) {
        waiter.finish("terminal");
      }
    });
  }

  private retainedContains(record: ProcessRecord, literal: string): boolean {
    return (["stdout", "stderr"] as const).some((stream) =>
      this.retainedStreamText(record, stream).includes(literal),
    );
  }

  private readinessSuffixes(
    record: ProcessRecord,
    literal: string,
  ): Record<Stream, string> {
    const maxBytes = Buffer.byteLength(literal) - 1;
    return {
      stdout: suffixAtUtf8Boundary(
        this.retainedStreamText(record, "stdout"),
        maxBytes,
      ),
      stderr: suffixAtUtf8Boundary(
        this.retainedStreamText(record, "stderr"),
        maxBytes,
      ),
    };
  }

  private retainedStreamText(record: ProcessRecord, stream: Stream): string {
    return record.output
      .filter((part) => part.stream === stream)
      .map((part) => part.text)
      .join("");
  }

  private ready(record: ProcessRecord, stream: Stream, text: string): void {
    for (const waiter of Array.from(record.waiters)) {
      if (!waiter.literal || !waiter.suffixes) {
        continue;
      }
      const source = waiter.suffixes[stream] + text;
      if (source.includes(waiter.literal)) {
        waiter.finish("ready");
      } else {
        waiter.suffixes[stream] = suffixAtUtf8Boundary(
          source,
          Buffer.byteLength(waiter.literal) - 1,
        );
      }
    }
  }

  private emit(record: ProcessRecord | undefined, evictedId?: string): void {
    const snapshots = this.snapshots();
    for (const listener of Array.from(this.#subscribers)) {
      try {
        listener(snapshots);
      } catch {}
    }
    const id = evictedId ?? record?.snapshot.id;
    if (!id) {
      return;
    }
    for (const listener of Array.from(this.#recordSubscribers.get(id) ?? [])) {
      try {
        listener(record ? copy(record.snapshot) : undefined);
      } catch {}
    }
  }

  private logicalLines(record: ProcessRecord): LogicalLine[] {
    const lines: Array<LogicalLine & { order: number }> = [];
    const open: Partial<Record<Stream, LogicalLine & { order: number }>> = {};
    let order = 0;
    const flush = (stream: Stream) => {
      const line = open[stream];
      if (line) {
        lines.push(line);
        delete open[stream];
      }
    };
    for (const part of record.output) {
      for (const character of part.text) {
        let line = open[part.stream];
        if (!line) {
          line = {
            stream: part.stream,
            text: "",
            number: record.firstRetainedLine + order,
            order,
          };
          order += 1;
          open[part.stream] = line;
        }
        if (character === "\n") {
          flush(part.stream);
        } else {
          line.text += character;
        }
      }
    }
    for (const stream of ["stdout", "stderr"] as const) {
      flush(stream);
    }
    return lines
      .sort((left, right) => left.order - right.order)
      .map(({ stream, text, number }) => ({ stream, text, number }));
  }

  private project(
    record: ProcessRecord,
    selection: ProcessResultSelection,
  ): ProcessProjection {
    const lines = this.logicalLines(record);
    const notices = [
      ...(record.snapshot.droppedBytes > 0
        ? [
            `Older retained output dropped: ${record.snapshot.droppedBytes} bytes.`,
          ]
        : []),
      ...(!record.snapshot.outputComplete
        ? ["Final output may be incomplete."]
        : []),
    ];
    let outputLines: string[];
    let fixedOutputLines = 0;
    let selector: ProcessProjection["selector"];
    if (selection.find !== undefined) {
      const find = literalBytes(
        selection.find,
        "get_process_result: find",
        true,
      );
      const matches = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) =>
          sanitiseLine(line.text).toLowerCase().includes(find.toLowerCase()),
        );
      const anchors = matches.slice(0, SEARCH_MATCH_LIMIT);
      const windows = mergeWindows(
        anchors.map(({ index }) => ({
          start: Math.max(0, index - SEARCH_CONTEXT_LINES),
          end: Math.min(lines.length - 1, index + SEARCH_CONTEXT_LINES),
        })),
      );
      outputLines =
        matches.length === 0
          ? [
              `No matches for ${JSON.stringify(sanitiseLine(find))}.`,
              `Searched ${lines.length} retained source lines.`,
            ]
          : [
              `Matches for ${JSON.stringify(sanitiseLine(find))}: ${anchors.length} selected from ${matches.length}.`,
              ...(matches.length > anchors.length
                ? [
                    `${matches.length - anchors.length} matches omitted from anchors.`,
                  ]
                : []),
              ...windows.flatMap((window, index) => [
                ...(index > 0 ? ["…"] : []),
                ...lines
                  .slice(window.start, window.end + 1)
                  .map(
                    (line) =>
                      `${line.number} [${line.stream}] ${sanitiseLine(line.text)}`,
                  ),
              ]),
            ];
      selector = {
        type: "find",
        sourceLines: lines.length,
        totalMatches: matches.length,
        selectedMatchAnchors: anchors.length,
        omittedMatches: matches.length - anchors.length,
        windows: windows.length,
        outputTruncated: false,
      };
    } else {
      const requestedLines = selection.tailLines ?? DEFAULT_TAIL_LINES;
      const omittedLines = Math.max(0, lines.length - requestedLines);
      outputLines = [
        ...(lines.length === 0 ? ["No retained output observed."] : []),
        ...(omittedLines > 0
          ? [
              `${omittedLines} older retained source lines omitted by tail selection.`,
            ]
          : []),
        ...lines
          .slice(-requestedLines)
          .map((line) => `[${line.stream}] ${sanitiseLine(line.text)}`),
      ];
      fixedOutputLines =
        (lines.length === 0 ? 1 : 0) + (omittedLines > 0 ? 1 : 0);
      selector = {
        type: "tail",
        requestedLines,
        sourceLines: lines.length,
        outputTruncated: false,
      };
    }
    let pathological = false;
    outputLines = outputLines.map((line) => {
      const clipped = truncateUtf8(line, 4_096);
      pathological ||= clipped !== line;
      return clipped;
    });
    const fixed = [
      ...notices,
      ...(pathological ? ["Pathological output line truncated."] : []),
      ...outputLines.slice(0, fixedOutputLines),
    ];
    const variable = outputLines.slice(fixedOutputLines);
    const bytesOf = (value: readonly string[]) =>
      Buffer.byteLength(value.join("\n"));
    const truncationNotice = (omitted: number) =>
      `Output projection truncated; ${omitted} rendered lines omitted.`;
    let selected: string[];
    let truncated = false;
    if (selector.type === "tail") {
      const suffix: string[] = [];
      for (let index = variable.length - 1; index >= 0; index -= 1) {
        const next = [variable[index]!, ...suffix];
        const omitted = variable.length - next.length;
        const result = [
          ...fixed,
          ...(omitted > 0 ? [truncationNotice(omitted)] : []),
          ...next,
        ];
        if (
          result.length <= MAX_PROJECTION_LINES &&
          bytesOf(result) <= MAX_PROJECTION_BYTES
        ) {
          suffix.unshift(variable[index]!);
          continue;
        }
        break;
      }
      truncated = suffix.length < variable.length;
      selected = [
        ...fixed,
        ...(truncated
          ? [truncationNotice(variable.length - suffix.length)]
          : []),
        ...suffix,
      ];
    } else {
      const prefix: string[] = [];
      for (let index = 0; index < variable.length; index += 1) {
        const next = [...prefix, variable[index]!];
        const omitted = variable.length - next.length;
        const result = [
          ...fixed,
          ...next,
          ...(omitted > 0 ? [truncationNotice(omitted)] : []),
        ];
        if (
          result.length > MAX_PROJECTION_LINES ||
          bytesOf(result) > MAX_PROJECTION_BYTES
        ) {
          break;
        }
        prefix.push(variable[index]!);
      }
      truncated = prefix.length < variable.length;
      selected = [
        ...fixed,
        ...prefix,
        ...(truncated
          ? [truncationNotice(variable.length - prefix.length)]
          : []),
      ];
    }
    selector = { ...selector, outputTruncated: truncated };
    return { output: selected.join("\n"), selector };
  }
}
