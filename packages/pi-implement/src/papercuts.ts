import type { PapercutSource } from "pi-papercuts";

export type { PapercutSource } from "pi-papercuts";

export type PapercutProposalOutcome = {
  kind: "created" | "merged" | "ignored" | "resolved" | "rejected";
  reason?: string;
};

export type PapercutStore = {
  propose(
    proposal: unknown,
    source: PapercutSource,
  ): Promise<PapercutProposalOutcome>;
};

export type PapercutStoreFactory = (root: string) => Promise<PapercutStore>;

export type PapercutPersistenceResult = {
  created: number;
  merged: number;
  suppressed: number;
  rejected: number;
  warning?: string;
};

export function hasPapercutCandidates(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "papercuts") &&
    value.papercuts !== undefined
  );
}

export async function persistPapercutCandidates(
  value: unknown,
  root: string,
  source: PapercutSource,
  createStore: PapercutStoreFactory = createDefaultStore,
): Promise<PapercutPersistenceResult | undefined> {
  if (!hasPapercutCandidates(value)) {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.papercuts)) {
    return {
      created: 0,
      merged: 0,
      suppressed: 0,
      rejected: 0,
      warning:
        "Dropped papercut candidates because the candidate field was not an array.",
    };
  }

  let store: PapercutStore;
  try {
    store = await createStore(root);
  } catch (error) {
    return failedResult(error);
  }

  const result: PapercutPersistenceResult = {
    created: 0,
    merged: 0,
    suppressed: 0,
    rejected: 0,
  };
  for (const candidate of value.papercuts) {
    try {
      const outcome = await store.propose(candidate, source);
      if (outcome.kind === "created") {
        result.created++;
      } else if (outcome.kind === "merged") {
        result.merged++;
      } else if (outcome.kind === "ignored" || outcome.kind === "resolved") {
        result.suppressed++;
      } else {
        result.rejected++;
      }
    } catch (error) {
      return {
        ...result,
        warning: `Papercut persistence failed: ${errorMessage(error)}`,
      };
    }
  }
  if (result.rejected > 0) {
    result.warning = `Dropped ${result.rejected} malformed papercut candidate${result.rejected === 1 ? "" : "s"}.`;
  }
  return result;
}

async function createDefaultStore(root: string): Promise<PapercutStore> {
  const { createPapercutStore } = await import("pi-papercuts");
  return createPapercutStore(root);
}

function failedResult(error: unknown): PapercutPersistenceResult {
  return {
    created: 0,
    merged: 0,
    suppressed: 0,
    rejected: 0,
    warning: `Papercut persistence failed: ${errorMessage(error)}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
