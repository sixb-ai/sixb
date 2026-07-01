import type { AgentMessagePart } from "./types"

// The render-ready vocabulary shared by the durable transcript and the live streaming row.
// `liveRun` reduces stream chunks into these shapes and `AssistantBody` renders them, so both
// layers agree on one part model without either depending on the other.
export type NormalizedTool = {
  readonly toolName: string
  readonly state: "input-streaming" | "input-available" | "output-available" | "output-error"
  readonly input?: unknown
  readonly inputText?: string
  readonly output?: unknown
  readonly errorText?: string
}

export type NormalizedPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string; readonly streaming: boolean }
  | { readonly kind: "tool"; readonly tool: NormalizedTool }
  | { readonly kind: "step-start" }

export function normalizeDurableParts(parts: readonly AgentMessagePart[]): NormalizedPart[] {
  return parts.map((part): NormalizedPart => {
    switch (part.type) {
      case "text":
        return { kind: "text", text: part.text }
      case "reasoning":
        return { kind: "reasoning", text: part.text, streaming: false }
      case "tool-call":
        return {
          kind: "tool",
          tool:
            part.state === "output-available"
              ? {
                  toolName: part.toolName,
                  state: part.state,
                  input: part.input,
                  output: part.output,
                }
              : {
                  toolName: part.toolName,
                  state: part.state,
                  input: part.input,
                  errorText: part.errorText,
                },
        }
      default:
        return { kind: "step-start" }
    }
  })
}
