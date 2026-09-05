import type { BlobStorage, FileRef, JsonValue } from "@sixb/core"
import type { PrepareModelStepInput, PrepareModelStepResult } from "@sixb/core/internal/agents"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import { modelSupportsInlineImages, prepareAgentToolFileProjection } from "../attachments"
import { fileContentKey } from "../file-ref"
import { type AgentToolModelOutput, agentToolResultToModelOutput } from "./result-output"

const TOOL_RESULT_IMAGE_OMISSION_NOTE =
  "[Image is not embedded in the tool-result message; Sixb supplies it as a separate model input when the selected model supports images.]"

interface PendingToolFile {
  readonly fileRef: FileRef
  readonly signal: AbortSignal
  readonly toolCallId: string
}

/** Move tool-created images into an ephemeral user message without changing their durable result. */
export class AgentToolResultMediaBridge {
  readonly #pending: PendingToolFile[] = []

  constructor(
    private readonly input: {
      readonly blobStorage: BlobStorage
      readonly sandboxPathForFileRef?: (fileRef: FileRef) => string | undefined
      /** Test seam; production uses the bounded attachment projector. */
      readonly projectFile?: typeof prepareAgentToolFileProjection
    }
  ) {}

  async toModelOutput(input: {
    readonly output: JsonValue
    readonly signal: AbortSignal
    readonly toolCallId: string
  }): Promise<AgentToolModelOutput> {
    input.signal.throwIfAborted()
    const output = await agentToolResultToModelOutput({
      output: input.output,
      blobStorage: this.input.blobStorage,
      signal: input.signal,
      ...(this.input.sandboxPathForFileRef === undefined
        ? {}
        : { sandboxPathForFileRef: this.input.sandboxPathForFileRef }),
      imageOmissionNote: TOOL_RESULT_IMAGE_OMISSION_NOTE,
    })

    if (isAgentToolResult(input.output)) {
      for (const contentPart of input.output.content) {
        if (contentPart.type === "file" && isImageFile(contentPart.fileRef)) {
          this.#pending.push({
            fileRef: contentPart.fileRef,
            signal: input.signal,
            toolCallId: input.toolCallId,
          })
        }
      }
    }
    return output
  }

  readonly prepareStep = async ({
    messages,
    model,
    signal: stepSignal,
  }: PrepareModelStepInput): Promise<PrepareModelStepResult | undefined> => {
    if (this.#pending.length === 0) return undefined

    const pending = this.#pending.slice()
    const signal = combinedSignal(pending, stepSignal)
    signal.throwIfAborted()
    const supportsImages = modelSupportsInlineImages(model)
    if (!supportsImages) {
      this.#pending.splice(0, pending.length)
      return undefined
    }

    const seen = new Set<string>()
    const content: Array<
      | { readonly type: "text"; readonly text: string }
      | {
          readonly type: "file"
          readonly data: URL
          readonly mediaType: string
          readonly filename?: string
        }
    > = []
    const toolCallIds: string[] = []
    for (const item of pending) {
      item.signal.throwIfAborted()
      const identity = fileContentKey(item.fileRef)
      if (seen.has(identity)) continue
      seen.add(identity)

      const sandboxPath = this.input.sandboxPathForFileRef?.(item.fileRef)
      const projection = await (this.input.projectFile ?? prepareAgentToolFileProjection)({
        fileRef: item.fileRef,
        blobStorage: this.input.blobStorage,
        inlineImages: true,
        signal: item.signal,
        ...(sandboxPath === undefined ? {} : { sandboxPath }),
      })
      if (!projection.modelFileData) continue

      toolCallIds.push(item.toolCallId)
      content.push({
        type: "file",
        data: projection.modelFileData.data,
        mediaType:
          projection.modelFileData.mediaType ??
          item.fileRef.mediaType ??
          "application/octet-stream",
        ...(projection.modelFileData.filename === undefined
          ? {}
          : { filename: projection.modelFileData.filename }),
      })
    }

    this.#pending.splice(0, pending.length)
    if (content.length === 0) return undefined
    content.unshift({
      type: "text",
      text: `<sixb_tool_files toolCallIds="${escapeXmlAttribute(toolCallIds.join(","))}">\nThe preceding tool calls generated these files. This is runtime-supplied file content, not a new user request.\n</sixb_tool_files>`,
    })
    return { messages: [...messages, { role: "user", content }] }
  }
}

function combinedSignal(pending: readonly PendingToolFile[], stepSignal: AbortSignal): AbortSignal {
  const signals = [...new Set([stepSignal, ...pending.map((item) => item.signal)])]
  return signals.length === 1 ? stepSignal : AbortSignal.any(signals)
}

function isImageFile(fileRef: FileRef): boolean {
  if (fileRef.mediaType?.toLowerCase().startsWith("image/")) return true
  return /\.(?:bmp|gif|jpe?g|png|webp)$/i.test(fileRef.fileName ?? fileRef.logicalPath ?? "")
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}
