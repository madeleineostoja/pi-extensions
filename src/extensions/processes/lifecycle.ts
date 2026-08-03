import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { ProcessRuntime } from "./runtime.js";

export class ProcessSessionLifecycle {
  #runtime: ProcessRuntime | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  async sessionStart(
    _event: SessionStartEvent,
    _ctx: ExtensionContext,
  ): Promise<void> {
    await this.#shutdown;
    this.#shutdown = undefined;
    await this.#runtime?.dispose();
    this.#runtime = new ProcessRuntime(this.pi.events, () =>
      this.pi.getActiveTools().includes("bash"),
    );
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
      this.#runtime = undefined;
      this.#shutdown = runtime?.dispose() ?? Promise.resolve();
    }
    await this.#shutdown;
  }
}
