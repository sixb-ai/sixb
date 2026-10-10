import type { AgentDocumentSource } from "./document-preview/types"
import type { AgentFileRef, AgentMessagePart } from "./types"

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
  /** Files in a saved rich result, such as the image `view_file` prepared for the model. */
  readonly files?: readonly NormalizedFile[]
}

/** A file shown in a message. The document source exists once the message is saved. */
export type NormalizedFile = {
  readonly fileRef: AgentFileRef
  readonly document?: AgentDocumentSource
}

export type NormalizedPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string; readonly streaming: boolean }
  | { readonly kind: "tool"; readonly tool: NormalizedTool }
  | ({ readonly kind: "file" } & NormalizedFile)
  | { readonly kind: "step-start" }

export function normalizeDurableParts(
  parts: readonly AgentMessagePart[],
  options: {
    /** Resolve a file of the message from its JSON pointer, such as `/parts/2/fileRef`. */
    readonly fileSource?: (fileRef: AgentFileRef, path: string) => AgentDocumentSource | undefined
  } = {}
): NormalizedPart[] {
  const file = (fileRef: AgentFileRef, path: string): NormalizedFile => {
    const document = options.fileSource?.(fileRef, path)
    return document === undefined ? { fileRef } : { fileRef, document }
  }
  const toolFiles = (output: unknown, partIndex: number): { files?: NormalizedFile[] } => {
    const files = toolResultFiles(output).map(({ fileRef, contentIndex }) =>
      file(fileRef, `/parts/${partIndex}/output/content/${contentIndex}/fileRef`)
    )
    return files.length === 0 ? {} : { files }
  }

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
                    ...toolFiles(part.output, index),
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
        return [{ kind: "file", ...file(part.fileRef, `/parts/${index}/fileRef`) }]
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

/** The files of a rich tool result (`{ kind: "agentToolResult", content }`), by content index. */
export function toolResultFiles(
  output: unknown
): { readonly fileRef: AgentFileRef; readonly contentIndex: number }[] {
  if (!isRecord(output) || output.kind !== "agentToolResult" || !Array.isArray(output.content)) {
    return []
  }
  return output.content.flatMap((part: unknown, contentIndex) =>
    isRecord(part) && part.type === "file" && isFileRef(part.fileRef)
      ? [{ fileRef: part.fileRef, contentIndex }]
      : []
  )
}

function isFileRef(value: unknown): value is AgentFileRef {
  return (
    isRecord(value) &&
    typeof value.blobId === "string" &&
    typeof value.digest === "string" &&
    typeof value.sizeBytes === "number"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
