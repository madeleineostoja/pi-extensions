import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  buildFooterLines,
  buildLeftSegment,
  buildRightSegment,
} from "./format.js";

export default function (pi: ExtensionAPI) {
  pi.on(
    "session_start",
    async (_event: SessionStartEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        return;
      }

      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: unsub,
          invalidate() {},
          render(width: number): string[] {
            const branch = footerData.getGitBranch();
            const left = buildLeftSegment(ctx.cwd, branch, theme);

            const model = ctx.model;
            const thinkingLevel = pi.getThinkingLevel();
            const usingSubscription = model
              ? ctx.modelRegistry.isUsingOAuth(model)
              : false;

            let totalCost = 0;
            for (const entry of ctx.sessionManager.getEntries()) {
              if (
                entry.type === "message" &&
                entry.message.role === "assistant"
              ) {
                const total = (
                  entry.message as { usage?: { cost?: { total?: number } } }
                ).usage?.cost?.total;
                if (typeof total === "number") {
                  totalCost += total;
                }
              }
            }

            const contextUsage = ctx.getContextUsage();
            const footerModel = model
              ? { name: model.name, id: model.id, provider: model.provider }
              : undefined;
            const rightWithWindow = buildRightSegment(
              footerModel,
              thinkingLevel,
              totalCost,
              contextUsage,
              usingSubscription,
              theme,
              true,
              false,
            );

            const rightWithoutWindow = buildRightSegment(
              footerModel,
              thinkingLevel,
              totalCost,
              contextUsage,
              usingSubscription,
              theme,
              false,
              false,
            );

            return buildFooterLines(
              width,
              left,
              rightWithWindow,
              rightWithoutWindow,
              footerData.getExtensionStatuses(),
              theme,
            );
          },
        };
      });
    },
  );
}
