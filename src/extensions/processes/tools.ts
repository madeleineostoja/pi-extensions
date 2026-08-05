import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { retainResult, decodeRetainedResult } from "#context/retained-result";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import {
  ProcessRuntime,
  type ProcessProjection,
  type ProcessSnapshot,
} from "./runtime.js";

const ResultModeValues = [Type.Literal("output"), Type.Literal("outcome")];
const ProcessResultMode = Type.Union(ResultModeValues, {
  description:
    "Defaults to output when process output affects the next decision. Choose outcome only for status or readiness: it retains one point-in-time result for context_recall while failed process output stays directly visible. tailLines and find require output mode.",
});
const StopResultMode = Type.Union(ResultModeValues, {
  description:
    "Defaults to output when final output affects the next decision. Choose outcome only for final status: it retains one point-in-time result for context_recall while failed process output stays directly visible.",
});

const StartParams = Type.Object(
  {
    command: Type.String({
      description: "Foreground non-interactive shell command to manage.",
    }),
    description: Type.String({
      description: "Safe single-line description of the managed work.",
    }),
  },
  { additionalProperties: false },
);

type StartInput = Static<typeof StartParams>;

const ResultParams = Type.Object(
  {
    id: Type.String({
      description: "Managed process id returned by start_process.",
    }),
    wait: Type.Boolean({
      description:
        "Wait once for terminal settlement or literal readiness; false is an intentional snapshot.",
    }),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description:
          "Positive maximum wait in seconds; timeout leaves the process running.",
      }),
    ),
    untilContains: Type.Optional(
      Type.String({
        description:
          "Case-sensitive 1–256 UTF-8-byte readiness literal; requires wait:true.",
      }),
    ),
    resultMode: Type.Optional(ProcessResultMode),
    tailLines: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        description:
          "Newest retained output lines to inspect; mutually exclusive with find.",
      }),
    ),
    find: Type.Optional(
      Type.String({
        description:
          "Trimmed case-insensitive 1–256-byte literal output search; mutually exclusive with tailLines.",
      }),
    ),
  },
  { additionalProperties: false },
);

type ResultInput = Static<typeof ResultParams>;

const StopParams = Type.Object(
  {
    id: Type.String({
      description: "Managed process id returned by start_process.",
    }),
    resultMode: Type.Optional(StopResultMode),
  },
  { additionalProperties: false },
);

type StopInput = Static<typeof StopParams>;

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maxBytes) {
      return `${result}…`;
    }
    result += character;
    bytes += length;
  }
  return result;
}

function snapshotForResult(snapshot: ProcessSnapshot): ProcessSnapshot {
  return {
    ...snapshot,
    command: truncateUtf8(snapshot.command, 2_048),
    cwd: truncateUtf8(snapshot.cwd, 2_048),
  };
}

type OrdinaryResult = {
  content: [{ type: "text"; text: string }];
  details: {
    snapshot: ProcessSnapshot;
    waitOutcome?: string;
    selector?: ProcessProjection["selector"] & { find?: string };
    resultMode: "output" | "outcome";
  };
};

function ordinaryResult(result: {
  snapshot: ProcessSnapshot;
  output: string;
  waitOutcome?: string;
  selector?: ProcessProjection["selector"];
  find?: string;
  resultMode?: "output" | "outcome";
  started?: boolean;
}): OrdinaryResult {
  const snapshot = snapshotForResult(result.snapshot);
  const selector =
    result.selector === undefined
      ? undefined
      : {
          ...result.selector,
          ...(result.find === undefined ? {} : { find: result.find.trim() }),
        };
  return {
    content: [
      {
        type: "text",
        text: [
          result.started
            ? `Started managed process ${snapshot.id}${snapshot.pid > 0 ? ` (pid ${snapshot.pid})` : ""}.`
            : processStatus(snapshot),
          ...(result.waitOutcome === undefined
            ? []
            : [waitStatus(result.waitOutcome, snapshot.status)]),
          ...(selector === undefined ? [] : [selectorStatus(selector)]),
          ...(result.selector === undefined ? [] : ["Output:", result.output]),
        ].join("\n\n"),
      },
    ],
    details: {
      snapshot,
      ...(result.waitOutcome === undefined
        ? {}
        : { waitOutcome: result.waitOutcome }),
      ...(selector === undefined ? {} : { selector }),
      resultMode: result.resultMode ?? "output",
    },
  };
}

function processStatus(snapshot: ProcessSnapshot): string {
  const settlement =
    snapshot.status === "running"
      ? "is running"
      : snapshot.status === "completed"
        ? "completed"
        : snapshot.status === "failed"
          ? "failed"
          : "was stopped";
  return `Managed process ${snapshot.id} ${settlement}.`;
}

function waitStatus(
  outcome: string,
  status: ProcessSnapshot["status"],
): string {
  return (
    {
      snapshot: "Captured a current process snapshot.",
      ready: "The requested readiness literal was observed.",
      terminal: "The process reached terminal settlement.",
      timed_out:
        status === "running"
          ? "The wait timed out; the process is still running."
          : "The wait timed out as the process settled.",
      cancelled: "The wait was cancelled.",
    }[outcome] ?? `Wait outcome: ${outcome}.`
  );
}

function selectorStatus(
  selector: ProcessProjection["selector"] & { find?: string },
): string {
  if (selector.type === "tail") {
    return `Showing the newest ${selector.requestedLines ?? "retained"} output lines from ${selector.sourceLines} retained source lines.`;
  }
  if (selector.totalMatches === 0) {
    return `No retained output matched ${JSON.stringify(selector.find ?? "the requested literal")}.`;
  }
  return `Showing ${selector.selectedMatchAnchors ?? 0} selected matches from ${selector.totalMatches ?? 0} retained output matches${selector.find === undefined ? "" : ` for ${JSON.stringify(selector.find)}`}.`;
}

