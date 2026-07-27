import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLsp } from "./tool.js";

export default function (pi: ExtensionAPI): void {
  registerLsp(pi);
}

export * from "./client.js";
export * from "./normalize.js";
export * from "./pool.js";
export * from "./protocol.js";
export * from "./server.js";
export * from "./tool.js";
export * from "./workspace.js";
