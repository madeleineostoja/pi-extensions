import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { decodeRetainedResult, retainResult } from "#context/retained-result";
import { ProcessRuntime } from "./runtime.js";

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

const StopParams = Type.Object(
  {
    id: Type.String({
      description: "Managed process id returned by start_process.",
    }),
    resultMode: Type.Optional(StopResultMode),
  },
  { additionalProperties: false },
);

const MAX_RESULT_BYTES = 24 * 1024;
const MAX_RESULT_LINES = 200;

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

function boundedText(text: string): string {
  const lines = text.split("\n");
  const selected: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const line of lines) {
    const safeLine = truncateUtf8(line, 4_096);
    const lineBytes = Buffer.byteLength(safeLine) + (selected.length ? 1 : 0);
    if (
      selected.length >= MAX_RESULT_LINES - 1 ||
      bytes + lineBytes > MAX_RESULT_BYTES - 40
    ) {
      truncated = true;
      continue;
    }
    selected.push(safeLine);
    bytes += lineBytes;
  }
  return truncated
    ? [...selected, "Process result truncated."].join("\n")
    : selected.join("\n");
}

function snapshotForResult(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const visible = { ...snapshot };
  for (const key of ["command", "cwd"]) {
    if (typeof visible[key] === "string") {
      visible[key] = truncateUtf8(visible[key], 2_048);
    }
  }
  return visible;
}

function ordinaryResult(result: {
  snapshot: Record<string, unknown>;
  output: string;
  waitOutcome?: string;
  selector?: unknown;
  resultMode?: "output" | "outcome";
}): {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
} {
  const snapshot = snapshotForResult(result.snapshot);
  const details = {
    snapshot,
    ...(result.waitOutcome === undefined
      ? {}
      : { waitOutcome: result.waitOutcome }),
    ...(result.selector === undefined ? {} : { selector: result.selector }),
    resultMode: result.resultMode ?? "output",
  };
  const text = boundedText(
    [
      ...(result.waitOutcome === undefined
        ? []
        : [`Wait: ${result.waitOutcome}`]),
      JSON.stringify(snapshot, null, 2),
      ...(result.output ? ["Output:", result.output] : []),
    ].join("\n"),
  );
  return { content: [{ type: "text", text }], details };
}

function outcomeSummary(result: {
  snapshot: { id?: unknown; status?: unknown };
  waitOutcome?: string;
}): string {
  return `Managed process ${String(result.snapshot.id ?? "unknown")} is ${String(result.snapshot.status ?? "unknown")}${result.waitOutcome ? ` (${result.waitOutcome})` : ""}.`;
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

export function registerProcessTools(
  pi: ExtensionAPI,
  runtime: () => ProcessRuntime,
): void {
  pi.registerTool({
    name: "start_process",
    label: "start_process",
    description:
      "Start a foreground non-interactive command only when independent work can continue; do not start it for an immediate terminal join.",
    promptSnippet:
      "start_process — schedule independent foreground work, then continue useful work before joining it",
    promptGuidelines: [
      "Use start_process only when concrete independent work can continue before process completion; otherwise use foreground bash or bash_outcome.",
      "Do not call start_process when the next action would be an immediate terminal join.",
      "Managed commands must remain foreground: do not use &, nohup, daemonization, terminal attachment, or interactive input.",
    ],
    parameters: StartParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const snapshot = await runtime().start({
        ...params,
        cwd: ctx.cwd,
        ctx,
        signal,
        toolCallId,
      });
      const result = ordinaryResult({ snapshot, output: "" });
      return { content: result.content, details: snapshot };
    },
  });
  pi.registerTool({
    name: "get_process_result",
    label: "get_process_result",
    description:
      "Join once or intentionally inspect a managed process. Select output when it affects the next decision; outcome retains a point-in-time result for context_recall.",
    promptSnippet:
      "get_process_result — wait once or inspect once; choose output for decisions and recallable outcome for status only",
    promptGuidelines: [
      "Use get_process_result with wait:true once completion or readiness becomes a dependency; wait:false is intentional inspection only, never polling.",
      "A get_process_result wait timeout stops waiting, not the managed process.",
      "Use get_process_result resultMode:output when output affects the next decision; use resultMode:outcome when only status or readiness matters. Outcome is point-in-time and recallable, while failed output stays visible.",
      "Use a later get_process_result resultMode:output call for newer output while the process record exists.",
    ],
    parameters: ResultParams,
    renderResult: renderProcessResult,
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
      const ordinary = ordinaryResult({ ...result, resultMode: mode });
      if (mode === "output" || result.snapshot.status === "failed") {
        return { content: ordinary.content, details: ordinary.details };
      }
      return retainResult(ordinary, outcomeSummary(result), toolCallId, {
        label: "managed process",
      });
    },
  });
  pi.registerTool({
    name: "stop_process",
    label: "stop_process",
    description:
      "Explicitly stop a no-longer-needed managed process. Choose output when its final output matters or recallable outcome when only final status matters.",
    promptSnippet:
      "stop_process — stop no-longer-needed work; choose output for decisions or recallable outcome for status only",
    promptGuidelines: [
      "Use stop_process to explicitly stop managed processes that are no longer needed.",
      "Use stop_process resultMode:output when final output affects the next decision; resultMode:outcome keeps a point-in-time result for context_recall. Failed output remains visible.",
    ],
    parameters: StopParams,
    renderResult: renderProcessResult,
    async execute(toolCallId, params) {
      const mode = params.resultMode ?? "output";
      const result = await runtime().stop(params.id);
      const ordinary = ordinaryResult({ ...result, resultMode: mode });
      if (mode === "output" || result.snapshot.status === "failed") {
        return { content: ordinary.content, details: ordinary.details };
      }
      return retainResult(ordinary, outcomeSummary(result), toolCallId, {
        label: "managed process",
      });
    },
  });
}

type ProcessResultRenderer = NonNullable<
  Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]
>;

const renderProcessResult: ProcessResultRenderer = (
  result,
  options,
  theme,
  context,
) => {
  const summary = firstText(result.content);
  if (context.isError || options.isPartial) {
    return new Text(
      theme.fg(context.isError ? "error" : "warning", summary),
      0,
      0,
    );
  }
  if (!options.expanded) {
    return new Text(
      theme.fg("success", summary.split("\n", 1)[0] ?? summary),
      0,
      0,
    );
  }
  const retained = decodeRetainedResult(result.details);
  const output =
    retained === undefined ? summary : retainedText(retained.content);
  return new Text(theme.fg("toolOutput", output), 0, 0);
};

function firstText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "Managed process result unavailable.";
  }
  const text = content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  return text?.text ?? "Managed process result unavailable.";
}

function retainedText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}
