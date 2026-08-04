import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderGuidance } from "./catalogue.js";

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const guidance = renderGuidance(
      event.systemPromptOptions.selectedTools ?? [],
    );
    if (!guidance) {
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });
}
