import * as fs from "node:fs";
import * as path from "node:path";

import type { AuditEntry } from "./schema.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 3;

export type LogWriterOptions = {
  logFile: string;
  maxBytes?: number;
  maxFiles?: number;
};

export type LogWriter = {
  appendLogEntry: (entry: AuditEntry, opts: LogWriterOptions) => void;
};

export function createLogWriter(): LogWriter {
  const warnedLogFiles = new Set<string>();

  function ensureLogDir(logFile: string, logDir: string): boolean {
    if (warnedLogFiles.has(logFile)) {
      return false;
    }
    try {
      fs.mkdirSync(logDir, { recursive: true });
      return true;
    } catch {
      if (!warnedLogFiles.has(logFile)) {
        warnedLogFiles.add(logFile);
        process.stderr.write(
          `pi-sandbox: could not create audit log directory ${logDir} — file logging disabled\n`,
        );
      }
      return false;
    }
  }

  function rotateLogs(logFile: string, maxFiles: number): void {
    for (let i = maxFiles; i >= 1; i--) {
      const older = `${logFile}.${i}`;
      const newer = i === 1 ? logFile : `${logFile}.${i - 1}`;
      if (fs.existsSync(newer)) {
        try {
          if (fs.existsSync(older)) {
            fs.unlinkSync(older);
          }
          fs.renameSync(newer, older);
        } catch {
          // Best-effort rotation
        }
      }
    }
  }

  function checkAndRotate(
    logFile: string,
    maxBytes: number,
    maxFiles: number,
  ): void {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size >= maxBytes) {
        rotateLogs(logFile, maxFiles);
      }
    } catch {
      // File may not exist yet — no rotation needed
    }
  }

  function appendLogEntry(entry: AuditEntry, opts: LogWriterOptions): void {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    const logFile = opts.logFile;
    const logDir = path.dirname(logFile);

    if (warnedLogFiles.has(logFile)) {
      return;
    }

    const ok = ensureLogDir(logFile, logDir);
    if (!ok) {
      return;
    }

    checkAndRotate(logFile, maxBytes, maxFiles);

    const line = JSON.stringify(entry) + "\n";
    try {
      fs.writeFileSync(logFile, line, { flag: "a", encoding: "utf8" });
    } catch {
      warnedLogFiles.add(logFile);
      process.stderr.write(
        `pi-sandbox: could not write to audit log ${logFile} — file logging disabled\n`,
      );
    }
  }

  return { appendLogEntry };
}
