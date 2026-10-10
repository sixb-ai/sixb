import type { AgentMessagePart, AgentToolDefinition } from "@sixb/core"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import { fileContentKey } from "./file-ref"
import type { AgentOutputAttachment } from "./output-attachments"

/**
 * Attach the answer's deliverables: files returned by project tools and files published to
 * `$SIXB_OUTPUT_DIR`, each once. A file a built-in tool only read, such as a page `view_file`
 * prepared for the model, stays in the tool result: it is part of the work, not of the answer.
 */
export function assistantPartsWithAttachments(
  parts: readonly AgentMessagePart[],
  input: {
    readonly projectTools: readonly Pick<AgentToolDefinition, "name">[]
    readonly outputAttachments?: readonly AgentOutputAttachment[]
  }
): AgentMessagePart[] {
  const projectToolNames = new Set(input.projectTools.map((tool) => tool.name))
  const result = [...parts]
  const seen = new Set(
    parts.flatMap((part) => (part.type === "file" ? [fileContentKey(part.fileRef)] : []))
  )
  const candidates = [
    ...parts.flatMap((part) => {
      if (
        part.type !== "tool-call" ||
        part.state !== "output-available" ||
        !projectToolNames.has(part.toolName) ||
        !isAgentToolResult(part.output)
      ) {
        return []
      }
      return part.output.content.flatMap((contentPart) =>
        contentPart.type === "file" ? [contentPart.fileRef] : []
      )
    }),
    ...(input.outputAttachments ?? []).map((attachment) => attachment.fileRef),
  ]

  for (const fileRef of candidates) {
    const identity = fileContentKey(fileRef)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push({ type: "file", fileRef })
  }
  return result
}
