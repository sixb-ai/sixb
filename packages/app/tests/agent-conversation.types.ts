import type { AgentConversationPart, AgentConversationToolPart } from "../src"

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false
type Expect<TValue extends true> = TValue

// ── A tool part's state says what it holds ───────────────────────────────
// Reproduce: type AgentConversationToolPart as one flat object with every field optional; each
// state below then extracts nothing and these lines fail.

type Streaming = Extract<AgentConversationToolPart, { state: "input-streaming" }>
type Running = Extract<AgentConversationToolPart, { state: "input-available" }>
type Done = Extract<AgentConversationToolPart, { state: "output-available" }>
type Failed = Extract<AgentConversationToolPart, { state: "output-error" }>

type _streamingText = Expect<Equal<Streaming["inputText"], string | undefined>>
type _noInputWhileStreaming = Expect<Equal<Streaming["input"], undefined>>
type _noOutputUntilDone = Expect<Equal<Running["output"], undefined>>
type _noErrorWhenDone = Expect<Equal<Done["errorText"], undefined>>
type _errorText = Expect<Equal<Failed["errorText"], string>>
// No tool types a part: a refused call carries whatever input it was refused for.
type _failedInput = Expect<Equal<Failed["input"], unknown>>

export function describeTool(part: AgentConversationPart): string {
  if (part.type !== "tool") return ""

  switch (part.state) {
    case "output-available":
      return `${part.toolName}: ${JSON.stringify(part.output)}`
    case "output-error":
      return part.errorText
    case "input-streaming":
      // @ts-expect-error a call still writing its input has no output
      return String(part.output.anything)
    default:
      return part.toolCallId ?? part.toolName
  }
}
