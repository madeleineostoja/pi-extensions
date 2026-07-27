import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  compact,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { prepareCompaction } from "./compaction";
import {
  buildModelRef,
  computeHandoffEstimate,
  getSwitchSkipReason,
} from "./decision";
import {
  clearPendingHandoff,
  getPendingHandoff,
  setPendingHandoff,
} from "./handoff";
import { formatSwitchNotification, HANDOFF_INSTRUCTIONS } from "./prompt";

export default function (pi: ExtensionAPI) {
  pi.on("model_select", async (event, ctx) => {
    const switchSkipReason = getSwitchSkipReason(event, ctx.mode);
    if (switchSkipReason) {
      return;
    }

    const branchEntries = ctx.sessionManager.getBranch();
    const settings = SettingsManager.create(
      ctx.cwd,
      getAgentDir(),
    ).getCompactionSettings();
    const preparation = prepareCompaction(branchEntries, settings);
    if (!preparation) {
      return;
    }

    const allMessages = [
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ];
    if (allMessages.length === 0) {
      return;
    }

    const targetRef = buildModelRef(
      event.model,
      ctx.modelRegistry.isUsingOAuth(event.model),
    );

    const estimate = computeHandoffEstimate(preparation, targetRef);
    const notification = formatSwitchNotification(targetRef, estimate);

    if (ctx.mode === "tui") {
      setTimeout(() => ctx.ui.notify(notification, "info"), 0);
    } else {
      ctx.ui.notify(notification, "info");
    }
  });

  pi.registerCommand("handoff", {
    description: "Compact the current context using the previous model",
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      let lastAssistant: { provider: string; model: string } | undefined;
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          lastAssistant = entry.message as { provider: string; model: string };
          break;
        }
      }

      if (!lastAssistant) {
        ctx.ui.notify("no prior model to hand off from", "error");
        return;
      }

      const currentModel = ctx.model;
      if (
        currentModel &&
        lastAssistant.provider === currentModel.provider &&
        lastAssistant.model === currentModel.id
      ) {
        ctx.ui.notify("no prior model to hand off from", "error");
        return;
      }

      const previousModel = ctx.modelRegistry.find(
        lastAssistant.provider,
        lastAssistant.model,
      );
      if (!previousModel) {
        ctx.ui.notify("previous model unavailable for handoff", "error");
        return;
      }

      setPendingHandoff({ previousModel });
      ctx.compact({
        customInstructions: HANDOFF_INSTRUCTIONS,
        onComplete: () => {
          clearPendingHandoff();
        },
        onError: () => {
          clearPendingHandoff();
        },
      });
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const pending = getPendingHandoff();
    if (!pending) {
      return undefined;
    }

    const { previousModel } = pending;
    clearPendingHandoff();

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(previousModel);
    if (!auth.ok) {
      ctx.ui.notify(`Handoff cancelled: ${auth.error}`, "error");
      return { cancel: true };
    }

    const result = await compact(
      event.preparation,
      previousModel,
      auth.apiKey,
      auth.headers,
      HANDOFF_INSTRUCTIONS,
      event.signal,
    );

    return { compaction: result };
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    clearPendingHandoff();
  });
}
