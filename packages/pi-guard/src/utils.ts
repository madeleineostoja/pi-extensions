export function formatBlockReason(message: string): string {
  if (message.trim() === "") {
    return "Command blocked by user. Do not retry the same command without addressing the user's concern or asking for clarification.";
  }
  return `Command blocked by user. User feedback:\n\n${message.trim()}\n\nAddress this before retrying.`;
}
