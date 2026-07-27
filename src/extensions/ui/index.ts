import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getAverageCacheHitRate, getFooterCostInfo } from "./cost.js";
import {
  buildFooterLines,
  buildLeftSegment,
  buildRightSegment,
} from "./format.js";

export default function (pi: ExtensionAPI) {
  pi.on(
    "session_start",
    async (_event: SessionStartEvent, ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") {
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
            const branchEntries = ctx.sessionManager.getBranch();
            const { totalCost, hideCost } = getFooterCostInfo(
              branchEntries,
              ctx.modelRegistry,
              model,
            );
            const contextUsage = ctx.getContextUsage();
            const footerModel = model
              ? { name: model.name, id: model.id, provider: model.provider }
              : undefined;
            const cacheHitRate = getAverageCacheHitRate(branchEntries);

            const rightWithWindow = buildRightSegment(
              footerModel,
              thinkingLevel,
              totalCost,
              contextUsage,
              hideCost,
              theme,
              true,
              false,
              cacheHitRate,
            );

            const rightWithoutWindow = buildRightSegment(
              footerModel,
              thinkingLevel,
              totalCost,
              contextUsage,
              hideCost,
              theme,
              false,
              false,
              cacheHitRate,
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
