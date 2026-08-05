import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolCallRenderer } from "#lib/ui/tool-result-renderer";
import {
  BatchWebFetchParameters,
  WebFetchParameters,
  type BatchWebFetchInput,
  type WebFetchInput,
} from "./schema.js";
import { WebFetchOwner } from "./owner.js";
import {
  renderBatchWebFetchResult,
  renderWebFetchResult,
} from "./result-renderer.js";

export default function (pi: ExtensionAPI): void {
  const owner = new WebFetchOwner();
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Retrieve bounded public web content from one URL. Automatically returns pretty-printed JSON, extracted markdown, or plain text; attachments and non-text responses become temporary artifacts. Set raw only to preserve an untouched textual response.",
    parameters: WebFetchParameters,
    renderCall: toolCallRenderer({
      name: "web_fetch",
      detail: (args: WebFetchInput) => args.url,
      pending: "Fetching public target…",
    }),
    async execute(_toolCallId, input: WebFetchInput, signal, onUpdate) {
      return owner.execute(input, signal, onUpdate);
    },
    renderResult: renderWebFetchResult,
  });
  pi.registerTool({
    name: "batch_web_fetch",
    label: "Batch Web Fetch",
    description:
      "Retrieve bounded public web content from one to eight URLs with fixed concurrency. Each response automatically becomes pretty-printed JSON, extracted markdown, plain text, or a temporary artifact; set raw per request only to preserve untouched text.",
    parameters: BatchWebFetchParameters,
    renderCall: toolCallRenderer({
      name: "batch_web_fetch",
      detail: (args: BatchWebFetchInput) =>
        `${args.requests.length} target${args.requests.length === 1 ? "" : "s"}`,
      pending: "Preparing web requests…",
    }),
    async execute(_toolCallId, input: BatchWebFetchInput, signal, onUpdate) {
      return owner.executeBatch(input, signal, onUpdate);
    },
    renderResult: renderBatchWebFetchResult,
  });
  pi.on("session_shutdown", () => owner.shutdown());
}
