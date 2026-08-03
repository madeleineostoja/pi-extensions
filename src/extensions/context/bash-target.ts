import { truncateLine } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";

const MAX_DISPLAY_CHARS = 120;

export function formatBashTarget(command: string): string {
  const normalized = Array.from(
    stripVTControlCharacters(command),
    (character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? " "
        : character;
    },
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized
    ? truncateLine(normalized, MAX_DISPLAY_CHARS).text
    : "Bash command";
}
