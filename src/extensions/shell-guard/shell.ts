export type Segment = { text: string; separator: string | null; index: number };

export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const next = command[i + 1];
    const separator =
      char === "\n" || char === ";"
        ? char
        : char === "&" && next === "&"
          ? "&&"
          : char === "|" && next === "|"
            ? "||"
            : char === "|"
              ? "|"
              : char === "&" && next !== ">" && command[i - 1] !== ">"
                ? "&"
                : undefined;
    if (!separator) {
      continue;
    }
    const text = command.slice(start, i).trim();
    if (text) {
      segments.push({ text, separator, index: segments.length });
    }
    i += separator.length - 1;
    start = i + 1;
  }
  const text = command.slice(start).trim();
  if (text) {
    segments.push({ text, separator: null, index: segments.length });
  }
  return segments;
}

export function tokenize(command: string): string[] | undefined {
  if (/[`$*?{}]|<\(/.test(command)) {
    return undefined;
  }
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let active = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\") {
      if (i + 1 >= command.length) {
        return undefined;
      }
      word += command[++i];
      active = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        word += char;
      }
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) {
        words.push(word);
      }
      word = "";
      active = false;
    } else if (char === ">" || char === "<") {
      if (active) {
        words.push(word);
      }
      const operator = char + (command[i + 1] === ">" ? command[++i] : "");
      words.push(operator);
      word = "";
      active = false;
    } else {
      word += char;
      active = true;
    }
  }
  if (quote) {
    return undefined;
  }
  if (active) {
    words.push(word);
  }
  return words;
}

export function executable(
  words: string[],
): { name: string; args: string[] } | undefined {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) {
    index++;
  }
  for (;;) {
    const command = words[index];
    if (!command) {
      return undefined;
    }
    if (command === "sudo" || command === "doas") {
      index++;
      while ((words[index] ?? "").startsWith("-")) {
        index++;
      }
      continue;
    }
    if (command === "env") {
      index++;
      while (
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "") ||
        (words[index] ?? "").startsWith("-")
      ) {
        index++;
      }
      continue;
    }
    if (command === "command") {
      index++;
      continue;
    }
    return {
      name: command.split("/").at(-1) ?? command,
      args: words.slice(index + 1),
    };
  }
}
