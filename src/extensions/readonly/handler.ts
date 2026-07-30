import { formatSteer } from "./utils.js";

export type ResolveChoiceResult = {
  block: boolean;
  reason?: string;
  disable?: boolean;
};

export function resolveChoice(params: {
  choice: string | undefined;
  message: string | undefined;
}): ResolveChoiceResult {
  if (params.choice === "Accept") {
    return { block: false };
  }
  if (params.choice === "Accept for this session") {
    return { block: false, disable: true };
  }
  return { block: true, reason: formatSteer(params.message ?? "") };
}
