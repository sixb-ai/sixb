import type { FileRef, JsonValue } from "@sixb/core"
import type {
  AgentRunFileStore,
  PrepareModelStepInput,
  PrepareModelStepResult,
} from "@sixb/core/internal/agents"
import { agentMessageSteps, isAgentToolResult } from "@sixb/core/internal/agents"
import type { ModelFilePart, ModelMessage, ModelTextPart } from "@sixb/core/models"
import type { AgentMessageRecord } from "@sixb/core/storage"
import {
  type AttachmentImageOutcome,
  type AttachmentImageProjection,
  attachmentKey,
  modelSupportsInlineImages,
  type PendingAttachmentImage,
  type PreparedAgentAttachmentContext,
  prepareAgentToolFileProjection,
  settleAttachmentImages,
} from "../attachments"
import { fileContentKey } from "../file-ref"
import { type InlineImageBudget, projectInOrder } from "../inline-images"
import { type AgentToolModelOutput, agentToolResultToModelOutput } from "./result-output"

const TOOL_RESULT_IMAGE_OMISSION_NOTE =
  "[Image is not embedded in the tool-result message; Sixb supplies it as a separate model input when the selected model supports images.]"

/** Whether the images a tool's results return reach the model after its step. */
export type SuppliesToolFiles = (toolName: string) => boolean

/** An image a step's tool returned, not projected yet. */
interface ToolFileCandidate {
  readonly toolCallId: string
  readonly fileRef: FileRef
}

/** One tool call's durable result, as the step that ran it produced it. */
interface StepToolResult {
  readonly toolCallId: string
  readonly toolName: string
  readonly output: JsonValue | undefined
}

interface ToolFileProjectionInput {
  readonly blobStorage: AgentRunFileStore
  readonly signal: AbortSignal
  /** Test seam; production uses the bounded attachment projector. */
  readonly projectFile?: typeof prepareAgentToolFileProjection
}

/** What became of a step's image: inline, left out by the budget, or no image to project. */
type ToolFileDecision =
  | { readonly kind: "inline"; readonly toolCallId: string; readonly file: ModelFilePart }
  | { readonly kind: "budget"; readonly toolCallId: string; readonly name: string }
  | { readonly kind: "none" }

/**
 * Move tool-created images into a user message after their step without changing their durable
 * result. The message is derived from the step's results alone, so a later turn derives the same
 * one from the stored trace ({@link replayToolFiles}) and its request keeps the prefix. Its images
 * take what the request's inline image budget has left, after the history's.
 */
export class AgentToolResultMediaBridge {
  constructor(
    private readonly input: Omit<ToolFileProjectionInput, "signal"> & {
      readonly suppliesToolFiles: SuppliesToolFiles
      readonly inlineImages: InlineImageBudget
      readonly sandboxPathForFileRef?: (
        fileRef: FileRef
      ) => string | undefined | Promise<string | undefined>
    }
  ) {}

