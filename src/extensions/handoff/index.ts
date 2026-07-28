import { access } from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  buildSessionContext,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { createChildArtifact, removeChildArtifact } from "./artifact";
import {
  ATTEMPT_TYPE,
  DELIVERY_TYPE,
  deliveryFromEntry,
  draftFromEntry,
  DRAFT_TYPE,
  getEligibleTransition,
  hasConversationMessages,
  sameModel,
  TRANSITION_TYPE,
  type DraftData,
  type EligibleTransition,
  type ModelIdentity,
} from "./state";

const HANDOFF_INSTRUCTIONS = `Create a concise, task-agnostic continuation prompt for another model. Include the current goal, constraints and user preferences, decisions and rationale, completed and ongoing work, relevant files or external artifacts, blockers and uncertainty, and useful next actions. Adapt to the conversation rather than assuming coding or execution. Output only the continuation prompt.`;

function identity(model: { provider: string; id: string }): ModelIdentity {
  return { provider: model.provider, id: model.id };
}

function parentSession(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionFile();
}

function appendEntry<T>(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  customType: string,
  data: T,
): string {
  pi.appendEntry(customType, data);
  const entry = ctx.sessionManager.getBranch().at(-1);
  if (entry?.type !== "custom" || entry.customType !== customType) {
    throw new Error("Handoff state could not be persisted.");
  }
  return entry.id;
}

async function eligibleTransition(
  ctx: ExtensionContext,
  parentPath: string,
): Promise<EligibleTransition | undefined> {
  if (parentSession(ctx) !== parentPath || !ctx.model) {
    return undefined;
  }
  try {
    await access(parentPath);
  } catch {
    return undefined;
  }
  return getEligibleTransition(
    ctx.sessionManager.getBranch(),
    identity(ctx.model),
  );
}

async function generatePrompt(
  ctx: ExtensionCommandContext,
  source: { provider: string; id: string },
  focus: string,
): Promise<string | undefined> {
  const sourceModel = ctx.modelRegistry.find(source.provider, source.id);
  if (!sourceModel) {
    ctx.ui.notify(
      "Handoff cancelled: captured source model is unavailable.",
      "error",
    );
    return undefined;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sourceModel);
  if (!auth.ok) {
    ctx.ui.notify(`Handoff cancelled: ${auth.error}`, "error");
    return undefined;
  }
  const sessionContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  const conversation = serializeConversation(
    convertToLlm(sessionContext.messages),
  );
  const request: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `${focus ? `Focus for this transfer: ${focus}\n\n` : ""}Conversation:\n${conversation}`,
      },
    ],
    timestamp: Date.now(),
  };
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const loader = new BorderedLoader(
      tui,
      theme,
      "Generating handoff prompt...",
    );
    loader.onAbort = () => {
      ctx.ui.notify("Handoff cancelled.", "info");
      done(undefined);
    };
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, loader.signal])
      : loader.signal;
    void complete(
      sourceModel,
      { systemPrompt: HANDOFF_INSTRUCTIONS, messages: [request] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
        maxTokens: 4096,
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    )
      .then((response) => {
        if (response.stopReason === "aborted") {
          ctx.ui.notify("Handoff cancelled.", "info");
          done(undefined);
          return;
        }
        const prompt = response.content
          .filter(
            (content): content is { type: "text"; text: string } =>
              content.type === "text",
          )
          .map((content) => content.text)
          .join("\n")
          .trim();
        if (!prompt) {
          ctx.ui.notify(
            "Handoff cancelled: source model returned an empty prompt.",
            "error",
          );
          done(undefined);
          return;
        }
        done(prompt);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) {
          ctx.ui.notify(
            `Handoff cancelled: ${error instanceof Error ? error.message : "source generation failed"}`,
            "error",
          );
        }
        done(undefined);
      });
    return loader;
  });
}

function latestDraft(ctx: ExtensionContext):
  | {
      entryId: string;
      data: DraftData;
      delivered: boolean;
    }
  | undefined {
  const header = ctx.sessionManager.getHeader();
  if (!header?.parentSession || header.cwd !== ctx.cwd || !parentSession(ctx)) {
    return undefined;
  }
  const branch = ctx.sessionManager.getBranch();
  if (hasConversationMessages(branch)) {
    return undefined;
  }
  for (let index = branch.length - 1; index >= 0; index--) {
    const draft = draftFromEntry(branch[index]);
    if (
      !draft ||
      !sameModel(ctx.model && identity(ctx.model), draft.data.target)
    ) {
      continue;
    }
    const delivered = branch.some((entry) => {
      const delivery = deliveryFromEntry(entry);
      return delivery?.data.draftEntryId === draft.entry.id;
    });
    return { entryId: draft.entry.id, data: draft.data, delivered };
  }
  return undefined;
}

