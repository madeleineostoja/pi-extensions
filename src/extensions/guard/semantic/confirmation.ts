import { promptForPermission } from "#lib/permission-prompt";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardRuntimeState } from "../state.js";
import { assessBashCommand } from "./assessors.js";
import { resolveChoice } from "./handler.js";
import { formatRisks } from "./format.js";

export async function confirmBashCommand(options: {
  command: string;
  cwd: string;
  state: GuardRuntimeState;
  ctx: ExtensionContext;
}): Promise<void> {
  if (!options.state.semanticConfirmationEnabled() || !options.ctx.hasUI) {
    return;
  }
  const risks = await assessBashCommand(options.command, options.cwd);
  if (!risks.length) {
    return;
  }
  const permission = await promptForPermission({
    ui: options.ctx.ui,
    signal: options.ctx.signal,
    title: "Guard: confirm risky Bash command?",
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
    options.state.setSemanticConfirmationEnabled(false);
  }
  if (result.block) {
    throw new Error(result.reason ?? "Guard: Bash command was blocked.");
  }
}
