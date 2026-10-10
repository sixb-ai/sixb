import type { LiveRunPart, LiveRunTool } from "@sixb/client"
import type { AgentDocumentSource } from "./document-preview/types"
import type { AgentMessagePart } from "./types"

// The render-ready vocabulary shared by the durable transcript and the live streaming row.
// `@sixb/client`'s live run reducer produces the streaming parts; saved messages add files and step
// boundaries. `AssistantBody` renders both, so the two layers agree on one part model.
export type NormalizedTool = LiveRunTool

export type NormalizedPart =
  | LiveRunPart
  | {
      readonly kind: "file"
      readonly fileRef: Extract<AgentMessagePart, { type: "file" }>["fileRef"]
      readonly document?: AgentDocumentSource
    }
  | { readonly kind: "step-start" }

export function normalizeDurableParts(
  parts: readonly AgentMessagePart[],
  options: { readonly fileSource?: (partIndex: number) => AgentDocumentSource | undefined } = {}
): NormalizedPart[] {
  // Context is rendered separately with the user message. It is invalid on assistant messages,
  // but filtering keeps old or malformed durable data from turning into a fake step boundary.
  return parts.flatMap((part, index): NormalizedPart[] => {
    switch (part.type) {
      case "text":
        return [{ kind: "text", text: part.text }]
      case "reasoning":
        return [{ kind: "reasoning", text: part.text, streaming: false }]
      case "tool-call":
        return [
          {
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
          },
        ]
      case "file":
        return [
          {
            kind: "file",
            fileRef: part.fileRef,
            ...(options.fileSource === undefined ? {} : { document: options.fileSource(index) }),
          },
        ]
      case "step-start":
        return [{ kind: "step-start" }]
      case "context":
      case "provider-state":
        return []
      default:
        // Compile error if the core message part union grows: handle the new kind above.
        part satisfies never
        return []
    }
  })
}
