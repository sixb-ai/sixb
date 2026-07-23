export interface AgentContextMention {
  readonly start: number
  readonly end: number
  readonly query: string
}

/** Return the `@query` token immediately before the caret, if any. */
export function findAgentContextMention(value: string, caret: number): AgentContextMention | null {
  const beforeCaret = value.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCaret)
  if (!match) return null
  const query = match[1] ?? ""
  return {
    start: caret - query.length - 1,
    end: caret,
    query,
  }
}

export function removeAgentContextMention(
  value: string,
  mention: AgentContextMention
): { readonly value: string; readonly caret: number } {
  return {
    value: `${value.slice(0, mention.start)}${value.slice(mention.end)}`,
    caret: mention.start,
  }
}
