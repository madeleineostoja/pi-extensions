import type { AuditEntry } from "./schema.js";
import { createLogWriter, type LogWriterOptions } from "./log.js";
import { createAuditEmitter, type EventsTarget } from "./events.js";

export type { AuditEntry } from "./schema.js";
export type { SandboxAuditEvent, SandboxPolicyChangedEvent } from "./schema.js";

export interface RecordAuditOptions {
  logFile?: string;
  logEnabled?: boolean;
  maxBytes?: number;
  maxFiles?: number;
  events?: EventsTarget;
}

export interface AuditPipeline {
  recordAudit: (entry: Omit<AuditEntry, "ts"> & { ts?: number }, opts?: RecordAuditOptions) => void;
  getRecentBlockedHosts: () => readonly string[];
}

export function createAuditPipeline(): AuditPipeline {
  const logWriter = createLogWriter();
  const emitter = createAuditEmitter();

  function getRecentBlockedHosts(): readonly string[] {
    return emitter.getRecentBlockedHosts();
  }

  function recordAudit(
    entry: Omit<AuditEntry, "ts"> & { ts?: number },
    opts: RecordAuditOptions = {}
  ): void {
    const fullEntry: AuditEntry = {
      ts: Date.now(),
      ...entry,
    };

    const logEnabled = opts.logEnabled !== false;

    if (logEnabled && opts.logFile != null) {
      const logOpts: LogWriterOptions = {
        logFile: opts.logFile,
        maxBytes: opts.maxBytes,
        maxFiles: opts.maxFiles,
      };
      logWriter.appendLogEntry(fullEntry, logOpts);
    }

    if (opts.events != null) {
      emitter.emitAuditEvents(fullEntry, opts.events);
    }
  }

  return { recordAudit, getRecentBlockedHosts };
}
