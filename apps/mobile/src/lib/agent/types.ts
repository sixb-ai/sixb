import type {
  GetAgentRunResponse,
  GetAgentThreadResponse,
  ListAgentThreadMessagesResponse,
  ListAgentThreadsResponse,
  LiveRunPart,
  LiveRunTool,
} from "@sixb/client"

// Readable names for the generated client's inline agent payloads, as agent-ui's `types.ts` has.

export type AgentThread = GetAgentThreadResponse

export type AgentThreadSummary = ListAgentThreadsResponse["threads"][number]

export type AgentMessage = ListAgentThreadMessagesResponse["messages"][number]

export type AgentMessagePart = AgentMessage["parts"][number]

export type AgentFileRef = Extract<AgentMessagePart, { type: "file" }>["fileRef"]

export type AgentRun = GetAgentRunResponse

export type AgentRunStatus = AgentRun["status"]

export type NormalizedTool = LiveRunTool

/**
 * One render-ready part of an assistant message, from the saved transcript or the live stream.
 * Files come only from saved messages.
 */
export type NormalizedPart =
  | LiveRunPart
  | {
      readonly kind: "file"
      readonly fileRef: AgentFileRef
      /** Where the file sits in its saved message, which names it in the download URL. */
      readonly partIndex: number
    }

export function normalizeMessageParts(parts: readonly AgentMessagePart[]): NormalizedPart[] {
  return parts.flatMap((part, partIndex): NormalizedPart[] => {
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
                ? { toolName: part.toolName, state: part.state, input: part.input }
                : {
                    toolName: part.toolName,
                    state: part.state,
                    input: part.input,
                    errorText: part.errorText,
                  },
          },
        ]
      case "file":
        return [{ kind: "file", fileRef: part.fileRef, partIndex }]
      case "step-start":
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

/** The files a message carries, such as a user's attachments, with where each sits. */
export function messageFiles(
  message: AgentMessage
): { readonly fileRef: AgentFileRef; readonly partIndex: number }[] {
  return message.parts.flatMap((part, partIndex) =>
    part.type === "file" ? [{ fileRef: part.fileRef, partIndex }] : []
  )
}

/** The plain text of a message, for a user bubble. */
export function messageText(message: AgentMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
}
