import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ProcessRuntime } from "./runtime.js";

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
        "Wait once for terminal settlement; false is an intentional snapshot.",
    }),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description:
          "Positive maximum wait in seconds; timeout leaves the process running.",
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
  },
  { additionalProperties: false },
);

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

function resultText(result: {
  snapshot: Record<string, unknown>;
  output: string;
  waitOutcome?: string;
}): string {
  const snapshot = { ...result.snapshot };
  for (const key of ["command", "cwd"]) {
    if (typeof snapshot[key] === "string") {
      snapshot[key] = truncateUtf8(snapshot[key], 2_048);
    }
  }
  const headings = [
    ...(result.waitOutcome === undefined
      ? []
      : [`Wait: ${result.waitOutcome}`]),
    JSON.stringify(snapshot, null, 2),
    ...(result.output ? ["Output:"] : []),
  ];
  const available = 24 * 1024 - Buffer.byteLength(headings.join("\n"));
  const output =
    available > 0 && Buffer.byteLength(result.output) > available
      ? `${truncateUtf8(result.output, Math.max(0, available - 32))}\nOutput projection truncated.`
      : result.output;
  return [...headings, ...(output ? [output] : [])].join("\n");
}

export function registerProcessTools(
  pi: ExtensionAPI,
  runtime: () => ProcessRuntime,
): void {
  pi.registerTool({
    name: "start_process",
    label: "start_process",
    description:
      "Start a foreground non-interactive command that can continue while independent work proceeds. Do not start it when the next action is an immediate join.",
    promptSnippet:
      "start_process — start independent foreground non-interactive work and continue useful work before joining it",
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
      return {
        content: [{ type: "text", text: resultText({ snapshot, output: "" }) }],
        details: snapshot,
      };
    },
  });
  pi.registerTool({
    name: "get_process_result",
    label: "get_process_result",
    description:
      "Inspect or join a managed process. Use wait:true once terminal completion becomes a dependency; wait:false is intentional inspection only, never polling.",
    promptSnippet:
      "get_process_result — inspect once or wait once for a managed process; do not poll",
    promptGuidelines: [
      "Use get_process_result with wait:true once completion becomes a dependency; do not poll with wait:false.",
      "A wait timeout stops waiting, not the managed process.",
    ],
    parameters: ResultParams,
    async execute(_toolCallId, params, signal) {
      const result = await runtime().result(
        params.id,
        params.wait,
        params.timeoutSeconds,
        signal,
      );
      return {
        content: [{ type: "text", text: resultText(result) }],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "stop_process",
    label: "stop_process",
    description:
      "Explicitly stop a no-longer-needed managed process and return its final bounded output.",
    promptGuidelines: [
      "Use stop_process to explicitly stop managed processes that are no longer needed.",
    ],
    parameters: StopParams,
    async execute(_toolCallId, params) {
      const result = await runtime().stop(params.id);
      return {
        content: [{ type: "text", text: resultText(result) }],
        details: result,
      };
    },
  });
}