  async toModelOutput(input: {
    readonly output: JsonValue
    readonly signal: AbortSignal
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
    if (stepIndex === 0 || results?.role !== "tool" || !modelSupportsInlineImages(model)) {
      return undefined
    }

    signal.throwIfAborted()
    const candidates = toolFileCandidates(
      results.content.map((part) => ({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output:
          part.originalOutput ??
          (part.output.type === "text" || part.output.type === "json"
            ? part.output.value
            : undefined),
      })),
      this.input.suppliesToolFiles
    )

    const decisions: ToolFileDecision[] = []
    await projectInOrder({
      items: candidates,
      budget: this.input.inlineImages,
      project: (candidate) => projectToolFile(candidate, { ...this.input, signal }),
      decide: (candidate, file) =>
        decisions.push(decideToolFile(candidate, file, this.input.inlineImages)),
    })

    const message = toolFilesMessage(decisions)
    return message ? { messages: [...messages, message] } : undefined
  }
}

/** The key of a stored step's tool-files message: its message and its first local tool call. */
export function toolFilesStepKey(messageId: string, partIndex: number): string {
  return `${messageId}:${partIndex}`
}

/**
 * The images each stored step's tools returned, by {@link toolFilesStepKey}, not projected yet:
 * {@link allocateInlineImages} projects them as far as the request's budget goes.
 */
export function replayToolFiles(input: {
  readonly messages: readonly AgentMessageRecord[]
  readonly suppliesToolFiles: SuppliesToolFiles
  readonly supportsImages: boolean
}): ReadonlyMap<string, readonly ToolFileCandidate[]> {
  const replayed = new Map<string, readonly ToolFileCandidate[]>()
  if (!input.supportsImages) return replayed

  for (const message of input.messages) {
    if (message.role !== "assistant") continue

    for (const step of agentMessageSteps(message)) {
      const first = step.localToolCalls[0]
      if (!first) continue

      const candidates = toolFileCandidates(
        step.localToolCalls.map(({ part }) => ({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.state === "output-available" ? part.output : undefined,
        })),
        input.suppliesToolFiles
      )
      if (candidates.length > 0) {
        replayed.set(toolFilesStepKey(message.id, first.partIndex), candidates)
      }
    }
  }
  return replayed
}

/**
 * Spend the request's inline image budget on the history, in thread order, oldest first: each user
 * message's attachments, then the images after each step of the turn that answered it. Images are
 * projected only while the budget is open, a few at a time; what does not fit reads as metadata.
 * The run's own steps then take what is left, in the order a later replay walks them, so every
 * turn takes the same decisions. Images are never stored: their bytes are projected again from
 * their blobs, which is deterministic.
 */
export async function allocateInlineImages(
  input: ToolFileProjectionInput & {
    readonly messages: readonly AgentMessageRecord[]
    readonly attachments: PreparedAgentAttachmentContext
    readonly toolFiles: ReadonlyMap<string, readonly ToolFileCandidate[]>
    readonly budget: InlineImageBudget
  }
): Promise<PreparedAgentAttachmentContext> {
  const { attachments, budget } = input
  type Item =
    | { readonly kind: "attachment"; readonly key: string; readonly image: PendingAttachmentImage }
    | { readonly kind: "tool"; readonly step: string; readonly candidate: ToolFileCandidate }

  const items: Item[] = []
  for (const message of input.messages) {
    if (message.role === "user") {
      message.parts.forEach((_part, partIndex) => {
        const key = attachmentKey(message.id, partIndex)
        const image = attachments.pendingImages?.get(key)
        if (image) items.push({ kind: "attachment", key, image })
      })
      continue
    }

    for (const step of agentMessageSteps(message)) {
      const first = step.localToolCalls[0]
      if (!first) continue

      const key = toolFilesStepKey(message.id, first.partIndex)
      for (const candidate of input.toolFiles.get(key) ?? []) {
        items.push({ kind: "tool", step: key, candidate })
      }
    }
  }

  const outcomes = new Map<string, AttachmentImageOutcome>()
  const decisionsByStep = new Map<string, ToolFileDecision[]>()
  await projectInOrder({
    items,
    budget,
    project: async (item) =>
      item.kind === "attachment"
        ? { attachment: await item.image.project(input.signal) }
        : { tool: await projectToolFile(item.candidate, input) },
    decide: (item, projected) => {
      if (item.kind === "attachment") {
        outcomes.set(item.key, decideAttachment(projected?.attachment, budget))
        return
      }

      const decisions = decisionsByStep.get(item.step) ?? []
      decisions.push(decideToolFile(item.candidate, projected?.tool, budget))
      decisionsByStep.set(item.step, decisions)
    },
  })

  const toolFilesByStep = new Map<string, ModelMessage>()
  for (const [step, decisions] of decisionsByStep) {
    const message = toolFilesMessage(decisions)
    if (message) toolFilesByStep.set(step, message)
  }
  return { ...settleAttachmentImages(attachments, outcomes), toolFilesByStep }
}

/** An attachment's image fate: inline while it fits, metadata once the budget closed. */
function decideAttachment(
  projection: AttachmentImageProjection | undefined,
  budget: InlineImageBudget
): AttachmentImageOutcome {
  // One projected ahead of the budget's closing reads as one never projected.
  if (budget.closed || !projection) return { kind: "budget" }
  if (projection.kind !== "inline") return projection
  return budget.take(projection.data.data) ? projection : { kind: "budget" }
}

/** A tool image's fate: inline while it fits, named once the budget closed. */
function decideToolFile(
  candidate: ToolFileCandidate,
  file: ModelFilePart | undefined,
  budget: InlineImageBudget
): ToolFileDecision {
  const name = candidate.fileRef.fileName ?? "image"
  if (budget.closed) return { kind: "budget", toolCallId: candidate.toolCallId, name }
  if (!file) return { kind: "none" }
  return budget.take(file.data)
    ? { kind: "inline", toolCallId: candidate.toolCallId, file }
    : { kind: "budget", toolCallId: candidate.toolCallId, name }
}

/** The image files a step's results returned, once each, in the order of the step's calls. */
function toolFileCandidates(
  results: readonly StepToolResult[],
  suppliesToolFiles: SuppliesToolFiles
): ToolFileCandidate[] {
  const seen = new Set<string>()
  const candidates: ToolFileCandidate[] = []
  for (const result of results) {
    if (!suppliesToolFiles(result.toolName) || !isAgentToolResult(result.output)) continue

    for (const contentPart of result.output.content) {
      if (contentPart.type !== "file" || !isImageFile(contentPart.fileRef)) continue

      const identity = fileContentKey(contentPart.fileRef)
      if (seen.has(identity)) continue
      seen.add(identity)
      candidates.push({ toolCallId: result.toolCallId, fileRef: contentPart.fileRef })
    }
  }
  return candidates
}

/** A tool image as the model reads it, or nothing when it cannot be projected. */
async function projectToolFile(
  candidate: ToolFileCandidate,
  input: ToolFileProjectionInput
): Promise<ModelFilePart | undefined> {
  input.signal.throwIfAborted()
  const projection = await (input.projectFile ?? prepareAgentToolFileProjection)({
    fileRef: candidate.fileRef,
    blobStorage: input.blobStorage,
    inlineImages: true,
    signal: input.signal,
  })
  const data = projection.modelFileData
  if (!data) return undefined

  return {
    type: "file",
    data: data.data,
    mediaType: data.mediaType ?? candidate.fileRef.mediaType ?? "application/octet-stream",
    ...(data.filename === undefined ? {} : { filename: data.filename }),
  }
}

/**
 * The user message after a step with the images its tools returned, after a note that they are
 * runtime input. An image past the inline image budget is named instead.
 */
function toolFilesMessage(decisions: readonly ToolFileDecision[]): ModelMessage | undefined {
  const images = decisions.filter((decision) => decision.kind !== "none")
  if (images.length === 0) return undefined

  const toolCallIds = [...new Set(images.map((image) => image.toolCallId))]
  const files = images.flatMap((image) => (image.kind === "inline" ? [image.file] : []))
  const leftOut = images.flatMap((image) => (image.kind === "budget" ? [image.name] : []))

  const note: ModelTextPart = {
    type: "text",
    text: `<sixb_tool_files toolCallIds="${escapeXmlAttribute(toolCallIds.join(","))}">\nThe preceding tool calls generated these files. This is runtime-supplied file content, not a new user request.\n</sixb_tool_files>`,
  }
  const budgetNote: ModelTextPart[] =
    leftOut.length === 0
      ? []
      : [
          {
            type: "text",
            text: `[Images not inlined: ${leftOut.join(", ")}. The conversation's inline image budget is used up until it is compacted; each file is at the sandbox path its tool result names.]`,
          },
        ]
  return { role: "user", content: [note, ...files, ...budgetNote] }
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
