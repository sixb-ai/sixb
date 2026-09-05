import type { BlobStorage, FileRef, JsonValue } from "@sixb/core"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import { prepareAgentToolFileProjection } from "../attachments"

export type AgentToolModelOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: JsonValue }

/** Convert a durable Sixb tool result into bounded, provider-safe model-facing output. */
export async function agentToolResultToModelOutput(input: {
  readonly output: JsonValue
  readonly blobStorage: BlobStorage
  readonly signal?: AbortSignal
  readonly sandboxPathForFileRef?: (fileRef: FileRef) => string | undefined
  readonly imageOmissionNote?: string
}): Promise<AgentToolModelOutput> {
  if (!isAgentToolResult(input.output)) {
    return typeof input.output === "string"
      ? { type: "text", value: input.output }
      : { type: "json", value: input.output }
  }

  const text: string[] = []
  for (const contentPart of input.output.content) {
    if (contentPart.type === "text") {
      text.push(contentPart.text)
      continue
    }

    const sandboxPath = input.sandboxPathForFileRef?.(contentPart.fileRef)
    const projection = await prepareAgentToolFileProjection({
      fileRef: contentPart.fileRef,
      blobStorage: input.blobStorage,
      inlineImages: false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(sandboxPath === undefined ? {} : { sandboxPath }),
      ...(input.imageOmissionNote === undefined
        ? {}
        : { imageOmissionNote: input.imageOmissionNote }),
    })
    text.push(projection.promptText)
  }
  return { type: "text", value: text.join("\n") }
}
