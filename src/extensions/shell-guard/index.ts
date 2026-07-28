import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "#lib/permission-prompt";
import { assessBashCommand, type Risk } from "./assessors";
import { resolveChoice } from "./handler";

const DETAIL_LIMIT = 16_384;
const TRUNCATION = "\n… detail truncated at 16,384 characters";

function formatRisks(risks: Risk[]): string {
  const detail = risks
    .map((risk, index) => {
      const target = risk.targets.length
        ? `\nTargets: ${risk.targets.join(", ")}`
        : "";
      const uncertainty = risk.uncertainty ? `\n${risk.uncertainty}` : "";
      return `${index + 1}. [${risk.severity}] ${risk.category}: ${risk.effect}\n${risk.segment}${target}${uncertainty}`;
    })
    .join("\n\n");
  return detail.length <= DETAIL_LIMIT
    ? detail
    : detail.slice(0, DETAIL_LIMIT - TRUNCATION.length) + TRUNCATION;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || event.toolName !== "bash" || !ctx.hasUI) {
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
