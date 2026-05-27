import { resolve, normalize } from "node:path";

export function toAbsolutePath(inputPath: string, cwd: string): string {
  return normalize(resolve(cwd, inputPath));
}

const UNSAFE_METACHARACTERS = /[;&|`$]|\$\(|\$\{|<\(|\*|\?|\{|\}/;

/**
 * Light-weight shell word extractor.
 * Supports single/double quotes and basic backslash escaping inside quotes.
 * Returns `undefined` when the command contains shell metacharacters that make
 * path extraction unreliable (e.g. `;`, `&&`, `||`, `|`, backticks, `$(`,
 * variables, globs, etc.).
 */
export function extractShellWords(command: string): string[] | undefined {
  if (UNSAFE_METACHARACTERS.test(command)) return undefined;

  const words: string[] = [];
  let i = 0;

  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i >= command.length) break;
    if (command[i] === "#") break;

    let word = "";
    let quote: "'" | '"' | null = null;

    while (i < command.length) {
      const ch = command[i];
      if (quote) {
        if (ch === "\\" && quote === '"') {
          i++;
          word += command[i] ?? "";
        } else if (ch === quote) {
          quote = null;
        } else {
          word += ch;
        }
      } else {
        if (/\s/.test(ch)) break;
        if (ch === "'" || ch === '"') {
          quote = ch;
        } else if (ch === "\\") {
          i++;
          word += command[i] ?? "";
        } else {
          word += ch;
        }
      }
      i++;
    }
    words.push(word);
  }

  return words;
}
