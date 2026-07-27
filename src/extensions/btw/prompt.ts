import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { Context, Message, UserMessage } from "@earendil-works/pi-ai";
import type { BtwExchange } from "./state.js";

const SYSTEM_PROMPT =
  "You are answering a side question about the current coding session. " +
  "You have no tools available and cannot read files, run commands, or mutate state. " +
  "Answer from the provided conversation context and your general knowledge.";

export function buildPrompt(
  sessionManager: ExtensionContext["sessionManager"],
  priorExchanges: readonly BtwExchange[],
  question: string,
): Context {
  const branchEntries = sessionManager.getBranch();
  const sessionMessages = branchEntries
    .filter((entry): entry is SessionMessageEntry => entry.type === "message")
    .map((entry) => entry.message);

  let convertedMessages: Message[];
  try {
    convertedMessages = convertToLlm(sessionMessages);
  } catch {
    convertedMessages = [];
  }
  if (!Array.isArray(convertedMessages)) {
    convertedMessages = [];
  }

  const sideThreadMessages: Message[] = [];
  for (const exchange of priorExchanges) {
    sideThreadMessages.push({
      role: "user",
      content: [
        { type: "text", text: `Previous side question: ${exchange.question}` },
      ],
      timestamp: Date.now(),
    } as UserMessage);
    sideThreadMessages.push({
      role: "assistant",
      content: [{ type: "text", text: exchange.answer }],
      api: "openai-responses",
      provider: "openai",
      model: "side-thread",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as Message);
  }

  const currentQuestion: UserMessage = {
    role: "user",
    content: [{ type: "text", text: question }],
    timestamp: Date.now(),
  };

  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [...convertedMessages, ...sideThreadMessages, currentQuestion],
    tools: [],
  };
}
