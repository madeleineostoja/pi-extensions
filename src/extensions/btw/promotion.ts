import {
  getMarkdownTheme,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { compactDisplayText } from "#lib/ui/tool-result-renderer";

export const BTW_MESSAGE_TYPE = "btw";

export type BtwPromotion = {
  question: string;
  answer: string;
};

type BtwMessageDetails = {
  question: string;
};

const PROMOTION_HEADER =
  "Completed /btw side exchange promoted as context.\n\n";
const QUESTION_LENGTH_PREFIX = "Question length: ";
const QUESTION_HEADER = "Question:\n";
const ANSWER_HEADER = "\n\nAnswer:\n";

export function promotedBtwMessage(exchange: BtwPromotion): {
  customType: typeof BTW_MESSAGE_TYPE;
  content: string;
  display: true;
  details: BtwMessageDetails;
} {
  return {
    customType: BTW_MESSAGE_TYPE,
    content:
      PROMOTION_HEADER +
      `${QUESTION_LENGTH_PREFIX}${exchange.question.length}\n` +
      `${QUESTION_HEADER}${exchange.question}${ANSWER_HEADER}${exchange.answer}`,
    display: true,
    details: { question: compactDisplayText(exchange.question) },
  };
}

export const renderBtwMessage: MessageRenderer<BtwMessageDetails> = (
  message,
  options,
  theme,
) => {
  const details = message.details;
  if (!details || typeof details.question !== "string") {
    return undefined;
  }
  const view = new Container();
  view.addChild(
    new Text(theme.bold(theme.fg("customMessageLabel", "btw")), 0, 0),
  );
  view.addChild(
    new Text(theme.fg("customMessageText", details.question), 0, 0),
  );
  if (!options.expanded) {
    return view;
  }

  const exchange = exchangeFromContent(message.content);
  if (!exchange) {
    return undefined;
  }
  view.addChild(new Text(theme.bold("Question"), 0, 0));
  view.addChild(
    new Text(theme.fg("customMessageText", exchange.question), 0, 0),
  );
  view.addChild(new Text(theme.bold("Answer"), 0, 0));
  view.addChild(new Markdown(exchange.answer, 0, 0, getMarkdownTheme()));
  return view;
};

function exchangeFromContent(content: unknown): BtwPromotion | undefined {
  if (typeof content !== "string") {
    return undefined;
  }
  if (!content.startsWith(PROMOTION_HEADER)) {
    return undefined;
  }
  const lengthStart = PROMOTION_HEADER.length;
  const lengthEnd = content.indexOf("\n", lengthStart);
  if (lengthEnd < 0) {
    return undefined;
  }
  const questionLength = Number(
    content.slice(lengthStart, lengthEnd).replace(QUESTION_LENGTH_PREFIX, ""),
  );
  const questionStart = lengthEnd + 1;
  if (
    !Number.isSafeInteger(questionLength) ||
    questionLength < 0 ||
    !content.slice(questionStart).startsWith(QUESTION_HEADER)
  ) {
    return undefined;
  }
  const questionContentStart = questionStart + QUESTION_HEADER.length;
  const answerStart = questionContentStart + questionLength;
  if (!content.startsWith(ANSWER_HEADER, answerStart)) {
    return undefined;
  }
  return {
    question: content.slice(questionContentStart, answerStart),
    answer: content.slice(answerStart + ANSWER_HEADER.length),
  };
}
