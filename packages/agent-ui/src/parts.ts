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
  | {
      readonly kind: "file"
      readonly fileRef: Extract<AgentMessagePart, { type: "file" }>["fileRef"]
      readonly href?: string
    }
  | { readonly kind: "step-start" }

export function normalizeDurableParts(
  parts: readonly AgentMessagePart[],
  options: { readonly fileHref?: (partIndex: number) => string | undefined } = {}
): NormalizedPart[] {
  return parts.map((part, index): NormalizedPart => {
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
      case "file":
        return {
          kind: "file",
          fileRef: part.fileRef,
          ...(options.fileHref === undefined ? {} : { href: options.fileHref(index) }),
        }
      case "step-start":
        return { kind: "step-start" }
      default:
        // Compile error if the core message part union grows: handle the new kind above rather than
        // letting a durable message render as an invisible step boundary. Still degrades gracefully
        // at runtime for an unexpected payload.
        part satisfies never
        return { kind: "step-start" }
    }
  })
}
