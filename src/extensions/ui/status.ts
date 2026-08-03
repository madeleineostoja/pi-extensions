import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const STATUS_KEY_PREFIX = "pipkin:status:";
const MAX_TEXT_LENGTH = 160;
const MAX_PRIORITY = 9999;
const PRIVATE_USE_GLYPH_PATTERN =
  /[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
const CONTROL_PATTERN = /\p{C}/u;

export type PipkinStatusState = "normal" | "warning" | "error";

export type PipkinStatus = {
  id: string;
  priority: number;
  icon: string;
  state: PipkinStatusState;
  text: string;
};

export type PipkinStatusUI = Pick<ExtensionUIContext, "setStatus" | "theme">;

export function pipkinStatusKey(id: string, priority: number): string {
  validateId(id);
  validatePriority(priority);
  return `${STATUS_KEY_PREFIX}${priority.toString().padStart(4, "0")}:${id}`;
}

export function parsePipkinStatusKey(
  key: string,
): { priority: number; id: string } | undefined {
  const match = /^pipkin:status:(\d{4}):([a-z][a-z0-9-]{0,31})$/.exec(key);
  if (!match) {
    return undefined;
  }
  return { priority: Number(match[1]), id: match[2] };
}

function validateId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    throw new TypeError("Pipkin status ID is invalid");
  }
}

function validatePriority(priority: number): void {
  if (
    !Number.isSafeInteger(priority) ||
    priority < 0 ||
    priority > MAX_PRIORITY
  ) {
    throw new TypeError("Pipkin status priority is invalid");
  }
}

function validateText(text: string): void {
  if (
    !text.trim() ||
    text.length > MAX_TEXT_LENGTH ||
    CONTROL_PATTERN.test(text)
  ) {
    throw new TypeError("Pipkin status text is invalid");
  }
}

function validateIcon(icon: string): void {
  if (
    Array.from(icon).length !== 1 ||
    visibleWidth(icon) !== 1 ||
    !PRIVATE_USE_GLYPH_PATTERN.test(icon)
  ) {
    throw new TypeError("Pipkin status icon must be one private-use cell");
  }
}

export function validatePipkinStatus(status: PipkinStatus): void {
  validateId(status.id);
  validatePriority(status.priority);
  validateIcon(status.icon);
  validateText(status.text);
}

export function setPipkinStatus(
  ui: PipkinStatusUI,
  status: PipkinStatus,
): void {
  validatePipkinStatus(status);
  const tone =
    status.state === "normal"
      ? "success"
      : status.state === "warning"
        ? "warning"
        : "error";
  const textTone = status.state === "normal" ? "muted" : tone;
  ui.setStatus(
    pipkinStatusKey(status.id, status.priority),
    `${ui.theme.fg(tone, status.icon)} ${ui.theme.fg(textTone, status.text)}`,
  );
}

export function clearPipkinStatus(
  ui: PipkinStatusUI,
  id: string,
  priority: number,
): void {
  ui.setStatus(pipkinStatusKey(id, priority), undefined);
}
