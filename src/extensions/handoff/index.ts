import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { retryAssistantCall, uuidv7 } from "@earendil-works/pi-ai";
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
import {
  createChildArtifact,
  findUnresolvedChildArtifacts,
  removeChildArtifact,
  validateChildArtifact,
} from "./artifact";
import {
  ATTEMPT_TYPE,
  attemptFromEntry,
  DELIVERY_TYPE,
  getEligibleTransition,
  sameModel,
  TRANSITION_TYPE,
  type DraftData,
  type AttemptData,
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

function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function appendEntry<T>(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  customType: string,
  data: T,
): string {
  const path = parentSession(ctx);
  if (!path) {
    throw new Error("Handoff state requires a persisted session.");
  }
  pi.appendEntry(customType, data);
  const durable = SessionManager.open(path, ctx.sessionManager.getSessionDir());
  const entry = durable.getBranch().at(-1);
  if (
    entry?.type !== "custom" ||
    entry.customType !== customType ||
    !sameData(entry.data, data)
  ) {
    throw new Error("Handoff state could not be durably persisted.");
  }
  return entry.id;
}

function sameBranch(
  current: ReturnType<SessionManager["getBranch"]>,
  persisted: ReturnType<SessionManager["getBranch"]>,
): boolean {
  return (
    current.length === persisted.length &&
    current.every(
      (entry, index) =>
        entry.id === persisted[index]?.id &&
        entry.type === persisted[index]?.type,
    )
  );
}

function currentAndPersistedTransition(
  ctx: ExtensionContext,
  parentPath: string,
): EligibleTransition | undefined {
  if (parentSession(ctx) !== parentPath || !ctx.model) {
    return undefined;
  }
  const currentHeader = ctx.sessionManager.getHeader();
  if (!currentHeader || currentHeader.cwd !== ctx.cwd) {
    return undefined;
  }
  let persisted: SessionManager;
  try {
    persisted = SessionManager.open(
      parentPath,
      ctx.sessionManager.getSessionDir(),
    );
  } catch {
    return undefined;
  }
  const persistedHeader = persisted.getHeader();
  const currentBranch = ctx.sessionManager.getBranch();
  const persistedBranch = persisted.getBranch();
  if (
    !persistedHeader ||
    persisted.getSessionFile() !== parentPath ||
    persistedHeader.id !== currentHeader.id ||
    persistedHeader.cwd !== ctx.cwd ||
    persisted.getLeafId() !== ctx.sessionManager.getLeafId() ||
    !sameBranch(currentBranch, persistedBranch)
  ) {
    return undefined;
  }
  const model = identity(ctx.model);
  const current = getEligibleTransition(currentBranch, model);
  const durable = getEligibleTransition(persistedBranch, model);
  if (!current || !durable || current.entry.id !== durable.entry.id) {
    return undefined;
  }
  return durable;
}

async function eligibleTransition(
  ctx: ExtensionContext,
  parentPath: string,
  blockedTransitions: ReadonlySet<string>,
): Promise<{ transition?: EligibleTransition; unresolvedChildren: string[] }> {
  const transition = currentAndPersistedTransition(ctx, parentPath);
  if (!transition) {
    return { unresolvedChildren: [] };
  }
  const unresolvedChildren = await findUnresolvedChildArtifacts({
    cwd: ctx.cwd,
    sessionDir: ctx.sessionManager.getSessionDir(),
    parentPath,
    target: transition.data.target,
    transitionId: transition.data.transitionId,
    source: transition.data.source,
  });
  return unresolvedChildren.length > 0 ||
    blockedTransitions.has(transition.data.transitionId)
    ? { unresolvedChildren }
    : { transition, unresolvedChildren };
}

function durableAttempt(
  ctx: ExtensionContext,
  parentPath: string,
  data: AttemptData,
): string | undefined {
  try {
    const parent = SessionManager.open(
      parentPath,
      ctx.sessionManager.getSessionDir(),
    );
    if (parent.getHeader()?.id !== ctx.sessionManager.getHeader()?.id) {
      return undefined;
    }
    return parent
      .getBranch()
      .map(attemptFromEntry)
      .find((attempt) => attempt && sameData(attempt.data, data))?.entry.id;
  } catch {
    return undefined;
  }
}

function appendAttempt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: AttemptData,
): string {
  const id = appendEntry(pi, ctx, ATTEMPT_TYPE, data);
  const path = parentSession(ctx);
  if (!path || durableAttempt(ctx, path, data) !== id) {
    throw new Error("Handoff attempt could not be durably persisted.");
  }
  return id;
}

