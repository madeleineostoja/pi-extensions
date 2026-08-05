import { formatDeny } from "./utils.js";

export type ResolveChoiceResult = {
  block: boolean;
  reason?: string;
  disable?: boolean;
};

export function resolveChoice(params: {
  choice: string | undefined;
  message: string | undefined;
}): ResolveChoiceResult {
  if (params.choice === "Allow") {
    return { block: false };
  }
  if (params.choice === "Allow for session") {
    return { block: false, disable: true };
  }
  return { block: true, reason: formatDeny(params.message ?? "") };
}
