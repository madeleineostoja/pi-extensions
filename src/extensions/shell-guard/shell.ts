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
  const flush = () => {
    if (active) {
      words.push(word);
    }
    word = "";
    active = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
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
      flush();
    } else if (char === ">" || char === "<") {
      const fd = active && /^\d+$/.test(word) ? word : "";
      if (!fd) {
        flush();
      }
      const operator = `${fd}${char}${command[i + 1] === ">" ? command[++i] : ""}`;
      if (command[i + 1] === "&") {
        let duplication = "&";
        i++;
        while (/\d/.test(command[i + 1] ?? "")) {
          duplication += command[++i];
        }
        words.push(operator + duplication);
      } else {
        words.push(operator);
      }
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
  flush();
  return words;
}

function consumeWrapperOption(
  words: string[],
  index: number,
  withValue: Set<string>,
): number {
  const option = words[index] ?? "";
  if (withValue.has(option) && words[index + 1]) {
    return index + 2;
  }
  return index + 1;
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
        index = consumeWrapperOption(
          words,
          index,
          new Set(["-u", "-g", "-h", "-C", "-r", "-t"]),
        );
      }
      continue;
    }
    if (command === "env") {
      index++;
      while (true) {
        const option = words[index] ?? "";
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          index++;
        } else if (option.startsWith("-")) {
          index = consumeWrapperOption(
            words,
            index,
            new Set(["-u", "-C", "-S"]),
          );
        } else {
          break;
        }
      }
      continue;
    }
    if (command === "command") {
      index++;
      while ((words[index] ?? "").startsWith("-")) {
        index++;
      }
      continue;
    }
    return {
      name: command.split("/").at(-1) ?? command,
      args: words.slice(index + 1),
    };
  }
}

export function redirectTargets(words: string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < words.length; index++) {
    if (!/^\d*>{1,2}$/.test(words[index] ?? "")) {
      continue;
    }
    const target = words[index + 1];
    if (target && !target.startsWith("&")) {
      targets.push(target);
    }
  }
  return targets;
}
