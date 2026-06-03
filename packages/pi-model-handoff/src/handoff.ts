import type { Model } from "@earendil-works/pi-ai";

export type PendingHandoff = {
  previousModel: Model<any>;
};

let pending: PendingHandoff | undefined;

export function setPendingHandoff(state: PendingHandoff): void {
  pending = state;
}

export function clearPendingHandoff(): void {
  pending = undefined;
}

export function getPendingHandoff(): PendingHandoff | undefined {
  return pending;
}