function outcomeSummary(result: {
  snapshot: ProcessSnapshot;
  waitOutcome?: string;
}): string {
  return `${processStatus(result.snapshot)}${result.waitOutcome ? ` ${waitStatus(result.waitOutcome, result.snapshot.status)}` : ""}`;
}

function validateOutcomeSelection(
  mode: "output" | "outcome",
  tailLines: number | undefined,
  find: string | undefined,
): void {
  if (mode === "outcome" && (tailLines !== undefined || find !== undefined)) {
    throw new Error(
      "get_process_result: tailLines and find require resultMode:output",
    );
  }
}

type ProcessResultDetails = {
  snapshot: ProcessSnapshot;
  waitOutcome?: string;
  selector?: ProcessProjection["selector"] & { find?: string };
};

function processResultDetails(
  value: unknown,
): ProcessResultDetails | undefined {
  const direct = detailsFrom(value);
  const retained = detailsFrom(decodeRetainedResult(value)?.details);
  const details = isProcessSnapshot(direct?.snapshot) ? direct : retained;
  if (!details || !isProcessSnapshot(details.snapshot)) {
    return undefined;
  }
  return {
    snapshot: details.snapshot,
    ...(typeof details.waitOutcome === "string"
      ? { waitOutcome: details.waitOutcome }
      : {}),
    ...(isRecord(details.selector)
      ? {
          selector: details.selector as ProcessProjection["selector"] & {
            find?: string;
          },
        }
      : {}),
  };
}

function detailsFrom(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isProcessSnapshot(value: unknown): value is ProcessSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === "running" ||
      value.status === "completed" ||
      value.status === "failed" ||
      value.status === "stopped")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const renderProcessResult = toolResultRenderer({
  summary(result) {
    const details = processResultDetails(result.details);
    return details
      ? [
          compactProcessStatus(details.snapshot),
          ...(details.waitOutcome === undefined
            ? []
            : [waitStatus(details.waitOutcome, details.snapshot.status)]),
          ...(details.selector === undefined
            ? []
            : [selectorStatus(details.selector)]),
        ]
      : firstLine(result.content);
  },
  partial() {
    return "Managing process…";
  },
  error(result) {
    return firstLine(result.content) || "Managed process operation failed.";
  },
  expandedContent(result) {
    return decodeRetainedResult(result.details)?.content ?? result.content;
  },
});

function compactProcessStatus(snapshot: ProcessSnapshot): string {
  const settlement =
    snapshot.exitCode !== null
      ? ` · exit ${snapshot.exitCode}`
      : snapshot.signal
        ? ` · signal ${snapshot.signal}`
        : "";
  return `${snapshot.id} · ${snapshot.status}${settlement}`;
}

function firstLine(content: unknown): string {
  if (!Array.isArray(content)) {
    return "Managed process operation completed.";
  }
  const block = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  );
  return (
    block?.text.split("\n", 1)[0] ?? "Managed process operation completed."
  );
}

export function registerProcessTools(
  pi: ExtensionAPI,
  runtime: () => ProcessRuntime,
): void {
  pi.registerTool({
    name: "start_process",
    label: "start_process",
    description:
      "Start and manage a foreground non-interactive command. Returns an ID for later inspection, joining, or stopping.",
    parameters: StartParams,
    renderCall: toolCallRenderer({
      name: "start_process",
      detail: (args: StartInput) => args.description,
      pending: "Starting managed process…",
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const snapshot = await runtime().start({
        ...params,
        cwd: ctx.cwd,
        ctx,
        signal,
        toolCallId,
      });
      return ordinaryResult({ snapshot, output: "", started: true });
    },
    renderResult: renderProcessResult,
  });
  pi.registerTool({
    name: "get_process_result",
    label: "get_process_result",
    description:
      "Join or inspect a managed process. Output includes retained process output; outcome retains a point-in-time status for context_recall.",
    parameters: ResultParams,
    renderCall: toolCallRenderer({
      name: "get_process_result",
      detail: (args: ResultInput) => `${args.id}${args.wait ? " · wait" : ""}`,
      pending: (args: ResultInput) =>
        args.wait ? "Waiting for process…" : "Reading process state…",
    }),
    async execute(toolCallId, params, signal) {
      const mode = params.resultMode ?? "output";
      validateOutcomeSelection(mode, params.tailLines, params.find);
      const result = await runtime().result(
        params.id,
        params.wait,
        params.timeoutSeconds,
        signal,
        params.untilContains,
        { tailLines: params.tailLines, find: params.find },
      );
      const ordinary = ordinaryResult({
        ...result,
        find: params.find,
        resultMode: mode,
      });
      if (mode === "output" || result.snapshot.status === "failed") {
        return ordinary;
      }
      return retainResult(ordinary, outcomeSummary(result), toolCallId, {
        label: "managed process",
      });
    },
    renderResult: renderProcessResult,
  });
  pi.registerTool({
    name: "stop_process",
    label: "stop_process",
    description:
      "Stop a managed process and return its final output or a recallable point-in-time status.",
    parameters: StopParams,
    renderCall: toolCallRenderer({
      name: "stop_process",
      detail: (args: StopInput) => args.id,
      pending: "Stopping process…",
    }),
    async execute(toolCallId, params) {
      const mode = params.resultMode ?? "output";
      const result = await runtime().stop(params.id);
      const ordinary = ordinaryResult({ ...result, resultMode: mode });
      if (mode === "output" || result.snapshot.status === "failed") {
        return ordinary;
      }
      return retainResult(ordinary, outcomeSummary(result), toolCallId, {
        label: "managed process",
      });
    },
    renderResult: renderProcessResult,
  });
}
