import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TRANSITION_TYPE = "pipkin.handoff.transition.v1";
export const ATTEMPT_TYPE = "pipkin.handoff.attempt.v1";
export const DRAFT_TYPE = "pipkin.handoff.draft.v1";
export const DELIVERY_TYPE = "pipkin.handoff.delivery.v1";

export type ModelIdentity = { provider: string; id: string };

export type TransitionData = {
  version: 1;
  transitionId: string;
  source: ModelIdentity;
  target: ModelIdentity;
  branchLeafId: string | null;
};

export type CommittedAttemptData = {
  version: 1;
  status: "committed";
  transitionEntryId: string;
  childSessionId: string;
  childPath: string;
  childDraftEntryId: string;
  target: ModelIdentity;
};

export type CancelledAttemptData = {
  version: 1;
  status: "cancelled";
  committedAttemptId: string;
  transitionEntryId: string;
  childSessionId: string;
  childPath: string;
};

export type AttemptData = CommittedAttemptData | CancelledAttemptData;

export type DraftData = {
  version: 1;
  transitionId: string;
  source: ModelIdentity;
  target: ModelIdentity;
  prompt: string;
};

export type DeliveryData = {
  version: 1;
  transitionId: string;
  draftEntryId: string;
  target: ModelIdentity;
};

type CustomEntry = Extract<SessionEntry, { type: "custom" }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelIdentity(value: unknown): value is ModelIdentity {
  return (
    isObject(value) &&
    typeof value.provider === "string" &&
    typeof value.id === "string"
  );
}

function customData<T>(
  entry: SessionEntry,
  customType: string,
  guard: (data: unknown) => data is T,
): { entry: CustomEntry; data: T } | undefined {
  if (
    entry.type !== "custom" ||
    entry.customType !== customType ||
    !guard(entry.data)
  ) {
    return undefined;
  }
  return { entry, data: entry.data };
}

export function transitionFromEntry(
  entry: SessionEntry,
): { entry: CustomEntry; data: TransitionData } | undefined {
  return customData(
    entry,
    TRANSITION_TYPE,
    (data): data is TransitionData =>
      isObject(data) &&
      data.version === 1 &&
      typeof data.transitionId === "string" &&
      isModelIdentity(data.source) &&
      isModelIdentity(data.target) &&
      (typeof data.branchLeafId === "string" || data.branchLeafId === null),
  );
}

export function attemptFromEntry(
  entry: SessionEntry,
): { entry: CustomEntry; data: AttemptData } | undefined {
  return customData(entry, ATTEMPT_TYPE, (data): data is AttemptData => {
    if (
      !isObject(data) ||
      data.version !== 1 ||
      typeof data.transitionEntryId !== "string"
    ) {
      return false;
    }
    if (data.status === "committed") {
      return (
        typeof data.childSessionId === "string" &&
        typeof data.childPath === "string" &&
        typeof data.childDraftEntryId === "string" &&
        isModelIdentity(data.target)
      );
    }
    return (
      data.status === "cancelled" &&
      typeof data.committedAttemptId === "string" &&
      typeof data.childSessionId === "string" &&
      typeof data.childPath === "string"
    );
  });
}

export function draftFromEntry(
  entry: SessionEntry,
): { entry: CustomEntry; data: DraftData } | undefined {
  return customData(
    entry,
    DRAFT_TYPE,
    (data): data is DraftData =>
      isObject(data) &&
      data.version === 1 &&
      typeof data.transitionId === "string" &&
      typeof data.prompt === "string" &&
      isModelIdentity(data.source) &&
      isModelIdentity(data.target),
  );
}

export function deliveryFromEntry(
  entry: SessionEntry,
): { entry: CustomEntry; data: DeliveryData } | undefined {
  return customData(
    entry,
    DELIVERY_TYPE,
    (data): data is DeliveryData =>
      isObject(data) &&
      data.version === 1 &&
      typeof data.transitionId === "string" &&
      typeof data.draftEntryId === "string" &&
      isModelIdentity(data.target),
  );
}

export function sameModel(
  a: ModelIdentity | undefined,
  b: ModelIdentity,
): boolean {
  return a?.provider === b.provider && a.id === b.id;
}

export type EligibleTransition = {
  entry: CustomEntry;
  data: TransitionData;
};

export function getEligibleTransition(
  branch: SessionEntry[],
  currentModel: ModelIdentity | undefined,
): EligibleTransition | undefined {
  let transitionIndex = -1;
  let transition: EligibleTransition | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const candidate = transitionFromEntry(branch[index]);
    if (candidate) {
      transitionIndex = index;
      transition = candidate;
      break;
    }
  }
  if (!transition || !sameModel(currentModel, transition.data.target)) {
    return undefined;
  }
  if (branch[transitionIndex - 1]?.id !== transition.data.branchLeafId) {
    return undefined;
  }

  for (let index = transitionIndex + 1; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type === "model_change") {
      return undefined;
    }
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.provider === transition.data.target.provider &&
      entry.message.model === transition.data.target.id
    ) {
      return undefined;
    }
  }

  const committed = new Map<string, CommittedAttemptData>();
  const released = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === ATTEMPT_TYPE) {
      const attempt = attemptFromEntry(entry);
      if (!attempt) {
        return undefined;
      }
      if (attempt.data.transitionEntryId !== transition.entry.id) {
        continue;
      }
      if (attempt.data.status === "committed") {
        if (!sameModel(attempt.data.target, transition.data.target)) {
          return undefined;
        }
        committed.set(attempt.entry.id, attempt.data);
        continue;
      }
      const original = committed.get(attempt.data.committedAttemptId);
      if (
        !original ||
        released.has(attempt.data.committedAttemptId) ||
        original.childSessionId !== attempt.data.childSessionId ||
        original.childPath !== attempt.data.childPath
      ) {
        return undefined;
      }
      released.add(attempt.data.committedAttemptId);
    }
  }
  if ([...committed.keys()].some((attemptId) => !released.has(attemptId))) {
    return undefined;
  }
  return transition;
}

export function hasConversationMessages(entries: SessionEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant"),
  );
}
