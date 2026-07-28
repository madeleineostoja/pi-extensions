import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "#lib/permission-prompt";
import { assessBashCommand, type Risk } from "./assessors";
import { resolveChoice } from "./handler";

const DETAIL_LIMIT = 16_384;
const TRUNCATION = "… detail truncated";

function excerpt(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : value.slice(0, limit - TRUNCATION.length) + TRUNCATION;
}

export function formatRisks(risks: Risk[]): string {
  const summaries = risks.map(
    (risk, index) =>
      `${index + 1}. [${risk.severity}] ${risk.category}: ${risk.effect}`,
  );
  const reserve = summaries.reduce(
    (size, summary) => size + summary.length + 3,
    0,
  );
  const available = Math.max(0, DETAIL_LIMIT - reserve);
  const perRisk = Math.floor(available / Math.max(risks.length, 1));
  return risks
    .map((risk, index) => {
      const detail = [
        risk.segment,
        risk.targets.length ? `Targets: ${risk.targets.join(", ")}` : "",
        risk.uncertainty ?? "",
      ]
        .filter(Boolean)
        .join("\n");
      return perRisk
        ? `${summaries[index]}\n${excerpt(detail, perRisk)}`
        : summaries[index]!;
    })
    .join("\n\n");
}

export default function (pi: ExtensionAPI) {
  let enabled = true;

  pi.on("session_start", () => {
    enabled = true;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || event.toolName !== "bash" || !ctx.hasUI) {
      return undefined;
    }
    const tool = pi
      .getAllTools()
      .find((candidate) => candidate.name === "bash");
    if (tool?.sourceInfo.source !== "builtin") {
      return undefined;
    }
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") {
      return undefined;
    }
    const risks = await assessBashCommand(command, ctx.cwd);
    if (!risks.length) {
      return undefined;
    }
    const permission = await promptForPermission({
      ui: ctx.ui,
      signal: ctx.signal,
      title: "Shell guard: confirm destructive command?",
      detail: formatRisks(risks),
      choices: [
        { value: "Allow once", label: "Allow once" },
        { value: "Allow all this session", label: "Allow all this session" },
        {
          value: "Block",
          label: "Block",
          input: {
            title: "Reason to give the agent",
            placeholder: "why are you blocking this?",
          },
        },
      ],
    });
    const result = resolveChoice(
      permission.kind === "selected" ? permission.value : undefined,
      permission.kind === "selected" ? permission.message : "",
    );
    if (result.disable) {
      enabled = false;
    }
    return result.block ? { block: true, reason: result.reason } : undefined;
  });
}