function deliverDraft(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  allowDelivered: boolean,
): boolean {
  if (ctx.mode !== "tui") {
    return false;
  }
  const draft = latestDraft(ctx);
  if (!draft || (!allowDelivered && draft.delivered)) {
    return false;
  }
  try {
    ctx.ui.setEditorText(draft.data.prompt);
    if (!draft.delivered) {
      appendEntry(pi, ctx, DELIVERY_TYPE, {
        version: 1,
        transitionId: draft.data.transitionId,
        draftEntryId: draft.entryId,
        target: draft.data.target,
      });
    }
    return true;
  } catch (error) {
    ctx.ui.notify(
      `Handoff draft remains recoverable: ${error instanceof Error ? error.message : "editor delivery failed"}`,
      "error",
    );
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let handoffInProgress = false;

  pi.on("model_select", async (event, ctx) => {
    if (
      event.source === "restore" ||
      !event.previousModel ||
      event.previousModel.provider === event.model.provider ||
      event.previousModel.id === event.model.id ||
      !parentSession(ctx)
    ) {
      return;
    }
    appendEntry(pi, ctx, TRANSITION_TYPE, {
      version: 1,
      transitionId: uuidv7(),
      source: identity(event.previousModel),
      target: identity(event.model),
      branchLeafId: ctx.sessionManager.getLeafId(),
    });
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!deliverDraft(pi, ctx, false) && ctx.mode === "tui") {
      const branch = ctx.sessionManager.getBranch();
      const hasDraft = branch.some(
        (entry) => entry.type === "custom" && entry.customType === DRAFT_TYPE,
      );
      if (hasDraft && !hasConversationMessages(branch)) {
        const header = ctx.sessionManager.getHeader();
        ctx.ui.notify(
          `Handoff draft was not delivered. Reopen child ${parentSession(ctx) ?? "(ephemeral)"} with its recorded target model, then run /handoff-recover. Parent: ${header?.parentSession ?? "unknown"}.`,
          "warning",
        );
      }
    }
  });

  pi.registerCommand("handoff-recover", {
    description:
      "Restore this handoff draft into the editor without submitting it",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Handoff recovery requires TUI mode.", "error");
        return;
      }
      if (!deliverDraft(pi, ctx, true)) {
        ctx.ui.notify(
          "No matching empty handoff child draft is available to recover.",
          "error",
        );
        return;
      }
      ctx.ui.notify(
        "Handoff draft restored. Review and submit when ready.",
        "info",
      );
    },
  });

  pi.registerCommand("handoff", {
    description:
      "Create a focused child session from the captured model transition",
    handler: async (args, ctx) => {
      if (handoffInProgress) {
        ctx.ui.notify("Handoff already in progress.", "error");
        return;
      }
      handoffInProgress = true;
      try {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Handoff requires TUI mode.", "error");
          return;
        }
        const parentPath = parentSession(ctx);
        if (!parentPath) {
          ctx.ui.notify(
            "Handoff requires a persisted parent session.",
            "error",
          );
          return;
        }
        const transition = await eligibleTransition(ctx, parentPath);
        if (!transition) {
          ctx.ui.notify(
            "No eligible model transition. Switch to a different model, then try /handoff again.",
            "error",
          );
          return;
        }
        const generated = await generatePrompt(
          ctx,
          transition.data.source,
          args.trim(),
        );
        if (!generated) {
          return;
        }
        const reviewed = await ctx.ui.editor(
          "Review handoff prompt",
          generated,
        );
        const prompt = reviewed?.trim();
        if (!prompt) {
          ctx.ui.notify("Handoff cancelled.", "info");
          return;
        }
        const revalidated = await eligibleTransition(ctx, parentPath);
        if (!revalidated || revalidated.entry.id !== transition.entry.id) {
          ctx.ui.notify(
            "Handoff cancelled: the parent session changed during review.",
            "error",
          );
          return;
        }
        const sessionDir = ctx.sessionManager.getSessionDir();
        const draft: DraftData = {
          version: 1,
          transitionId: transition.data.transitionId,
          source: transition.data.source,
          target: transition.data.target,
          prompt,
        };
        const child = await createChildArtifact({
          cwd: ctx.cwd,
          sessionDir,
          parentPath,
          target: transition.data.target,
          draft,
        });
        const beforeCommit = await eligibleTransition(ctx, parentPath);
        if (!beforeCommit || beforeCommit.entry.id !== transition.entry.id) {
          await removeChildArtifact({
            path: child.path,
            sessionDir,
            parentPath,
            childSessionId: child.sessionId,
          });
          ctx.ui.notify(
            "Handoff cancelled: the parent session changed before commit.",
            "error",
          );
          return;
        }
        const attemptId = appendEntry(pi, ctx, ATTEMPT_TYPE, {
          version: 1,
          status: "committed",
          transitionEntryId: transition.entry.id,
          childSessionId: child.sessionId,
          childPath: child.path,
          childDraftEntryId: child.draftEntryId,
          target: transition.data.target,
        });
        const result = await ctx.switchSession(child.path);
        if (!result.cancelled) {
          return;
        }
        try {
          await removeChildArtifact({
            path: child.path,
            sessionDir,
            parentPath,
            childSessionId: child.sessionId,
          });
          appendEntry(pi, ctx, ATTEMPT_TYPE, {
            version: 1,
            status: "cancelled",
            committedAttemptId: attemptId,
            transitionEntryId: transition.entry.id,
            childSessionId: child.sessionId,
            childPath: child.path,
          });
          ctx.ui.notify(
            "Handoff switch cancelled. The transition is available to retry.",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `Handoff switch cancelled, but its committed child remains consumed at ${child.path}: ${error instanceof Error ? error.message : "cleanup failed"}`,
            "error",
          );
        }
      } catch (error) {
        ctx.ui.notify(
          `Handoff stopped. Parent and any committed child remain recoverable: ${error instanceof Error ? error.message : "unexpected failure"}`,
          "error",
        );
      } finally {
        handoffInProgress = false;
      }
    },
  });
}
