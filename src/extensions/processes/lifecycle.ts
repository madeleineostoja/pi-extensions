import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { ProcessActivityProjector } from "./activity-projector.js";
import { ProcessRuntime } from "./runtime.js";

export class ProcessSessionLifecycle {
  #runtime: ProcessRuntime | undefined;
  #activity: ProcessActivityProjector | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  async sessionStart(
    _event: SessionStartEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    await this.#shutdown;
    this.#shutdown = undefined;
    this.#activity?.dispose();
    await this.#runtime?.dispose();
    const runtime = new ProcessRuntime(this.pi.events, () =>
      this.pi.getActiveTools().includes("bash"),
    );
    this.#runtime = runtime;
    if (ctx.mode === "tui" && ctx.hasUI) {
      this.#activity = new ProcessActivityProjector(runtime, this.pi.events);
      this.#activity.start();
    }
  }

  runtime(): ProcessRuntime {
    if (!this.#runtime) {
      throw new Error("Processes: session is not active.");
    }
    return this.#runtime;
  }

  async sessionShutdown(): Promise<void> {
    if (!this.#shutdown) {
      const runtime = this.#runtime;
      const activity = this.#activity;
      this.#runtime = undefined;
      this.#activity = undefined;
      activity?.dispose();
      this.#shutdown = runtime?.dispose() ?? Promise.resolve();
    }
    await this.#shutdown;
  }
}
