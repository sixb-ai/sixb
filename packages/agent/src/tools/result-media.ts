import type { FileRef, JsonValue } from "@sixb/core"
import type {
  AgentRunFileStore,
  PrepareModelStepInput,
  PrepareModelStepResult,
} from "@sixb/core/internal/agents"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import type { ModelFilePart, ModelMessage, ModelTextPart } from "@sixb/core/models"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { modelSupportsInlineImages, prepareAgentToolFileProjection } from "../attachments"
import { fileContentKey } from "../file-ref"
import { type AgentToolModelOutput, agentToolResultToModelOutput } from "./result-output"

const TOOL_RESULT_IMAGE_OMISSION_NOTE =
  "[Image is not embedded in the tool-result message; Sixb supplies it as a separate model input when the selected model supports images.]"

/** Whether the images a tool's results return reach the model after its step. */
export type SuppliesToolFiles = (toolName: string) => boolean

/** One tool call's durable result, as the step that ran it produced it. */
interface StepToolResult {
  readonly toolCallId: string
  readonly toolName: string
  readonly output: JsonValue | undefined
}

interface ToolFilesMessageInput {
  readonly blobStorage: AgentRunFileStore
  readonly suppliesToolFiles: SuppliesToolFiles
  readonly signal: AbortSignal
  /** Test seam; production uses the bounded attachment projector. */
  readonly projectFile?: typeof prepareAgentToolFileProjection
}

/**
 * Move tool-created images into a user message after their step without changing their durable
 * result. The message is derived from the step's results alone, so a later turn derives the same
 * one from the stored trace ({@link replayToolFileMessages}) and its request keeps the prefix.
 */
export class AgentToolResultMediaBridge {
  constructor(
    private readonly input: Omit<ToolFilesMessageInput, "signal"> & {
      readonly sandboxPathForFileRef?: (
        fileRef: FileRef
      ) => string | undefined | Promise<string | undefined>
    }
  ) {}

  async toModelOutput(input: {
    readonly output: JsonValue
    readonly signal: AbortSignal
    readonly toolCallId: string
  }): Promise<AgentToolModelOutput> {
    input.signal.throwIfAborted()
    return agentToolResultToModelOutput({
      output: input.output,
      blobStorage: this.input.blobStorage,
      signal: input.signal,
      ...(this.input.sandboxPathForFileRef === undefined
        ? {}
        : { sandboxPathForFileRef: this.input.sandboxPathForFileRef }),
      imageOmissionNote: TOOL_RESULT_IMAGE_OMISSION_NOTE,
    })
  }

  readonly prepareStep = async ({
    stepIndex,
    messages,
    model,
    signal,
  }: PrepareModelStepInput): Promise<PrepareModelStepResult | undefined> => {
    // Only after a step this loop ran: a replayed history holds its own steps' messages already,
    // and a retried request keeps the one it added.
    const results = messages.at(-1)
    if (stepIndex === 0 || results?.role !== "tool") return undefined

    signal.throwIfAborted()
    const message = await toolFilesMessage({
      ...this.input,
      signal,
      supportsImages: modelSupportsInlineImages(model),
      results: results.content.map((part) => ({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output:
          part.originalOutput ??
          (part.output.type === "text" || part.output.type === "json"
            ? part.output.value
            : undefined),
      })),
    })
    return message ? { messages: [...messages, message] } : undefined
  }
}

/** The key of a stored step's tool-files message: its message and its first local tool call. */
export function toolFilesStepKey(messageId: string, partIndex: number): string {
  return `${messageId}:${partIndex}`
}

/**
 * The `<sixb_tool_files>` message each stored step was followed by when it ran, derived again from
 * its results: same images, same projection, same order, by {@link toolFilesStepKey}. Images are
 * never stored; their bytes are projected again from their blobs, which is deterministic.
 */
export async function replayToolFileMessages(
  input: ToolFilesMessageInput & {
    readonly messages: readonly AgentMessageRecord[]
    readonly supportsImages: boolean
  }
): Promise<ReadonlyMap<string, ModelMessage>> {
  const replayed = new Map<string, ModelMessage>()
  if (!input.supportsImages) return replayed

  for (const message of input.messages) {
    if (message.role !== "assistant") continue

    for (const step of localToolCallsByStep(message)) {
      const first = step[0]
      if (!first) continue

      const toolFiles = await toolFilesMessage({
        ...input,
        results: step.map(({ part }) => ({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.state === "output-available" ? part.output : undefined,
        })),
      })
      if (toolFiles) replayed.set(toolFilesStepKey(message.id, first.partIndex), toolFiles)
    }
  }
  return replayed
}

/** A message's local tool calls, one list per step, as `toModelMessages` groups them. */
function localToolCallsByStep(message: AgentMessageRecord) {
  type ToolCall = Extract<AgentMessageRecord["parts"][number], { readonly type: "tool-call" }>
  const steps: { readonly part: ToolCall; readonly partIndex: number }[][] = [[]]
  message.parts.forEach((part, partIndex) => {
    if (part.type === "step-start") steps.push([])
    if (part.type === "tool-call" && part.providerExecuted !== true) {
      steps.at(-1)?.push({ part, partIndex })
    }
  })
  return steps
}

/**
 * The images a step's results returned, once each, in the order of the step's calls, after a note
 * that they are runtime input. Nothing when the model reads no images, or none could be projected.
 */
async function toolFilesMessage(
  input: ToolFilesMessageInput & {
    readonly results: readonly StepToolResult[]
    readonly supportsImages: boolean
  }
): Promise<ModelMessage | undefined> {
  if (!input.supportsImages) return undefined

  const seen = new Set<string>()
  const toolCallIds: string[] = []
  const files: ModelFilePart[] = []
  for (const result of input.results) {
    if (!input.suppliesToolFiles(result.toolName) || !isAgentToolResult(result.output)) continue

    for (const contentPart of result.output.content) {
      if (contentPart.type !== "file" || !isImageFile(contentPart.fileRef)) continue

      const identity = fileContentKey(contentPart.fileRef)
      if (seen.has(identity)) continue
      seen.add(identity)

      input.signal.throwIfAborted()
      const projection = await (input.projectFile ?? prepareAgentToolFileProjection)({
        fileRef: contentPart.fileRef,
        blobStorage: input.blobStorage,
        inlineImages: true,
        signal: input.signal,
      })
      if (!projection.modelFileData) continue

      if (!toolCallIds.includes(result.toolCallId)) toolCallIds.push(result.toolCallId)
      files.push({
        type: "file",
        data: projection.modelFileData.data,
        mediaType:
          projection.modelFileData.mediaType ??
          contentPart.fileRef.mediaType ??
          "application/octet-stream",
        ...(projection.modelFileData.filename === undefined
          ? {}
          : { filename: projection.modelFileData.filename }),
      })
    }
  }

  if (files.length === 0) return undefined

  const note: ModelTextPart = {
    type: "text",
    text: `<sixb_tool_files toolCallIds="${escapeXmlAttribute(toolCallIds.join(","))}">\nThe preceding tool calls generated these files. This is runtime-supplied file content, not a new user request.\n</sixb_tool_files>`,
  }
  return { role: "user", content: [note, ...files] }
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
