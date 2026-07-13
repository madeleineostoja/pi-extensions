import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createPapercutStore, type PapercutProposal } from "./store.js";

const root = process.env.PAPERCUT_WORKER_ROOT;
const key = process.env.PAPERCUT_WORKER_KEY;
const expectation = process.env.PAPERCUT_WORKER_EXPECT ?? "created";
const resultPath = process.env.PAPERCUT_WORKER_RESULT;
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

it("performs its lock operation", async () => {
  const startedAt = Date.now();
  const attempt = createPapercutStore(root).propose(proposal, {
    kind: "agent",
    sessionId: key,
  });
  if (expectation === "blocked") {
    await expect(attempt).rejects.toThrow("active or unverifiable");
  } else {
    await expect(attempt).resolves.toMatchObject({ kind: "created" });
  }
  if (resultPath) {
    writeFileSync(resultPath, `${Date.now() - startedAt}\n`);
  }
});
