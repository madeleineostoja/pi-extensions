import { formatBlockReason } from "./utils";

export function resolveChoice(
  choice: string | undefined,
  message: string | undefined,
): { block: boolean; reason?: string; disable?: boolean } {
  if (choice === "Allow once") {
    return { block: false };
  }
  if (choice === "Allow all this session") {
    return { block: false, disable: true };
  }
  return { block: true, reason: formatBlockReason(message ?? "") };
}
