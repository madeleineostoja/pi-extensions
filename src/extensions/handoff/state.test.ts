import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_TYPE,
  getEligibleTransition,
  TRANSITION_TYPE,
  type ModelIdentity,
} from "./state";

const source: ModelIdentity = { provider: "source", id: "one" };
const target: ModelIdentity = { provider: "target", id: "two" };

function entry(id: string, customType: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    data,
  } as SessionEntry;
}

function transition(
  id = "transition",
  from = source,
  to = target,
): SessionEntry[] {
  return [
    {
      type: "model_change",
      id: "model",
      parentId: null,
      timestamp: new Date().toISOString(),
      provider: to.provider,
      modelId: to.id,
    },
    entry(id, TRANSITION_TYPE, {
      version: 1,
      transitionId: id,
      source: from,
      target: to,
      branchLeafId: "model",
    }),
  ];
}

function committed(id = "commit") {
  return entry(id, ATTEMPT_TYPE, {
    version: 1,
    status: "committed",
    transitionEntryId: "transition",
    childSessionId: "child",
    childPath: "/child",
    childDraftEntryId: "draft",
    target,
    draft: {
      version: 1,
      transitionId: "transition",
      source,
      target,
      prompt: "Continue.",
    },
  });
}

function cancelled(id = "cancel", commit = "commit") {
  return entry(id, ATTEMPT_TYPE, {
    version: 1,
    status: "cancelled",
    committedAttemptId: commit,
    transitionEntryId: "transition",
    childSessionId: "child",
    childPath: "/child",
  });
}

describe("handoff transition reduction", () => {
  it("rejects same-model transitions", () => {
    const branch = transition("transition", source, source);
    expect(getEligibleTransition(branch, source)).toBeUndefined();
  });

  it("does not skip an invalid latest transition", () => {
    const branch = [
      ...transition(),
      entry("invalid", TRANSITION_TYPE, { version: 1 }),
    ];
    expect(getEligibleTransition(branch, target)).toBeUndefined();
  });

  it("rejects stale branches and target responses", () => {
    const stale = transition();
    const transitionEntry = stale[1] as Extract<
      SessionEntry,
      { type: "custom" }
    >;
    transitionEntry.data = {
      ...(transitionEntry.data as object),
      branchLeafId: "other-branch",
    };
    expect(getEligibleTransition(stale, target)).toBeUndefined();
    expect(
      getEligibleTransition(
        [
          ...transition(),
          {
            type: "message",
            id: "response",
            parentId: "transition",
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              provider: target.provider,
              model: target.id,
            },
          } as SessionEntry,
        ],
        target,
      ),
    ).toBeUndefined();
  });

  it("releases only the latest exact committed attempt", () => {
    expect(
      getEligibleTransition([...transition(), committed()], target),
    ).toBeUndefined();
    expect(
      getEligibleTransition(
        [...transition(), committed(), cancelled()],
        target,
      ),
    ).toMatchObject({ entry: { id: "transition" } });
    expect(
      getEligibleTransition(
        [...transition(), committed(), cancelled(), cancelled("again")],
        target,
      ),
    ).toBeUndefined();
    expect(
      getEligibleTransition(
        [...transition(), committed(), committed("second")],
        target,
      ),
    ).toBeUndefined();
    expect(
      getEligibleTransition([...transition(), cancelled()], target),
    ).toBeUndefined();
  });

  it("allows a valid reverse transition", () => {
    expect(
      getEligibleTransition(transition("transition", target, source), source),
    ).toMatchObject({ entry: { id: "transition" } });
  });
});
