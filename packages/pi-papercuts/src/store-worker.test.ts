import { expect, it } from "vitest";
import { createPapercutStore, type PapercutProposal } from "./store.js";

const root = process.env.PAPERCUT_WORKER_ROOT;
const key = process.env.PAPERCUT_WORKER_KEY;
if (!root || !key) {
  throw new Error("Expected PAPERCUT_WORKER_ROOT and PAPERCUT_WORKER_KEY.");
}

const proposal: PapercutProposal = {
  key,
  title: `Concurrent ${key}`,
  trigger: `Trigger ${key}`,
  impact: "Concurrent writers must not lose this record.",
  currentGap: "The registry must serialize cross-process writes.",
  proposedResolution: "Use the registry lock and atomic replacement.",
  suggestedDestination: "tooling",
};

it("writes its proposal", async () => {
  await expect(
    createPapercutStore(root).propose(proposal, {
      kind: "agent",
      sessionId: key,
    }),
  ).resolves.toMatchObject({ kind: "created" });
});