async function generatePrompt(
  ctx: ExtensionCommandContext,
  source: { provider: string; id: string },
  focus: string,
): Promise<string | undefined> {
  const sourceModel = ctx.modelRegistry.find(source.provider, source.id);
  const provider = ctx.modelRegistry.getProvider(source.provider);
  if (!sourceModel || !provider) {
    ctx.ui.notify(
      "Handoff cancelled: captured source model is unavailable.",
      "error",
    );
    return undefined;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sourceModel);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify(
      `Handoff cancelled: ${auth.ok ? "source model has no API key" : auth.error}`,
      "error",
    );
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
    loader.onAbort = () => done(undefined);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, loader.signal])
      : loader.signal;
    const maxTokens =
      typeof sourceModel.maxTokens === "number" && sourceModel.maxTokens > 0
        ? Math.min(4096, sourceModel.maxTokens)
        : 4096;
    void retryAssistantCall(
      () =>
        provider
          .streamSimple(
            sourceModel,
            { systemPrompt: HANDOFF_INSTRUCTIONS, messages: [request] },
            {
              apiKey: auth.apiKey,
              headers: auth.headers,
              env: auth.env,
              signal,
              maxTokens,
              cacheRetention: "none",
              sessionId: uuidv7(),
            },
          )
          .result(),
      { enabled: true, maxRetries: 2, baseDelayMs: 500 },
      signal,
    )
      .then((response) => {
        if (response.stopReason === "aborted") {
          ctx.ui.notify("Handoff cancelled.", "info");
          done(undefined);
          return;
        }
        if (response.stopReason === "error") {
          ctx.ui.notify(
            `Handoff cancelled: ${response.errorMessage || "source generation failed"}`,
            "error",
          );
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

function latestDraft(ctx: ExtensionContext) {
  const path = parentSession(ctx);
  const header = ctx.sessionManager.getHeader();
  if (!path || !header?.parentSession || !ctx.model) {
    return undefined;
  }
  try {
    const child = validateChildArtifact({
      manager: ctx.sessionManager,
      path,
      sessionDir: ctx.sessionManager.getSessionDir(),
      parentPath: header.parentSession,
      cwd: ctx.cwd,
      target: identity(ctx.model),
    });
    const parent = SessionManager.open(
      header.parentSession,
      ctx.sessionManager.getSessionDir(),
    );
    const committed = parent
      .getBranch()
      .map(attemptFromEntry)
      .find(
        (attempt) =>
          attempt?.data.status === "committed" &&
          attempt.data.childSessionId === child.sessionId &&
          attempt.data.childPath === path &&
          attempt.data.childDraftEntryId === child.draftEntryId &&
          sameData(attempt.data.draft, child.draft) &&
          sameModel(attempt.data.target, child.draft.target),
      );
    return committed ? child : undefined;
  } catch {
    return undefined;
  }
}

function appendDelivery(ctx: ExtensionContext, data: unknown): void {
  const path = parentSession(ctx);
  if (!path) {
    throw new Error("Handoff state requires a persisted session.");
  }
  (
    ctx.sessionManager as unknown as {
      appendCustomEntry(customType: string, value: unknown): void;
    }
  ).appendCustomEntry(DELIVERY_TYPE, data);
  const durable = SessionManager.open(path, ctx.sessionManager.getSessionDir());
  const entry = durable.getBranch().at(-1);
  if (
    entry?.type !== "custom" ||
    entry.customType !== DELIVERY_TYPE ||
    !sameData(entry.data, data)
  ) {
    throw new Error("Handoff delivery could not be durably persisted.");
  }
}

function deliverDraft(ctx: ExtensionContext, allowDelivered: boolean): boolean {
  if (ctx.mode !== "tui") {
    return false;
  }
  const draft = latestDraft(ctx);
  if (!draft || (!allowDelivered && draft.delivered)) {
    return false;
  }
  try {
    ctx.ui.setEditorText(draft.draft.prompt);
    if (!draft.delivered) {
      appendDelivery(ctx, {
        version: 1,
        transitionId: draft.draft.transitionId,
        draftEntryId: draft.draftEntryId,
        target: draft.draft.target,
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
  const blockedTransitions = new Set<string>();

  pi.on("model_select", async (event, ctx) => {
    if (
      event.source === "restore" ||
      !event.previousModel ||
      (event.previousModel.provider === event.model.provider &&
        event.previousModel.id === event.model.id) ||
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
    if (!deliverDraft(ctx, false) && ctx.mode === "tui") {
      const path = parentSession(ctx);
      const header = ctx.sessionManager.getHeader();
      if (path && header?.parentSession) {
        ctx.ui.notify(
          `Handoff draft was not delivered. Reopen child ${path} with its recorded target, then run /handoff-recover. Parent: ${header.parentSession}.`,
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
      if (!deliverDraft(ctx, true)) {
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
      let switchStarted = false;
      let parentPath: string | undefined;
      let childPath: string | undefined;
      try {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Handoff requires TUI mode.", "error");
          return;
        }
        parentPath = parentSession(ctx);
        if (!parentPath) {
          ctx.ui.notify(
            "Handoff requires a persisted parent session.",
            "error",
          );
          return;
        }
        const eligibility = await eligibleTransition(
          ctx,
          parentPath,
          blockedTransitions,
        );
        if (eligibility.unresolvedChildren.length > 0) {
          ctx.ui.notify(
            `Handoff transition remains consumed by unresolved child: ${eligibility.unresolvedChildren.join(", ")}. Parent: ${parentPath}.`,
            "error",
          );
          return;
        }
        const transition = eligibility.transition;
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
        const revalidated = await eligibleTransition(
          ctx,
          parentPath,
          blockedTransitions,
        );
        if (
          revalidated.unresolvedChildren.length > 0 ||
          !revalidated.transition ||
          revalidated.transition.entry.id !== transition.entry.id
        ) {
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
        childPath = child.path;
        const beforeCommit = currentAndPersistedTransition(ctx, parentPath);
        if (
          blockedTransitions.has(transition.data.transitionId) ||
          !beforeCommit ||
          beforeCommit.entry.id !== transition.entry.id
        ) {
          await removeChildArtifact({
            path: child.path,
            sessionDir,
            parentPath,
            cwd: ctx.cwd,
            childSessionId: child.sessionId,
            childDraftEntryId: child.draftEntryId,
            target: transition.data.target,
            draft,
          });
          ctx.ui.notify(
            "Handoff cancelled: the parent session changed before commit.",
            "error",
          );
          return;
        }
        let attemptId: string;
        try {
          attemptId = appendAttempt(pi, ctx, {
            version: 1,
            status: "committed",
            transitionEntryId: transition.entry.id,
            childSessionId: child.sessionId,
            childPath: child.path,
            childDraftEntryId: child.draftEntryId,
            target: transition.data.target,
            draft,
          });
        } catch (error) {
          blockedTransitions.add(transition.data.transitionId);
          const committed: AttemptData = {
            version: 1,
            status: "committed",
            transitionEntryId: transition.entry.id,
            childSessionId: child.sessionId,
            childPath: child.path,
            childDraftEntryId: child.draftEntryId,
            target: transition.data.target,
            draft,
          };
          if (durableAttempt(ctx, parentPath, committed)) {
            ctx.ui.notify(
              `Handoff commit was persisted but could not be confirmed in the active runtime. Parent: ${parentPath}. Child: ${child.path}.`,
              "error",
            );
            return;
          }
          try {
            await removeChildArtifact({
              path: child.path,
              sessionDir,
              parentPath,
              cwd: ctx.cwd,
              childSessionId: child.sessionId,
              childDraftEntryId: child.draftEntryId,
              target: transition.data.target,
              draft,
            });
          } catch (cleanupError) {
            ctx.ui.notify(
              `Handoff commit is unresolved. Parent: ${parentPath}. Child: ${child.path}. ${cleanupError instanceof Error ? cleanupError.message : "cleanup failed"}`,
              "error",
            );
            return;
          }
          ctx.ui.notify(
            `Handoff commit was not persisted; its removed child was ${child.path}. Parent: ${parentPath}. ${error instanceof Error ? error.message : "persistence failed"}`,
            "error",
          );
          return;
        }
        ctx.ui.notify(
          `Handoff committed. If replacement cannot start, recover parent ${parentPath} and child ${child.path}; no rollback will occur.`,
          "warning",
        );
        switchStarted = true;
        const result = await ctx.switchSession(child.path, {
          withSession: async (childCtx) => {
            deliverDraft(childCtx, false);
          },
        });
        if (!result.cancelled) {
          return;
        }
        try {
          await removeChildArtifact({
            path: child.path,
            sessionDir,
            parentPath,
            cwd: ctx.cwd,
            childSessionId: child.sessionId,
            childDraftEntryId: child.draftEntryId,
            target: transition.data.target,
            draft,
          });
          try {
            appendAttempt(pi, ctx, {
              version: 1,
              status: "cancelled",
              committedAttemptId: attemptId,
              transitionEntryId: transition.entry.id,
              childSessionId: child.sessionId,
              childPath: child.path,
            });
          } catch (error) {
            blockedTransitions.add(transition.data.transitionId);
            ctx.ui.notify(
              `Handoff switch cancellation remains consumed because its cancellation record was not persisted. Parent: ${parentPath}. Child: ${child.path}. ${error instanceof Error ? error.message : "persistence failed"}`,
              "error",
            );
            return;
          }
          ctx.ui.notify(
            "Handoff switch cancelled. The transition is available to retry.",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `Handoff switch cancelled, but its committed child remains consumed. Parent: ${parentPath}. Child: ${child.path}. ${error instanceof Error ? error.message : "cleanup failed"}`,
            "error",
          );
        }
      } catch (error) {
        if (!switchStarted) {
          ctx.ui.notify(
            `Handoff stopped. Parent: ${parentPath ?? "unknown"}. Child: ${childPath ?? "none"}. ${error instanceof Error ? error.message : "unexpected failure"}`,
            "error",
          );
        }
      } finally {
        handoffInProgress = false;
      }
    },
  });
}
