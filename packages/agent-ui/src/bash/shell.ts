export type ShellOperator = "&&" | "||" | "|" | ";" | "newline"

export interface ShellSegment {
  readonly command: string
  readonly tokens: readonly string[]
  readonly outputRedirects?: readonly string[]
  readonly operatorBefore?: ShellOperator
}

/**
 * Lex the conservative shell subset needed for activity presentation. It understands top-level
 * sequencing and quoting, but leaves control flow and heredocs opaque instead of guessing.
 */
export function lexShellCommand(command: string): readonly ShellSegment[] | null {
  if (
    /(?:^|\s)<<-?\s*/.test(command) ||
    /(?:^|[;\n]\s*)(?:if|for|while|until|case|select|function)\b/.test(command) ||
    command.includes("[[")
  ) {
    return null
  }

  const segments: ShellSegment[] = []
  let commandText = ""
  let word = ""
  let wordStarted = false
  let tokens: string[] = []
  let outputRedirects: string[] = []
  let pendingRedirect: "input" | "output" | null = null
  let operatorBefore: ShellOperator | undefined
  let quote: "'" | '"' | null = null
  let escaped = false

  const pushWord = () => {
    if (wordStarted) {
      if (pendingRedirect === "output") outputRedirects.push(word)
      else if (pendingRedirect === null) tokens.push(word)
      pendingRedirect = null
    }
    word = ""
    wordStarted = false
  }

  const pushSegment = (operator?: ShellOperator): boolean => {
    pushWord()
    const value = commandText.trim()
    if (!value) return false
    segments.push({
      command: value,
      tokens,
      ...(outputRedirects.length > 0 ? { outputRedirects } : {}),
      operatorBefore,
    })
    commandText = ""
    tokens = []
    outputRedirects = []
    pendingRedirect = null
    operatorBefore = operator
    return true
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    const next = command[index + 1]

    if (escaped) {
      commandText += character
      word += character
      wordStarted = true
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      commandText += character
      escaped = true
      continue
    }
    if (quote) {
      if (quote === '"' && character === "`") return null
      commandText += character
      if (character === quote) quote = null
      else {
        word += character
        wordStarted = true
      }
      continue
    }
    if (character === "'" || character === '"') {
      commandText += character
      quote = character
      wordStarted = true
      continue
    }
    if (character === "`" || "(){}".includes(character)) return null
    if (/\s/.test(character) && character !== "\n") {
      commandText += character
      pushWord()
      continue
    }
    if (character === ">" || character === "<") {
      // A numeric word touching the redirect is a file descriptor (`2>errors.log`), not an arg.
      if (wordStarted && /^\d+$/.test(word)) {
        word = ""
        wordStarted = false
      } else {
        pushWord()
      }
      const isDouble = next === character
      commandText += isDouble ? `${character}${next}` : character
      pendingRedirect = character === ">" ? "output" : "input"
      if (isDouble) index += 1
      continue
    }

    let operator: ShellOperator | undefined
    let width = 1
    if (character === "&" && next === "&") {
      operator = "&&"
      width = 2
    } else if (character === "|" && next === "|") {
      operator = "||"
      width = 2
    } else if (character === "|") {
      operator = "|"
    } else if (character === ";") {
      operator = ";"
    } else if (character === "\n") {
      operator = "newline"
    } else if (character === "&") {
      // Background jobs and unquoted URL query strings need a complete shell parser.
      return null
    }

    if (operator) {
      if (pendingRedirect && !wordStarted) return null
      if (!commandText.trim()) {
        // Allow formatting newlines after another operator (`foo &&\nbar`).
        if (operator === "newline" && segments.length > 0) continue
        return null
      }
      pushSegment(operator)
      index += width - 1
      continue
    }

    commandText += character
    word += character
    wordStarted = true
  }

  if (quote || escaped || (pendingRedirect && !wordStarted)) {
    return null
  }
  const pushedFinalSegment = pushSegment()
  if (
    !pushedFinalSegment &&
    operatorBefore !== undefined &&
    operatorBefore !== ";" &&
    operatorBefore !== "newline"
  ) {
    return null
  }
  return segments.length > 0 ? segments : null
}

export function executableName(value: string | undefined): string | undefined {
  return value?.split("/").at(-1)
}

/** Resolve the actual invocation after ordinary leading assignments and `env` configuration. */
export function commandInvocation(tokens: readonly string[]): readonly string[] {
  let index = skipAssignments(tokens, 0)
  if (executableName(tokens[index]) !== "env") return tokens.slice(index)

  index += 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === "-u" || token === "--unset") {
      index += 2
      continue
    }
    if (token?.startsWith("-")) {
      index += 1
      continue
    }
    break
  }
  return tokens.slice(skipAssignments(tokens, index))
}

function skipAssignments(tokens: readonly string[], start: number): number {
  let index = start
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1
  return index
}
