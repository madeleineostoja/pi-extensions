import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { inspectRun, listCheckoutRuns } from "./controls.js";
import { ExecGitClient } from "./git.js";
import { checkoutPaths, runStatePath } from "./store.js";

export const InspectImplementRunParams = Type.Object({
  runId: Type.Optional(
    Type.String({ description: "Retained Implement run ID to inspect." }),
  ),
});

type InspectImplementRunInput = Static<typeof InspectImplementRunParams>;

type InspectionDetails = {
  checkoutRoot: string;
  runId?: string;
  truncated: boolean;
};

export function registerImplementInspectionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "inspect_implement_run",
    label: "inspect_implement_run",
    description:
      "List and inspect durable Pipkin Implement runs in the current checkout. This tool is read-only and reports only durable retained state and paths.",
    promptSnippet:
      "List and inspect durable Pipkin Implement runs in the current checkout.",
    promptGuidelines: [
      "Use inspect_implement_run before searching `.pi/pipkin/implement` when investigating an Implement run; follow the returned state and artifact paths with read for deeper evidence.",
    ],
    parameters: InspectImplementRunParams,
    async execute(
      _toolCallId,
      input: InspectImplementRunInput,
      _signal,
      _update,
      ctx,
    ) {
      const checkoutRoot = await new ExecGitClient(ctx.cwd).root();
      return inspectImplementRun(checkoutRoot, input);
    },
  });
}

export function inspectImplementRun(
  checkoutRoot: string,
  input: InspectImplementRunInput,
): {
  content: Array<{ type: "text"; text: string }>;
  details: InspectionDetails;
} {
  const text = input.runId
    ? inspectRun(checkoutRoot, input.runId)
    : formatRunList(checkoutRoot);
  const paths = checkoutPaths(checkoutRoot);
  const authoritativePath = input.runId
    ? runStatePath(paths, input.runId)
    : paths.runs;
  const output = boundOutput(text, authoritativePath);
  return {
    content: [{ type: "text", text: output.text }],
    details: {
      checkoutRoot,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      truncated: output.truncated,
    },
  };
}

export function formatRunList(checkoutRoot: string): string {
  const runs = listCheckoutRuns(checkoutRoot);
  if (runs.length === 0) {
    return "Implement: no retained runs in this checkout.";
  }
  return [
    "Implement retained runs:",
    ...runs.map((run) =>
      run.kind === "run"
        ? `- ${run.runId} · ${run.state.phase} · updated ${run.state.updatedAt}`
        : `- ${run.runId} · historical artifact (manual inspection/removal only)`,
    ),
  ].join("\n");
}

export function boundOutput(
  text: string,
  authoritativePath: string,
): { text: string; truncated: boolean } {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text, truncated: false };
  }
  const notice = `[Output truncated. Read ${authoritativePath} for authoritative state and deeper evidence.]`;
  const separator = "\n";
  const content = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES - 1,
    maxBytes:
      DEFAULT_MAX_BYTES - Buffer.byteLength(`${separator}${notice}`, "utf8"),
  }).content;
  return {
    text: content ? `${content}${separator}${notice}` : notice,
    truncated: true,
  };
}
