import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "./artifacts.js";
import { composeSignal } from "./cancellation.js";
import { WebError } from "./errors.js";
import type { BatchWebFetchInput, WebFetchInput } from "./schema.js";
import { executeBatchWebFetch } from "./batch-web-fetch.js";
import { executeWebFetch, type WebFetchResult } from "./web-fetch.js";

export class WebFetchOwner {
  readonly artifacts: ArtifactStore;
  #active = new Map<AbortController, Promise<unknown>>();
  #shutdown: Promise<void> | undefined;

  constructor(artifacts = new ArtifactStore()) {
    this.artifacts = artifacts;
  }

  async execute(
    input: WebFetchInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<WebFetchResult> {
    if (this.#shutdown) {
      await this.#shutdown;
      throw new WebError("artifact", "Web Fetch is no longer active.");
    }
    const controller = new AbortController();
    const composed = composeSignal([signal, controller.signal]);
    const pending = executeWebFetch(input, composed.signal, onUpdate, {
      artifacts: this.artifacts,
    });
    this.#active.set(controller, pending);
    try {
      return await pending;
    } finally {
      this.#active.delete(controller);
      composed.dispose();
    }
  }

  async executeBatch(
    input: BatchWebFetchInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<WebFetchResult> {
    if (this.#shutdown) {
      await this.#shutdown;
      throw new WebError("artifact", "Web Fetch is no longer active.");
    }
    const controller = new AbortController();
    const composed = composeSignal([signal, controller.signal]);
    const pending = executeBatchWebFetch(input, composed.signal, onUpdate, {
      artifacts: this.artifacts,
    });
    this.#active.set(controller, pending);
    try {
      return await pending;
    } finally {
      this.#active.delete(controller);
      composed.dispose();
    }
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      const active = [...this.#active.entries()];
      for (const [controller] of active) {
        controller.abort(
          new DOMException("Web Fetch session is shutting down.", "AbortError"),
        );
      }
      await Promise.allSettled(active.map(([, pending]) => pending));
      await this.artifacts.dispose();
    })();
    return this.#shutdown;
  }
}
