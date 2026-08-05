import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context, Message, UserMessage } from "@earendil-works/pi-ai";

const SYSTEM_PROMPT =
  "You are answering a side question about the current coding session. " +
  "You have no tools available and cannot read files, run commands, or mutate state. " +
  "Answer from the provided conversation context and your general knowledge.";
const ANSWER_RESERVE = 1_024;
const OVERHEAD_RESERVE = 256;

type ContextBuilder = {
  buildSessionContext: () => { messages: Parameters<typeof convertToLlm>[0] };
};

type ContextModel = {
  contextWindow: number;
  maxTokens: number;
};

export type BtwPrompt = {
  context: Context;
  maxTokens: number;
  overheadTokens: number;
};

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3);
}

function questionMessage(question: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: question }],
    timestamp: Date.now(),
  };
}

function toolCallIds(message: Message): readonly string[] | null | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  const calls = message.content.filter((part) => part.type === "toolCall");
  if (!calls.length) {
    return undefined;
  }
  const ids = calls.flatMap((part) =>
    typeof part.id === "string" && part.id ? [part.id] : [],
  );
  return ids.length === calls.length && new Set(ids).size === ids.length
    ? ids
    : null;
}

function sessionGroups(messages: readonly Message[]): readonly Message[][] {
  const groups: Message[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      continue;
    }
    const callIds = toolCallIds(message);
    if (callIds === undefined) {
      groups.push([message]);
      continue;
    }
    if (callIds === null) {
      continue;
    }

    const results: Message[] = [];
    while (messages[index + results.length + 1]?.role === "toolResult") {
      results.push(messages[index + results.length + 1]!);
    }
    index += results.length;
    const resultIds = results.map((result) =>
      result.role === "toolResult" ? result.toolCallId : undefined,
    );
    if (
      results.length === callIds.length &&
      new Set(resultIds).size === callIds.length &&
      resultIds.every(
        (id) => typeof id === "string" && id && callIds.includes(id),
      )
    ) {
      groups.push([message, ...results]);
    }
  }
  return groups;
}

function contextFor(
  sessionMessages: readonly Message[],
  currentQuestion: UserMessage,
): Context {
  return {
    systemPrompt: SYSTEM_PROMPT,
    messages: [...sessionMessages, currentQuestion],
    tools: [],
  };
}

function fitNewest<T>(
  values: readonly T[],
  fits: (retained: readonly T[]) => boolean,
): readonly T[] {
  const retained: T[] = [];
  for (const value of [...values].reverse()) {
    const candidate = [value, ...retained];
    if (!fits(candidate)) {
      break;
    }
    retained.unshift(value);
  }
  return retained;
}

function boundedQuestion(question: string, inputLimit: number): UserMessage {
  const fits = (value: string) =>
    estimateTokens(contextFor([], questionMessage(value))) <= inputLimit;
  if (fits(question)) {
    return questionMessage(question);
  }

  const characters = Array.from(question);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (fits(`${characters.slice(0, midpoint).join("")}…`)) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return questionMessage(`${characters.slice(0, low).join("")}…`);
}

export function buildPrompt(
  sessionManager: ExtensionContext["sessionManager"],
  question: string,
  model: ContextModel,
): BtwPrompt {
  const built = (
    sessionManager as unknown as ContextBuilder
  ).buildSessionContext();
  let sessionMessages: Message[] = [];
  try {
    const converted = convertToLlm(built.messages);
    if (Array.isArray(converted)) {
      sessionMessages = converted;
    }
  } catch {}

  const maxTokens = Math.min(
    Math.max(1, model.maxTokens),
    ANSWER_RESERVE,
    Math.max(1, Math.floor(model.contextWindow / 4)),
  );
  const overheadTokens = Math.min(
    OVERHEAD_RESERVE,
    Math.max(1, Math.floor(model.contextWindow / 8)),
  );
  const inputLimit = Math.max(
    1,
    model.contextWindow - maxTokens - overheadTokens,
  );
  const currentQuestion = boundedQuestion(question, inputLimit);
  const groups = sessionGroups(sessionMessages);
  const retainedSessionGroups = fitNewest(
    groups,
    (candidate) =>
      estimateTokens(contextFor(candidate.flat(), currentQuestion)) <=
      inputLimit,
  );

  return {
    context: contextFor(retainedSessionGroups.flat(), currentQuestion),
    maxTokens,
    overheadTokens,
  };
}

export { estimateTokens as estimateBtwTokens };
