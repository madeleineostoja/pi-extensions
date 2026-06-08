export type BtwExchange = {
  question: string;
  answer: string;
};

const btwHistory = new Map<string, BtwExchange[]>();

export function getSessionKey(sessionManager: {
  getSessionFile(): string | undefined;
  getSessionId(): string;
}): string {
  return sessionManager.getSessionFile() ?? sessionManager.getSessionId();
}

export function getHistory(sessionKey: string): readonly BtwExchange[] {
  return btwHistory.get(sessionKey) ?? [];
}

export function addExchange(sessionKey: string, exchange: BtwExchange): void {
  const history = btwHistory.get(sessionKey) ?? [];
  history.push(exchange);
  btwHistory.set(sessionKey, history);
}

export function clearHistory(sessionKey: string): void {
  btwHistory.delete(sessionKey);
}
